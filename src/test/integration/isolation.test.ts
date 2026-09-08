import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { EXTENSION_ID, activateExtension, workspaceFolder } from './helpers';

/**
 * Guards the test environment itself.
 *
 * The suite launches VS Code with `--disable-extensions`, so the only
 * non-builtin extension in the host must be the one under test. Asserting that
 * here means a failure or a stack trace anywhere in this run can only have come
 * from our own code — never from an unrelated extension installed on the
 * developer's machine.
 */
suite('Test environment isolation', () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test('the extension under test is the only third-party extension loaded', () => {
    const thirdParty = vscode.extensions.all
      .filter((extension) => extension.packageJSON?.isBuiltin !== true)
      .map((extension) => extension.id);

    assert.deepEqual(
      thirdParty,
      [EXTENSION_ID],
      `--disable-extensions did not isolate the host; also loaded: ${thirdParty
        .filter((id) => id !== EXTENSION_ID)
        .join(', ')}`
    );
  });

  test('the extension under test is active despite --disable-extensions', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'the extension under test is not present');
    assert.equal(extension.isActive, true);
  });

  test('the suite runs against the fixture workspace, not the repository', () => {
    const folder = workspaceFolder();
    assert.equal(folder.name, 'workspace');
    assert.match(folder.uri.path, /\/src\/test\/fixtures\/workspace$/);
  });
});
