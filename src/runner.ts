import * as vscode from 'vscode';
import {
  evaluateExpectations,
  formatCheckResult,
  formatSummary,
  summaryText,
  type CheckResult
} from './assert';
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

/** What the send-request command hands back to its caller. */
export interface SendSummary {
  name: string;
  method: string;
  /** URL after variable substitution — what was actually requested. */
  url: string;
  headers: Array<{ name: string; value: string }>;
  completed: boolean;
  status: number;
  bodyText: string;
  durationMs: number;
  unresolved: string[];
  environment?: string;
  error?: string;
}

/**
 * Sends one request and writes the full response to the output channel.
 */
export async function sendAndReport(
  document: vscode.TextDocument,
  block: RequestBlock,
  channel: vscode.OutputChannel,
  environments: EnvironmentManager
): Promise<SendSummary> {
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

  return {
    name: request.name,
    method: request.method.toUpperCase(),
    url: request.url,
    headers: request.headers,
    completed: response.completed,
    status: response.status,
    bodyText: response.bodyText,
    durationMs: response.durationMs,
    unresolved,
    environment: environment.name,
    error: response.error
  };
}

/**
 * Runs one block against its `expect:` block and prints a pass/fail line.
 */
export async function runCheck(
  document: vscode.TextDocument,
  block: RequestBlock,
  channel: vscode.OutputChannel,
  environments: EnvironmentManager
): Promise<CheckResult> {
  const environment = await environments.resolve(document.uri);
  const { request, unresolved } = prepareWithEnv(block, environment.vars);

  for (const line of warningLines(block, unresolved, environment)) {
    channel.appendLine(line);
  }

  const response = await sendHttpRequest(request, getTimeoutMs());
  const result = evaluateExpectations(block.name, block.expect, response);

  for (const line of formatCheckResult(request, result, environment.name)) {
    channel.appendLine(line);
  }
  return result;
}

/** Every block in a document that carries an `expect:` block. */
export function checkableBlocks(document: vscode.TextDocument): RequestBlock[] {
  return parseApiFile(document.getText()).requests.filter((r) => r.expect !== undefined);
}

async function runChecksOverDocuments(
  documents: vscode.TextDocument[],
  channel: vscode.OutputChannel,
  environments: EnvironmentManager,
  scope: string
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  channel.show(true);
  channel.appendLine('');
  channel.appendLine('═'.repeat(72));
  channel.appendLine(`Running checks — ${scope}  (${new Date().toLocaleTimeString()})`);
  channel.appendLine('═'.repeat(72));

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Local API Check: running checks in ${scope}`,
      cancellable: true
    },
    async (progress, token) => {
      const total = documents.reduce((sum, doc) => sum + checkableBlocks(doc).length, 0);
      let done = 0;

      for (const document of documents) {
        const blocks = checkableBlocks(document);
        if (blocks.length === 0) {
          continue;
        }
        if (documents.length > 1) {
          channel.appendLine('');
          channel.appendLine(`${vscode.workspace.asRelativePath(document.uri)}`);
        }

        for (const block of blocks) {
          if (token.isCancellationRequested) {
            channel.appendLine('');
            channel.appendLine('Cancelled.');
            return;
          }
          progress.report({
            message: `${block.name} (${done + 1}/${total})`,
            increment: total > 0 ? 100 / total : 0
          });
          // Sequential on purpose: predictable ordering, and it does not hammer
          // whatever the user is pointing this at.
          results.push(await runCheck(document, block, channel, environments));
          done++;
        }
      }
    }
  );

  for (const line of formatSummary(results, scope)) {
    channel.appendLine(line);
  }
  return results;
}

function announce(results: CheckResult[], scope: string): void {
  if (results.length === 0) {
    void vscode.window.showInformationMessage(
      `Local API Check: no checks found in ${scope}. Add an "expect:" block to a request.`
    );
    return;
  }
  const text = `Local API Check: ${summaryText(results)} (${scope})`;
  if (results.some((r) => !r.passed)) {
    void vscode.window.showWarningMessage(text);
  } else {
    void vscode.window.showInformationMessage(text);
  }
}

export async function runChecksInFile(
  document: vscode.TextDocument,
  channel: vscode.OutputChannel,
  environments: EnvironmentManager
): Promise<CheckResult[]> {
  const scope = vscode.workspace.asRelativePath(document.uri);
  const results = await runChecksOverDocuments([document], channel, environments, scope);
  announce(results, scope);
  return results;
}

export async function runChecksInWorkspace(
  channel: vscode.OutputChannel,
  environments: EnvironmentManager
): Promise<CheckResult[]> {
  const uris = await findApiFiles();
  if (uris.length === 0) {
    void vscode.window.showInformationMessage(
      'Local API Check: no .api files found in this workspace.'
    );
    return [];
  }

  const documents: vscode.TextDocument[] = [];
  for (const uri of uris) {
    documents.push(await vscode.workspace.openTextDocument(uri));
  }

  const scope = `${uris.length} .api file${uris.length === 1 ? '' : 's'}`;
  const results = await runChecksOverDocuments(documents, channel, environments, scope);
  announce(results, scope);
  return results;
}

/** All `.api` files in the workspace, excluding the usual noise directories. */
export async function findApiFiles(): Promise<vscode.Uri[]> {
  const uris = await vscode.workspace.findFiles('**/*.api', '**/{node_modules,.git,out,dist}/**');
  return uris.sort((a, b) => a.path.localeCompare(b.path));
}
