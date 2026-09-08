import * as vscode from 'vscode';
import { envNameFromFile, isLocalOnlyEnv, normalizeEnvValues, type EnvVars } from './env';
import { pickVariableName } from './secrets';

export const ENV_FOLDER = '.api-env';
const ACTIVE_ENV_KEY = 'localApiCheck.activeEnvironment';

const SAMPLE_ENV = `{
  "_comment": "Variables for the 'local' environment. Use them as {{base_url}} in .api files.",
  "base_url": "http://localhost:3000",
  "auth_token": "replace-me"
}
`;

const ENV_GITIGNORE = `# Environment files ending in .local.json hold real secrets and stay out of git.
# Shared, non-secret environments (staging.json, local.json) are committed normally.
*.local.json
`;

export interface ResolvedEnvironment {
  /** Active environment name, or undefined when the project has none. */
  name?: string;
  vars: EnvVars;
  /** Non-fatal problems with the env file, surfaced in the output channel. */
  issues: string[];
}

const EMPTY: ResolvedEnvironment = { vars: {}, issues: [] };

/**
 * Discovers `.api-env/*.json` files, tracks which one is active, and keeps a
 * status-bar item in sync. Everything is read from disk on demand and cached
 * until a file watcher says otherwise — no background polling.
 */
export class EnvironmentManager implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, ResolvedEnvironment>();
  private readonly changed = new vscode.EventEmitter<void>();

  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'localApiCheck.selectEnvironment';

    this.watcher = vscode.workspace.createFileSystemWatcher(`**/${ENV_FOLDER}/*.json`);
    const invalidate = (): void => {
      this.cache.clear();
      void this.updateStatusBar();
      this.changed.fire();
    };
    this.disposables.push(
      this.watcher.onDidCreate(invalidate),
      this.watcher.onDidChange(invalidate),
      this.watcher.onDidDelete(invalidate),
      vscode.window.onDidChangeActiveTextEditor(() => void this.updateStatusBar()),
      vscode.workspace.onDidChangeWorkspaceFolders(invalidate)
    );
  }

  dispose(): void {
    this.statusBar.dispose();
    this.watcher.dispose();
    this.changed.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  get activeName(): string | undefined {
    return this.context.workspaceState.get<string>(ACTIVE_ENV_KEY);
  }

  private async setActiveName(name: string | undefined): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_ENV_KEY, name);
    this.cache.clear();
    await this.updateStatusBar();
    this.changed.fire();
  }

  /** Every environment name found across the workspace, sorted. */
  async listEnvironmentNames(): Promise<string[]> {
    const names = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const file of await this.listEnvFiles(folder)) {
        names.add(envNameFromFile(file));
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  private async listEnvFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
    const dir = vscode.Uri.joinPath(folder.uri, ENV_FOLDER);
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && /\.json$/i.test(name))
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  /**
   * Resolves the active environment for a resource. In a multi-root workspace
   * the variables come from the folder that owns the file being run.
   */
  async resolve(resource?: vscode.Uri): Promise<ResolvedEnvironment> {
    const folder = this.folderFor(resource);
    if (!folder) {
      return EMPTY;
    }

    const name = this.activeName ?? (await this.defaultEnvironmentName());
    if (!name) {
      return EMPTY;
    }

    const key = `${folder.uri.toString()}::${name}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const uri = vscode.Uri.joinPath(folder.uri, ENV_FOLDER, `${name}.json`);
    let resolved: ResolvedEnvironment;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const { vars, issues } = normalizeEnvValues(raw);
      resolved = { name, vars, issues };
    } catch (err) {
      const message =
        err instanceof SyntaxError
          ? `${ENV_FOLDER}/${name}.json is not valid JSON: ${err.message}`
          : `No ${ENV_FOLDER}/${name}.json in ${folder.name}.`;
      resolved = { name, vars: {}, issues: [message] };
    }

    this.cache.set(key, resolved);
    return resolved;
  }

  private folderFor(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (resource) {
      const owner = vscode.workspace.getWorkspaceFolder(resource);
      if (owner) {
        return owner;
      }
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  private async defaultEnvironmentName(): Promise<string | undefined> {
    const names = await this.listEnvironmentNames();
    if (names.length === 0) {
      return undefined;
    }
    return names.includes('local') ? 'local' : names[0];
  }

  /** Quick pick to switch the active environment. */
  async promptToSelect(): Promise<void> {
    const names = await this.listEnvironmentNames();
    if (names.length === 0) {
      const create = 'Create .api-env';
      const answer = await vscode.window.showInformationMessage(
        `No environments found. Add JSON files to ${ENV_FOLDER}/ to define variables.`,
        create
      );
      if (answer === create) {
        await this.scaffoldEnvFolder(true);
      }
      return;
    }

    const active = this.activeName ?? (await this.defaultEnvironmentName());
    const picked = await vscode.window.showQuickPick(
      names.map((name) => ({
        label: name,
        description: [
          name === active ? 'active' : undefined,
          isLocalOnlyEnv(`${name}.json`) ? 'git-ignored' : undefined
        ]
          .filter(Boolean)
          .join(' · '),
        name
      })),
      { title: 'Local API Check: select environment', placeHolder: 'Environment' }
    );

    if (picked) {
      await this.setActiveName(picked.name);
    }
  }

  async updateStatusBar(): Promise<void> {
    const names = await this.listEnvironmentNames();
    const editor = vscode.window.activeTextEditor;
    const editingApiFile =
      editor?.document.languageId === 'local-api-check' ||
      editor?.document.uri.path.endsWith('.api') === true;

    if (names.length === 0 && !editingApiFile) {
      this.statusBar.hide();
      return;
    }

    const active = this.activeName ?? (await this.defaultEnvironmentName());
    this.statusBar.text = active ? `$(globe) Env: ${active}` : '$(globe) Env: none';
    this.statusBar.tooltip = active
      ? `Local API Check — variables from ${ENV_FOLDER}/${active}.json. Click to switch.`
      : `Local API Check — no environment files in ${ENV_FOLDER}/. Click to create one.`;
    this.statusBar.show();
  }

  /**
   * Adds a variable to the active environment file, creating the file (and
   * `.api-env/`) if needed. Existing content and key order are preserved.
   * Returns the name actually used — it may be suffixed to avoid clobbering a
   * different value already stored under the preferred name.
   */
  async writeVariable(
    resource: vscode.Uri | undefined,
    preferredName: string,
    value: string
  ): Promise<{ variableName: string; envName: string; uri: vscode.Uri } | undefined> {
    const folder = this.folderFor(resource);
    if (!folder) {
      return undefined;
    }

    const envName = this.activeName ?? (await this.defaultEnvironmentName()) ?? 'local';
    const dir = vscode.Uri.joinPath(folder.uri, ENV_FOLDER);
    const uri = vscode.Uri.joinPath(dir, `${envName}.json`);

    let raw: Record<string, unknown> = {};
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // New or unreadable file — start from an empty object rather than losing
      // the user's secret. An unparseable file is reported by resolve().
    }

    const { vars } = normalizeEnvValues(raw);
    const variableName = pickVariableName(preferredName, vars, value);
    raw[variableName] = value;

    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(`${JSON.stringify(raw, undefined, 2)}\n`)
    );

    this.cache.clear();
    await this.updateStatusBar();
    this.changed.fire();
    return { variableName, envName, uri };
  }

  /**
   * Creates `.api-env/` with a sample environment the first time the extension
   * sees a project without one. Never overwrites anything that exists.
   */
  async scaffoldEnvFolder(force = false): Promise<void> {
    if (!force) {
      const enabled = vscode.workspace
        .getConfiguration('localApiCheck')
        .get<boolean>('createEnvFolderOnActivate', true);
      if (!enabled) {
        return;
      }
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }

    const dir = vscode.Uri.joinPath(folder.uri, ENV_FOLDER);
    try {
      await vscode.workspace.fs.stat(dir);
      return; // Already there — leave it alone.
    } catch {
      // Does not exist yet.
    }

    const encoder = new TextEncoder();
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dir, 'local.json'),
      encoder.encode(SAMPLE_ENV)
    );
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dir, '.gitignore'),
      encoder.encode(ENV_GITIGNORE)
    );

    this.cache.clear();
    await this.updateStatusBar();
    this.changed.fire();

    const open = 'Open local.json';
    const answer = await vscode.window.showInformationMessage(
      `Local API Check created ${ENV_FOLDER}/local.json for your request variables. Files named *.local.json there are git-ignored.`,
      open
    );
    if (answer === open) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(dir, 'local.json')
      );
      await vscode.window.showTextDocument(doc);
    }
  }
}
