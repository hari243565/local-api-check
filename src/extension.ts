import * as vscode from 'vscode';
import { ApiCodeLensProvider, type RequestRef } from './codeLens';
import { EnvironmentManager } from './environment';
import {
  resolveRequest,
  runCheck,
  runChecksInFile,
  runChecksInWorkspace,
  sendAndReport
} from './runner';

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

  context.subscriptions.push(
    environments,
    codeLensProvider,
    vscode.languages.registerCodeLensProvider(API_SELECTOR, codeLensProvider),
    environments.onDidChange(() => codeLensProvider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localApiCheck.sendRequest', async (ref: RequestRef) => {
      const resolved = await resolveRequest(ref);
      if (!resolved) {
        void vscode.window.showWarningMessage('Local API Check: could not find that request.');
        return;
      }
      await sendAndReport(resolved.document, resolved.block, getChannel(), environments);
    }),
    vscode.commands.registerCommand('localApiCheck.runCheck', async (ref: RequestRef) => {
      const resolved = await resolveRequest(ref);
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
    vscode.commands.registerCommand('localApiCheck.selectEnvironment', () =>
      environments.promptToSelect()
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
