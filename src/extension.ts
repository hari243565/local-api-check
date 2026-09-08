import * as vscode from 'vscode';
import { ApiCodeLensProvider, type RequestRef } from './codeLens';
import { EnvironmentManager } from './environment';
import { SecretGuard } from './secretGuard';
import type { SecretFinding } from './secrets';
import { ApiTreeDataProvider, revealRequest, type RequestNode } from './treeView';
import {
  resolveRequest,
  runCheck,
  runChecksInFile,
  runChecksInWorkspace,
  sendAndReport
} from './runner';

/**
 * Send/check commands are invoked from a CodeLens (with a RequestRef) and from
 * the sidebar's inline buttons (with the tree node itself).
 */
function toRef(arg: RequestRef | RequestNode): RequestRef {
  return 'ref' in arg ? arg.ref : arg;
}

/** The .api document the user is looking at, if any. */
async function activeApiDocument(): Promise<vscode.TextDocument | undefined> {
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

export function activate(context: vscode.ExtensionContext): void {
  const environments = new EnvironmentManager(context);
  const codeLensProvider = new ApiCodeLensProvider();
  const secretGuard = new SecretGuard(environments);
  const tree = new ApiTreeDataProvider();

  context.subscriptions.push(
    environments,
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
      async (arg: RequestRef | RequestNode) => {
        const resolved = await resolveRequest(toRef(arg));
        if (!resolved) {
          void vscode.window.showWarningMessage('Local API Check: could not find that request.');
          return;
        }
        await sendAndReport(resolved.document, resolved.block, getChannel(), environments);
      }
    ),
    vscode.commands.registerCommand('localApiCheck.runCheck', async (arg: RequestRef | RequestNode) => {
      const resolved = await resolveRequest(toRef(arg));
      if (!resolved) {
        void vscode.window.showWarningMessage('Local API Check: could not find that request.');
        return;
      }
      const channel = getChannel();
      channel.show(true);
      channel.appendLine('');
      await runCheck(resolved.document, resolved.block, channel, environments);
    }),
    vscode.commands.registerCommand('localApiCheck.runAllChecksInFile', async () => {
      const document = await activeApiDocument();
      if (!document) {
        void vscode.window.showWarningMessage(
          'Local API Check: open a .api file to run its checks.'
        );
        return;
      }
      await runChecksInFile(document, getChannel(), environments);
    }),
    vscode.commands.registerCommand('localApiCheck.runAllChecksInWorkspace', () =>
      runChecksInWorkspace(getChannel(), environments)
    ),
    vscode.commands.registerCommand('localApiCheck.revealRequest', (ref: RequestRef) =>
      revealRequest(ref)
    ),
    vscode.commands.registerCommand('localApiCheck.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('localApiCheck.selectEnvironment', () =>
      environments.promptToSelect()
    ),
    vscode.commands.registerCommand(
      'localApiCheck.extractSecret',
      async (args: { uri: string; finding: SecretFinding }) => {
        await secretGuard.extract(vscode.Uri.parse(args.uri), args.finding);
      }
    ),
    vscode.commands.registerCommand('localApiCheck.showOutput', () => {
      getChannel().show(true);
    })
  );

  void environments.scaffoldEnvFolder();
  void environments.updateStatusBar();
}

export function deactivate(): void {
  channel?.dispose();
  channel = undefined;
}
