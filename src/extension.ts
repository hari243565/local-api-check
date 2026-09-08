import * as vscode from 'vscode';
import { ApiCodeLensProvider, type RequestRef } from './codeLens';
import { resolveRequest, sendAndReport } from './runner';

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
  const codeLensProvider = new ApiCodeLensProvider();
  context.subscriptions.push(
    codeLensProvider,
    vscode.languages.registerCodeLensProvider(API_SELECTOR, codeLensProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localApiCheck.sendRequest', async (ref: RequestRef) => {
      const resolved = await resolveRequest(ref);
      if (!resolved) {
        void vscode.window.showWarningMessage('Local API Check: could not find that request.');
        return;
      }
      await sendAndReport(resolved.block, getChannel());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localApiCheck.showOutput', () => {
      getChannel().show(true);
    })
  );
}

export function deactivate(): void {
  channel?.dispose();
  channel = undefined;
}
