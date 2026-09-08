import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('localApiCheck.helloWorld', () => {
      void vscode.window.showInformationMessage('Local API Check is alive.');
    })
  );
}

export function deactivate(): void {
  // nothing to clean up yet
}
