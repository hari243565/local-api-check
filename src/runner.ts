import * as vscode from 'vscode';
import { formatRequestHeading, formatResponse } from './format';
import { DEFAULT_TIMEOUT_MS, sendHttpRequest, type PreparedRequest } from './http';
import { parseApiFile, type RequestBlock } from './parser';
import type { RequestRef } from './codeLens';

/** Turns a parsed block into something `sendHttpRequest` can execute. */
export function prepareRequest(block: RequestBlock): PreparedRequest {
  return {
    name: block.name,
    method: block.method,
    url: block.url,
    headers: block.headers.map((h) => ({ name: h.name, value: h.value })),
    body: block.body
  };
}

/** Re-reads the document and locates the block the CodeLens was attached to. */
export async function resolveRequest(
  ref: RequestRef
): Promise<{ document: vscode.TextDocument; block: RequestBlock } | undefined> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(ref.uri));
  const { requests } = parseApiFile(document.getText());
  const block =
    requests.find((r) => r.headerLine === ref.headerLine) ??
    // The document may have shifted since the lens was drawn; fall back to the
    // nearest block at or above the remembered line.
    requests.filter((r) => r.headerLine <= ref.headerLine).pop();
  if (!block) {
    return undefined;
  }
  return { document, block };
}

export function getTimeoutMs(): number {
  const configured = vscode.workspace
    .getConfiguration('localApiCheck')
    .get<number>('requestTimeoutMs');
  return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

/**
 * Sends one request and writes the full response to the output channel.
 */
export async function sendAndReport(
  block: RequestBlock,
  channel: vscode.OutputChannel
): Promise<void> {
  const prepared = prepareRequest(block);

  channel.show(true);
  for (const line of formatRequestHeading(prepared)) {
    channel.appendLine(line);
  }

  for (const issue of block.issues) {
    channel.appendLine(`! line ${issue.line + 1}: ${issue.message}`);
  }

  const response = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Sending ${prepared.name}…` },
    () => sendHttpRequest(prepared, getTimeoutMs())
  );

  for (const line of formatResponse(response)) {
    channel.appendLine(line);
  }

  if (!response.completed) {
    void vscode.window.showErrorMessage(
      `Local API Check: ${prepared.name} failed — ${response.error ?? 'unknown error'}`
    );
  }
}
