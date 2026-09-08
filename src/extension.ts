import * as vscode from 'vscode';
import type { CheckResult } from './assert';
import { ApiCodeLensProvider, type RequestRef } from './codeLens';
import { EnvironmentManager } from './environment';
import { LicenseManager } from './license';
import { SecretGuard } from './secretGuard';
import type { SecretFinding } from './secrets';
import { ApiTreeDataProvider, revealRequest, type RequestNode } from './treeView';
import {
  resolveRequest,
  runCheck,
  runChecksInFile,
  runChecksInWorkspace,
  sendAndReport,
  type SendSummary
} from './runner';

/**
 * What `activate()` hands back. The integration suite drives the extension
 * through real commands wherever it can; this exists for the few things the
 * public API cannot reach from outside — chiefly the live TreeDataProvider.
 */
export interface LocalApiCheckApi {
  readonly environments: EnvironmentManager;
  readonly license: LicenseManager;
  readonly tree: ApiTreeDataProvider;
  readonly secretGuard: SecretGuard;
  readonly outputChannel: vscode.OutputChannel;
}

/**
 * Send/check commands are invoked from a CodeLens (with a RequestRef) and from
 * the sidebar's inline buttons (with the tree node itself).
 */
function toRef(arg: RequestRef | RequestNode): RequestRef {
  return 'ref' in arg ? arg.ref : arg;
}

/** The .api document the user is looking at, if any. */
function activeApiDocument(): vscode.TextDocument | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (!document) {
    return undefined;
  }
  const isApi =
    document.languageId === 'local-api-check' || document.uri.path.endsWith('.api');
  return isApi ? document : undefined;
}

export const API_SELECTOR: vscode.DocumentSelector = [
  { language: 'local-api-check' },
  { pattern: '**/*.api' }
];

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Local API Check');
  }
  return channel;
}

export function activate(context: vscode.ExtensionContext): LocalApiCheckApi {
  const environments = new EnvironmentManager(context);
  const license = new LicenseManager(context, (line) => getChannel().appendLine(line));
  const codeLensProvider = new ApiCodeLensProvider();
  const secretGuard = new SecretGuard(environments);
  const tree = new ApiTreeDataProvider();

  /**
   * The gate on the paid features. Free-tier behaviour never passes through
   * here: sending requests, environments and secret warnings do not ask.
   */
  const requirePro = async (feature: string): Promise<boolean> => {
    if (await license.isPro()) {
      return true;
    }
    // Deliberately not awaited: the notification resolves on a click that may
    // never come, and the command has to return either way.
    void license.showUpsell(feature);
    return false;
  };

  context.subscriptions.push(
    environments,
    license,
    codeLensProvider,
    secretGuard,
    tree,
    vscode.window.createTreeView('localApiCheck.requests', {
      treeDataProvider: tree,
      showCollapseAll: true
    }),
    vscode.languages.registerCodeLensProvider(API_SELECTOR, codeLensProvider),
    vscode.languages.registerCodeActionsProvider(API_SELECTOR, secretGuard, {
      providedCodeActionKinds: SecretGuard.providedCodeActionKinds
    }),
    environments.onDidChange(() => codeLensProvider.refresh())
  );

  // Scan whatever is already open, so the warning isn't gated on a save.
  for (const document of vscode.workspace.textDocuments) {
    secretGuard.scan(document);
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => secretGuard.scan(document))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'localApiCheck.sendRequest',
      async (arg: RequestRef | RequestNode): Promise<SendSummary | undefined> => {
        const resolved = await resolveRequest(toRef(arg));
        if (!resolved) {
          void vscode.window.showWarningMessage('Local API Check: could not find that request.');
          return undefined;
        }
        return sendAndReport(resolved.document, resolved.block, getChannel(), environments);
      }
    ),
    vscode.commands.registerCommand(
      'localApiCheck.runCheck',
      async (arg: RequestRef | RequestNode): Promise<CheckResult | undefined> => {
        if (!(await requirePro('Run Check'))) {
          return undefined;
        }
        const resolved = await resolveRequest(toRef(arg));
        if (!resolved) {
          void vscode.window.showWarningMessage('Local API Check: could not find that request.');
          return undefined;
        }
        const output = getChannel();
        output.show(true);
        output.appendLine('');
        return runCheck(resolved.document, resolved.block, output, environments);
      }
    ),
    vscode.commands.registerCommand(
      'localApiCheck.runAllChecksInFile',
      async (): Promise<CheckResult[] | undefined> => {
        if (!(await requirePro('Run All Checks in File'))) {
          return undefined;
        }
        const document = activeApiDocument();
        if (!document) {
          void vscode.window.showWarningMessage(
            'Local API Check: open a .api file to run its checks.'
          );
          return undefined;
        }
        return runChecksInFile(document, getChannel(), environments);
      }
    ),
    vscode.commands.registerCommand(
      'localApiCheck.runAllChecksInWorkspace',
      async (): Promise<CheckResult[] | undefined> =>
        (await requirePro('Run All Checks in Workspace'))
          ? runChecksInWorkspace(getChannel(), environments)
          : undefined
    ),
    vscode.commands.registerCommand('localApiCheck.revealRequest', (ref: RequestRef) =>
      revealRequest(ref)
    ),
    vscode.commands.registerCommand('localApiCheck.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand(
      'localApiCheck.selectEnvironment',
      // With a name, switches straight to it (handy for keybindings and tasks);
      // without one, opens the quick pick the status bar uses.
      (name?: string): Promise<boolean> =>
        typeof name === 'string' && name.length > 0
          ? environments.setEnvironment(name)
          : environments.promptToSelect()
    ),
    vscode.commands.registerCommand(
      'localApiCheck.extractSecret',
      async (args: { uri: string; finding: SecretFinding }) => {
        await secretGuard.extract(vscode.Uri.parse(args.uri), args.finding);
      }
    ),
    vscode.commands.registerCommand('localApiCheck.showOutput', () => {
      getChannel().show(true);
    }),
    // Passing the key directly is what a keybinding, a task, or the test suite
    // uses; with no argument it opens the input box.
    vscode.commands.registerCommand('localApiCheck.enterLicenseKey', (key?: string) =>
      license.enterKey(key)
    ),
    vscode.commands.registerCommand('localApiCheck.licenseStatus', () => license.showStatus()),
    vscode.commands.registerCommand('localApiCheck.removeLicense', () => license.removeKey())
  );

  void environments.scaffoldEnvFolder();
  void environments.updateStatusBar();
  // Never awaited: an unreachable licence server must not delay activation,
  // and this does nothing at all when no key is stored.
  void license.refreshIfStale();

  return { environments, license, tree, secretGuard, outputChannel: getChannel() };
}

export function deactivate(): void {
  channel?.dispose();
  channel = undefined;
}
