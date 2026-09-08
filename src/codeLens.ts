import * as vscode from 'vscode';
import { parseApiFile } from './parser';

/** Arguments passed to the send/check commands by the CodeLens actions. */
export interface RequestRef {
  uri: string;
  headerLine: number;
}

/**
 * One "▶ Send Request" lens above every `### <name>` block.
 */
export class ApiCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const { requests } = parseApiFile(document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (const request of requests) {
      const range = new vscode.Range(request.headerLine, 0, request.headerLine, 0);
      const ref: RequestRef = { uri: document.uri.toString(), headerLine: request.headerLine };

      lenses.push(
        new vscode.CodeLens(range, {
          title: '▶ Send Request',
          command: 'localApiCheck.sendRequest',
          tooltip: `Send ${request.method} ${request.url}`,
          arguments: [ref]
        })
      );
    }

    return lenses;
  }
}
