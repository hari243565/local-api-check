import * as vscode from 'vscode';
import type { RequestRef } from './codeLens';
import { parseApiFile, type RequestBlock } from './parser';
import { findApiFiles } from './runner';

export class ApiFileNode extends vscode.TreeItem {
  readonly kind = 'file';

  constructor(readonly uri: vscode.Uri, requestCount: number) {
    super(uri, vscode.TreeItemCollapsibleState.Expanded);
    this.label = basename(uri);
    this.description = `${requestCount} request${requestCount === 1 ? '' : 's'}`;
    this.tooltip = vscode.workspace.asRelativePath(uri);
    this.contextValue = 'localApiCheck.file';
    this.command = {
      title: 'Open',
      command: 'vscode.open',
      arguments: [uri]
    };
  }
}

export class RequestNode extends vscode.TreeItem {
  readonly kind = 'request';
  readonly ref: RequestRef;

  constructor(uri: vscode.Uri, block: RequestBlock) {
    super(block.name, vscode.TreeItemCollapsibleState.None);
    this.ref = { uri: uri.toString(), headerLine: block.headerLine };
    this.description = block.method.toUpperCase();
    this.tooltip = `${block.method.toUpperCase()} ${block.url}`;
    this.iconPath = new vscode.ThemeIcon(block.expect ? 'testing-unset-icon' : 'arrow-right');
    this.contextValue = block.expect ? 'localApiCheck.checkRequest' : 'localApiCheck.request';
    this.command = {
      title: 'Go to request',
      command: 'localApiCheck.revealRequest',
      arguments: [this.ref]
    };
  }
}

type Node = ApiFileNode | RequestNode;

/**
 * Sidebar listing every `.api` file in the workspace and the requests inside
 * it. Files are read on demand; unsaved edits in an open editor win over what
 * is on disk.
 */
export class ApiTreeDataProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.api');
    const refresh = (): void => this.refresh();
    this.disposables.push(
      this.watcher.onDidCreate(refresh),
      this.watcher.onDidChange(refresh),
      this.watcher.onDidDelete(refresh),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.path.endsWith('.api')) {
          refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(refresh)
    );
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      const uris = await findApiFiles();
      const nodes: ApiFileNode[] = [];
      for (const uri of uris) {
        const { requests } = parseApiFile(await readText(uri));
        nodes.push(new ApiFileNode(uri, requests.length));
      }
      return nodes;
    }

    if (element.kind === 'file') {
      const { requests } = parseApiFile(await readText(element.uri));
      return requests.map((block) => new RequestNode(element.uri, block));
    }

    return [];
  }
}

/** Opens the file and puts the cursor on the request's `###` line. */
export async function revealRequest(ref: RequestRef): Promise<void> {
  const uri = vscode.Uri.parse(ref.uri);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
  const position = new vscode.Position(Math.min(ref.headerLine, document.lineCount - 1), 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === uri.toString()
  );
  if (open) {
    return open.getText();
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return '';
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] || uri.path;
}
