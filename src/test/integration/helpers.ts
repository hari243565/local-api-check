import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { LocalApiCheckApi } from '../../extension';

export const EXTENSION_ID = 'local-api-check-dev.local-api-check';

/**
 * Activates the real extension and returns the API its `activate()` exports.
 * Everything a user can reach is driven through `vscode.commands` instead; this
 * is only for what has no public API surface, such as the TreeDataProvider.
 */
export async function activateExtension(): Promise<LocalApiCheckApi> {
  const extension = vscode.extensions.getExtension<LocalApiCheckApi>(EXTENSION_ID);
  assert.ok(
    extension,
    `extension ${EXTENSION_ID} is not installed in the test instance — did --disable-extensions also disable the extension under test?`
  );
  const api = await extension.activate();
  assert.ok(api, 'activate() returned nothing');
  return api;
}

export function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test instance opened no workspace folder');
  return folder;
}

/** URI of a file inside the fixture workspace. */
export function fixtureUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.joinPath(workspaceFolder().uri, ...segments);
}

/** Polls until `predicate` is true, so tests never depend on a fixed sleep. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function readFile(uri: vscode.Uri): Promise<string> {
  return fs.readFile(uri.fsPath, 'utf8');
}

export async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
  await fs.writeFile(uri.fsPath, content, 'utf8');
}

/**
 * Restores a document to known text and saves it, so a test that edits a
 * fixture cannot leak into the next one.
 */
export async function restoreDocument(uri: vscode.Uri, original: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.getText() !== original) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      original
    );
    await vscode.workspace.applyEdit(edit);
  }
  if (document.isDirty) {
    await document.save();
  }
}

/** The environment every suite starts from. */
export async function useEnvironment(name: string): Promise<void> {
  const switched = await vscode.commands.executeCommand<boolean>(
    'localApiCheck.selectEnvironment',
    name
  );
  assert.equal(switched, true, `could not switch to environment "${name}"`);
}

/** Opens a fixture and makes it the active editor. */
export async function showFixture(...segments: string[]): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(fixtureUri(...segments));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}
