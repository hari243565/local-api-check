import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activateExtension, fixtureUri } from './helpers';

/**
 * Proves the CodeLenses a user actually sees: that VS Code asks our provider
 * for them, that they land on the right lines, and that each one is wired to a
 * registered command with the arguments that command expects.
 */
suite('CodeLens', () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  async function lensesFor(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
      50
    );
    assert.ok(Array.isArray(lenses), 'executeCodeLensProvider returned no array');
    return lenses;
  }

  /** Lines that begin a request block, straight from the file on disk. */
  function headerLines(document: vscode.TextDocument): number[] {
    const lines: number[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      if (document.lineAt(i).text.startsWith('###')) {
        lines.push(i);
      }
    }
    return lines;
  }

  test('a request with an expect block gets both a Send and a Check lens', async () => {
    const uri = fixtureUri('simple.api');
    const document = await vscode.workspace.openTextDocument(uri);
    const lenses = await lensesFor(uri);

    assert.equal(lenses.length, 2, 'expected exactly two lenses over the single request');

    const [send, check] = lenses;
    assert.equal(send.command?.title, '▶ Send Request');
    assert.equal(send.command?.command, 'localApiCheck.sendRequest');
    assert.equal(check.command?.title, '✓ Run Check');
    assert.equal(check.command?.command, 'localApiCheck.runCheck');

    // Both sit on the `### Echo request` line.
    const [headerLine] = headerLines(document);
    assert.equal(document.lineAt(headerLine).text, '### Echo request');
    for (const lens of lenses) {
      assert.equal(lens.range.start.line, headerLine);
      assert.equal(lens.range.end.line, headerLine);
    }

    // The arguments must be exactly what the commands resolve a request from.
    for (const lens of lenses) {
      const [ref] = (lens.command?.arguments ?? []) as Array<{
        uri: string;
        headerLine: number;
      }>;
      assert.ok(ref, 'lens command carries no arguments');
      assert.equal(vscode.Uri.parse(ref.uri).toString(), document.uri.toString());
      assert.equal(ref.headerLine, headerLine);
    }
  });

  test('every block gets a Send lens, and only checkable blocks get a Check lens', async () => {
    const uri = fixtureUri('mixed.api');
    const document = await vscode.workspace.openTextDocument(uri);
    const lenses = await lensesFor(uri);
    const lines = headerLines(document);

    assert.equal(lines.length, 5, 'fixture should contain five request blocks');

    const sendLines = lenses
      .filter((l) => l.command?.command === 'localApiCheck.sendRequest')
      .map((l) => l.range.start.line);
    const checkLines = lenses
      .filter((l) => l.command?.command === 'localApiCheck.runCheck')
      .map((l) => l.range.start.line);

    assert.deepEqual(sendLines, lines, 'every request block should offer Send Request');
    assert.deepEqual(
      checkLines,
      lines.slice(0, 4),
      'only the four blocks with an expect: block should offer Run Check'
    );

    const last = lenses.filter((l) => l.range.start.line === lines[4]);
    assert.equal(last.length, 1, 'the block without expectations should have one lens only');
  });

  test('the Check lens tooltip names the expectations it will assert', async () => {
    const lenses = await lensesFor(fixtureUri('simple.api'));
    const check = lenses.find((l) => l.command?.command === 'localApiCheck.runCheck');
    assert.match(check?.command?.tooltip ?? '', /status 200/);
    assert.match(check?.command?.tooltip ?? '', /json_has id, title/);
  });

  test('the lens commands are actually registered with VS Code', async () => {
    const registered = await vscode.commands.getCommands(true);
    for (const command of [
      'localApiCheck.sendRequest',
      'localApiCheck.runCheck',
      'localApiCheck.runAllChecksInFile',
      'localApiCheck.runAllChecksInWorkspace',
      'localApiCheck.selectEnvironment',
      'localApiCheck.extractSecret',
      'localApiCheck.revealRequest',
      'localApiCheck.refreshTree',
      'localApiCheck.showOutput',
      'localApiCheck.enterLicenseKey',
      'localApiCheck.licenseStatus',
      'localApiCheck.removeLicense'
    ]) {
      assert.ok(registered.includes(command), `${command} is not registered`);
    }
  });
});
