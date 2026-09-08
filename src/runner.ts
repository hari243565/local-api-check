import * as vscode from 'vscode';
import type { RequestRef } from './codeLens';
import type { EnvironmentManager, ResolvedEnvironment } from './environment';
import { prepareWithEnv } from './env';
import { formatRequestHeading, formatResponse } from './format';
import { DEFAULT_TIMEOUT_MS, sendHttpRequest, type HttpResponse, type PreparedRequest } from './http';
import { parseApiFile, type RequestBlock } from './parser';

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

export interface ExecutedRequest {
  request: PreparedRequest;
  response: HttpResponse;
  unresolved: string[];
}

/**
 * Substitutes the active environment into a block and sends it. Shared by the
 * "Send Request" action and the check runner.
 */
export async function executeBlock(
  block: RequestBlock,
  environment: ResolvedEnvironment
): Promise<ExecutedRequest> {
  const { request, unresolved } = prepareWithEnv(block, environment.vars);
  const response = await sendHttpRequest(request, getTimeoutMs());
  return { request, response, unresolved };
}

/** Lines warning about anything that will make the request misbehave. */
export function warningLines(block: RequestBlock, unresolved: string[], environment: ResolvedEnvironment): string[] {
  const lines: string[] = [];
  for (const issue of block.issues) {
    lines.push(`! line ${issue.line + 1}: ${issue.message}`);
  }
  for (const issue of environment.issues) {
    lines.push(`! ${issue}`);
  }
  if (unresolved.length > 0) {
    const names = unresolved.map((n) => `{{${n}}}`).join(', ');
    const where = environment.name ? `environment "${environment.name}"` : 'any environment';
    lines.push(`! Unresolved ${unresolved.length === 1 ? 'variable' : 'variables'} ${names} — not defined in ${where}.`);
  }
  return lines;
}

/**
 * Sends one request and writes the full response to the output channel.
 */
export async function sendAndReport(
  document: vscode.TextDocument,
  block: RequestBlock,
  channel: vscode.OutputChannel,
  environments: EnvironmentManager
): Promise<void> {
  const environment = await environments.resolve(document.uri);
  const { request, unresolved } = prepareWithEnv(block, environment.vars);

  channel.show(true);
  for (const line of formatRequestHeading(request, environment.name)) {
    channel.appendLine(line);
  }
  for (const line of warningLines(block, unresolved, environment)) {
    channel.appendLine(line);
  }

  const response = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Sending ${request.name}…` },
    () => sendHttpRequest(request, getTimeoutMs())
  );

  for (const line of formatResponse(response)) {
    channel.appendLine(line);
  }

  if (!response.completed) {
    void vscode.window.showErrorMessage(
      `Local API Check: ${request.name} failed — ${response.error ?? 'unknown error'}`
    );
  }
}
