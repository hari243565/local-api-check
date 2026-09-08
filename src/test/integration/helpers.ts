import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { LocalApiCheckApi } from '../../extension';
import type { LicenseEntryResult } from '../../license';
import { ACTIVATE_PATH, VALIDATE_PATH, type PostJson, type TransportResult } from '../../licenseApi';

export const EXTENSION_ID = 'local-api-check-dev.local-api-check';

export const TEST_LICENSE_KEY = 'PRO-TEST-0000-1111-2222';
export const TEST_INSTANCE_ID = 'lki_integration_test';

/**
 * The default reply for any licence call. No automated test may reach the real
 * Dodo Payments servers, so every unexpected call fails as a transport error —
 * which, being fail-open, also cannot silently revoke anything.
 */
const BLOCKED: TransportResult = {
  transport: 'network',
  message: 'the integration suite blocks real licence-server traffic'
};

/**
 * Stands in for the Dodo licence server. Installed by `activateExtension()`,
 * so it is in place before any suite can trigger a licence call.
 */
class LicenseStub {
  readonly calls: Array<{ path: string; body: unknown }> = [];
  activate: TransportResult = BLOCKED;
  validate: TransportResult = BLOCKED;

  readonly post: PostJson = async (url, body) => {
    const { pathname } = new URL(url);
    this.calls.push({ path: pathname, body });
    if (pathname === ACTIVATE_PATH) {
      return this.activate;
    }
    if (pathname === VALIDATE_PATH) {
      return this.validate;
    }
    return BLOCKED;
  };

  reset(): void {
    this.calls.length = 0;
    this.activate = BLOCKED;
    this.validate = BLOCKED;
  }

  /** A licence server that accepts the test key and confirms it. */
  acceptEverything(): void {
    this.activate = {
      transport: 'response',
      status: 200,
      bodyText: JSON.stringify({ id: TEST_INSTANCE_ID, business_id: 'biz_test' })
    };
    this.validate = { transport: 'response', status: 200, bodyText: JSON.stringify({ valid: true }) };
  }

  respondToValidate(result: TransportResult): void {
    this.validate = result;
  }
}

export const licenseStub = new LicenseStub();

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
  // Before any suite can trigger one, licence traffic is pointed at the stub.
  api.license.transport = licenseStub.post;
  return api;
}

/**
 * Puts the extension into the licensed state through the real command, with a
 * stubbed licence server. Suites that exercise Pro features call this.
 */
export async function grantTestLicense(): Promise<LocalApiCheckApi> {
  const api = await activateExtension();
  licenseStub.acceptEverything();
  const result = await vscode.commands.executeCommand<LicenseEntryResult>(
    'localApiCheck.enterLicenseKey',
    TEST_LICENSE_KEY
  );
  assert.ok(result?.ok, `could not grant the test licence: ${result?.message}`);
  assert.equal(await api.license.isPro(), true, 'the licence was stored but Pro is still locked');
  return api;
}

/** Returns the extension to the free tier. Every licensing suite tears down to this. */
export async function clearTestLicense(): Promise<void> {
  await vscode.commands.executeCommand('localApiCheck.removeLicense');
  licenseStub.reset();
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
