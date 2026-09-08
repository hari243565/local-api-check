import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  fixtureUri,
  readFile,
  restoreDocument,
  waitFor,
  writeFile
} from './helpers';

const FAKE_SECRET = 'sk_test_faketoken1234567890abcdef';

/**
 * End-to-end cover for the secret nudge: real diagnostics from the real
 * DiagnosticCollection, the real quick fix offered by
 * `vscode.executeCodeActionProvider`, and the file plus environment file it
 * leaves behind once applied.
 */
suite('Hardcoded secret detection', () => {
  const apiUri = fixtureUri('secrets.api');
  const envUri = fixtureUri('.api-env', 'local.json');

  let originalApi: string;
  let originalEnv: string;

  suiteSetup(async () => {
    await activateExtension();
    originalApi = await readFile(apiUri);
    originalEnv = await readFile(envUri);
  });

  suiteTeardown(async () => {
    await restoreDocument(apiUri, originalApi);
    await writeFile(envUri, originalEnv);
  });

  function diagnostics(): vscode.Diagnostic[] {
    return vscode.languages
      .getDiagnostics(apiUri)
      .filter((d) => d.source === 'Local API Check');
  }

  /** Line holding the deliberately fake credential. */
  function secretLine(document: vscode.TextDocument): number {
    const line = document
      .getText()
      .split('\n')
      .findIndex((text) => text.includes(FAKE_SECRET));
    assert.ok(line >= 0, 'fixture no longer contains the fake secret');
    return line;
  }

  test('opening the file reports one warning, on the hardcoded credential', async () => {
    const document = await vscode.workspace.openTextDocument(apiUri);
    await vscode.window.showTextDocument(document, { preview: false });

    await waitFor(() => diagnostics().length > 0, 'a secret diagnostic to appear');

    const found = diagnostics();
    assert.equal(found.length, 1, `expected exactly one finding, got ${found.length}`);

    const [diagnostic] = found;
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(diagnostic.message, /hardcoded secret/i);
    assert.match(diagnostic.message, /environment variable/i);

    const line = secretLine(document);
    assert.equal(diagnostic.range.start.line, line);
    assert.equal(
      document.getText(diagnostic.range),
      FAKE_SECRET,
      'the warning should underline exactly the credential'
    );
  });

  test('the request using {{auth_token}} is left alone', async () => {
    const document = await vscode.workspace.openTextDocument(apiUri);
    const cleanLine = document
      .getText()
      .split('\n')
      .findIndex((text) => text.includes('{{auth_token}}'));
    assert.ok(cleanLine >= 0, 'fixture no longer contains the clean request');

    const onCleanLine = diagnostics().filter((d) => d.range.start.line === cleanLine);
    assert.deepEqual(onCleanLine, [], 'a correct {{variable}} must not be flagged');
  });

  test('the quick fix extracts the secret into the active environment file', async () => {
    const document = await vscode.workspace.openTextDocument(apiUri);
    await waitFor(() => diagnostics().length === 1, 'the secret diagnostic');
    const [diagnostic] = diagnostics();

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      apiUri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value
    );
    assert.ok(actions && actions.length > 0, 'no code action offered on the warning');

    const fix = actions.find((a) => a.command?.command === 'localApiCheck.extractSecret');
    assert.ok(fix, 'the extract-to-environment quick fix was not offered');
    assert.match(fix.title, /Extract to \{\{auth_token\}\}/);
    assert.equal(fix.kind?.value, vscode.CodeActionKind.QuickFix.value);

    await vscode.commands.executeCommand(fix.command!.command, ...(fix.command!.arguments ?? []));

    // The fixture environment already defines auth_token with a different
    // value, so the fix must not clobber it — it picks the next free name.
    await waitFor(
      () => document.getText().includes('{{auth_token_2}}'),
      'the document to be rewritten to use a variable'
    );
    assert.ok(
      !document.getText().includes(FAKE_SECRET),
      'the credential should no longer appear in the .api file'
    );

    await waitFor(async () => {
      const env = JSON.parse(await readFile(envUri)) as Record<string, string>;
      return env.auth_token_2 === FAKE_SECRET;
    }, 'the secret to be written to .api-env/local.json');

    const env = JSON.parse(await readFile(envUri)) as Record<string, string>;
    assert.equal(env.auth_token_2, FAKE_SECRET);
    assert.equal(env.auth_token, 'local-fixture-token', 'the existing value must survive');
    assert.equal(env.base_url, 'http://127.0.0.1:39871', 'unrelated keys must survive');

    await waitFor(
      () => diagnostics().length === 0,
      'the warning to clear once the secret is extracted'
    );
  });
});
