import * as vscode from 'vscode';
import type { EnvironmentManager } from './environment';
import { isLocalOnlyEnv } from './env';
import { scanForSecrets, type SecretFinding } from './secrets';

const DIAGNOSTIC_SOURCE = 'Local API Check';
const DIAGNOSTIC_CODE = 'hardcoded-secret';

/** Command arguments for the quick fix. */
interface ExtractArgs {
  uri: string;
  finding: SecretFinding;
}

/**
 * Watches `.api` files for credentials pasted in where a `{{variable}}` belongs.
 * Warnings only — nothing here ever blocks a save or a request.
 */
export class SecretGuard implements vscode.CodeActionProvider, vscode.Disposable {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  /** Files already warned about this session, so saving repeatedly is quiet. */
  private readonly notified = new Set<string>();

  constructor(private readonly environments: EnvironmentManager) {
    this.diagnostics = vscode.languages.createDiagnosticCollection('localApiCheck.secrets');

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => void this.onSave(document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.diagnostics.delete(document.uri);
        this.notified.delete(document.uri.toString());
      })
    );
  }

  dispose(): void {
    this.diagnostics.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('localApiCheck')
      .get<boolean>('warnOnHardcodedSecrets', true);
  }

  private isApiDocument(document: vscode.TextDocument): boolean {
    return (
      document.languageId === 'local-api-check' || document.uri.path.endsWith('.api')
    );
  }

  /** Re-scans an open document and refreshes its diagnostics. */
  scan(document: vscode.TextDocument): SecretFinding[] {
    if (!this.isApiDocument(document)) {
      return [];
    }
    if (!this.isEnabled()) {
      this.diagnostics.delete(document.uri);
      return [];
    }

    const findings = scanForSecrets(document.getText());
    this.diagnostics.set(
      document.uri,
      findings.map((finding) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            finding.line,
            finding.startColumn,
            finding.line,
            finding.endColumn
          ),
          `This looks like a hardcoded secret (${finding.kind}) — consider using an environment variable instead.`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        diagnostic.code = DIAGNOSTIC_CODE;
        return diagnostic;
      })
    );
    return findings;
  }

  private async onSave(document: vscode.TextDocument): Promise<void> {
    const findings = this.scan(document);
    if (findings.length === 0) {
      this.notified.delete(document.uri.toString());
      return;
    }
    if (this.notified.has(document.uri.toString())) {
      return; // Diagnostics stay; don't nag on every save.
    }
    this.notified.add(document.uri.toString());

    const extract = 'Extract to environment';
    const stop = "Don't warn again";
    const answer = await vscode.window.showWarningMessage(
      findings.length === 1
        ? `This looks like a hardcoded secret — consider using an environment variable instead (${findings[0].kind}, line ${findings[0].line + 1}).`
        : `${findings.length} values in this file look like hardcoded secrets — consider using environment variables instead.`,
      extract,
      stop
    );

    if (answer === extract) {
      for (const finding of findings) {
        await this.extract(document.uri, finding);
      }
    } else if (answer === stop) {
      await vscode.workspace
        .getConfiguration('localApiCheck')
        .update('warnOnHardcodedSecrets', false, vscode.ConfigurationTarget.Workspace);
      this.diagnostics.clear();
    }
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const relevant = context.diagnostics.filter(
      (d) => d.source === DIAGNOSTIC_SOURCE && d.code === DIAGNOSTIC_CODE
    );
    if (relevant.length === 0) {
      return [];
    }

    const findings = scanForSecrets(document.getText());
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of relevant) {
      const finding = findings.find(
        (f) =>
          f.line === diagnostic.range.start.line &&
          f.startColumn === diagnostic.range.start.character
      );
      if (!finding || !range.intersection(diagnostic.range)) {
        continue;
      }
      const action = new vscode.CodeAction(
        `Extract to {{${finding.suggestedName}}} in the active environment`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      const args: ExtractArgs = { uri: document.uri.toString(), finding };
      action.command = {
        title: 'Extract secret to environment',
        command: 'localApiCheck.extractSecret',
        arguments: [args]
      };
      actions.push(action);
    }

    return actions;
  }

  /**
   * Moves the literal into the active environment file and replaces it in the
   * document with `{{name}}`.
   */
  async extract(uri: vscode.Uri, finding: SecretFinding): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(
      finding.line,
      finding.startColumn,
      finding.line,
      finding.endColumn
    );

    // Refuse to edit if the text moved since the scan — better to do nothing
    // than to mangle the file.
    if (document.getText(range) !== finding.value) {
      void vscode.window.showWarningMessage(
        'Local API Check: the file changed since that secret was found. Save again to re-scan.'
      );
      return;
    }

    const written = await this.environments.writeVariable(
      uri,
      finding.suggestedName,
      finding.value
    );
    if (!written) {
      void vscode.window.showWarningMessage(
        'Local API Check: open a folder or workspace to store environment variables.'
      );
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, `{{${written.variableName}}}`);
    await vscode.workspace.applyEdit(edit);

    this.scan(document);

    const gitNote = isLocalOnlyEnv(`${written.envName}.json`)
      ? 'That file is git-ignored.'
      : `Rename it to ${written.envName}.local.json if it should stay out of git.`;
    void vscode.window.showInformationMessage(
      `Saved {{${written.variableName}}} to .api-env/${written.envName}.json. ${gitNote}`
    );
  }
}
