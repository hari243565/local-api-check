import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SendSummary } from '../../runner';
import { activateExtension, fixtureUri, useEnvironment } from './helpers';
import { LOCAL_PORT, ensureTestServers } from './testServer';

/**
 * Drives the real `localApiCheck.sendRequest` command — the same command the
 * "▶ Send Request" lens invokes — and asserts on the response that comes back
 * from a real HTTP server.
 */
suite('Send Request command', () => {
  suiteSetup(async () => {
    await ensureTestServers();
    await activateExtension();
    await useEnvironment('local');
  });

  /** Invokes the command through the arguments the CodeLens would pass. */
  async function sendViaLens(uri: vscode.Uri): Promise<SendSummary> {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
      50
    );
    const send = lenses.find((l) => l.command?.command === 'localApiCheck.sendRequest');
    assert.ok(send?.command, 'no Send Request lens to invoke');
    const summary = await vscode.commands.executeCommand<SendSummary>(
      send.command.command,
      ...(send.command.arguments ?? [])
    );
    assert.ok(summary, 'sendRequest returned nothing');
    return summary;
  }

  test('sends the request and reports the real response', async () => {
    const summary = await sendViaLens(fixtureUri('simple.api'));

    assert.equal(summary.completed, true, summary.error ?? 'request did not complete');
    assert.equal(summary.status, 200);
    assert.equal(summary.method, 'GET');
    assert.equal(summary.url, `http://127.0.0.1:${LOCAL_PORT}/echo`);
    assert.deepEqual(summary.unresolved, []);
    assert.equal(summary.environment, 'local');
  });

  test('the server receives the substituted URL and headers', async () => {
    const summary = await sendViaLens(fixtureUri('simple.api'));
    const echoed = JSON.parse(summary.bodyText) as {
      port: number;
      method: string;
      path: string;
      headers: Record<string, string>;
    };

    assert.equal(echoed.port, LOCAL_PORT, 'reached the wrong environment’s server');
    assert.equal(echoed.method, 'GET');
    assert.equal(echoed.path, '/echo');
    assert.equal(echoed.headers.authorization, 'Bearer local-fixture-token');
    assert.equal(echoed.headers.accept, 'application/json');
  });

  test('sends a POST body through the same command path', async () => {
    const uri = fixtureUri('mixed.api');
    const document = await vscode.workspace.openTextDocument(uri);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
      50
    );

    // The `### Create a post` block.
    const headerLine = document
      .getText()
      .split('\n')
      .findIndex((line) => line.startsWith('### Create a post'));
    assert.ok(headerLine >= 0, 'fixture is missing the POST block');

    const send = lenses.find(
      (l) =>
        l.command?.command === 'localApiCheck.sendRequest' && l.range.start.line === headerLine
    );
    assert.ok(send?.command, 'no Send Request lens over the POST block');

    const summary = await vscode.commands.executeCommand<SendSummary>(
      send.command.command,
      ...(send.command.arguments ?? [])
    );

    assert.ok(summary);
    assert.equal(summary.status, 201);
    assert.equal(summary.method, 'POST');
    const created = JSON.parse(summary.bodyText) as { id: number; received: string };
    assert.equal(created.id, 101);
    assert.match(created.received, /"title": "fixture post"/);
  });
});
