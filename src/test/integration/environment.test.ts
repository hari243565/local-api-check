import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { LocalApiCheckApi } from '../../extension';
import type { SendSummary } from '../../runner';
import { activateExtension, fixtureUri, useEnvironment } from './helpers';
import { LOCAL_PORT, STAGING_PORT, ensureTestServers } from './testServer';

/**
 * Switching environment must change what is actually sent, not just a label.
 * The two fixture environments point at two different local servers, so the
 * port in the response proves which one answered.
 */
suite('Environment switching', () => {
  let api: LocalApiCheckApi;

  suiteSetup(async function () {
    this.timeout(30_000);
    await ensureTestServers();
    api = await activateExtension();
  });

  suiteTeardown(async () => {
    await useEnvironment('local');
  });

  async function sendEchoRequest(): Promise<SendSummary> {
    const uri = fixtureUri('simple.api');
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
      50
    );
    const send = lenses.find((l) => l.command?.command === 'localApiCheck.sendRequest');
    assert.ok(send?.command);
    const summary = await vscode.commands.executeCommand<SendSummary>(
      send.command.command,
      ...(send.command.arguments ?? [])
    );
    assert.ok(summary, 'sendRequest returned nothing');
    assert.equal(summary.completed, true, summary.error ?? 'request did not complete');
    return summary;
  }

  test('both fixture environments are discovered', async () => {
    const names = await api.environments.listEnvironmentNames();
    assert.deepEqual(names, ['local', 'staging']);
  });

  test('under "local" the request resolves to the local server', async function () {
    this.timeout(30_000);
    await useEnvironment('local');
    assert.equal(api.environments.activeName, 'local');

    const summary = await sendEchoRequest();
    assert.equal(summary.environment, 'local');
    assert.equal(summary.url, `http://127.0.0.1:${LOCAL_PORT}/echo`);
    assert.deepEqual(
      summary.headers.find((h) => h.name === 'Authorization'),
      { name: 'Authorization', value: 'Bearer local-fixture-token' }
    );

    const echoed = JSON.parse(summary.bodyText) as {
      port: number;
      headers: Record<string, string>;
    };
    assert.equal(echoed.port, LOCAL_PORT);
    assert.equal(echoed.headers.authorization, 'Bearer local-fixture-token');
  });

  test('switching to "staging" changes the resolved URL and headers', async function () {
    this.timeout(30_000);
    await useEnvironment('staging');
    assert.equal(api.environments.activeName, 'staging');

    const summary = await sendEchoRequest();
    assert.equal(summary.environment, 'staging');
    assert.equal(
      summary.url,
      `http://127.0.0.1:${STAGING_PORT}/echo`,
      'the URL should come from staging.json, not the previous environment'
    );
    assert.deepEqual(
      summary.headers.find((h) => h.name === 'Authorization'),
      { name: 'Authorization', value: 'Bearer staging-fixture-token' }
    );

    const echoed = JSON.parse(summary.bodyText) as {
      port: number;
      headers: Record<string, string>;
    };
    assert.equal(echoed.port, STAGING_PORT, 'the staging server did not answer');
    assert.equal(echoed.headers.authorization, 'Bearer staging-fixture-token');
  });

  test('switching back restores the previous values', async function () {
    this.timeout(30_000);
    await useEnvironment('local');
    const summary = await sendEchoRequest();
    assert.equal(summary.url, `http://127.0.0.1:${LOCAL_PORT}/echo`);
  });

  test('asking for an environment that does not exist is refused, not guessed', async () => {
    const switched = await vscode.commands.executeCommand<boolean>(
      'localApiCheck.selectEnvironment',
      'production'
    );
    assert.equal(switched, false);
    assert.equal(api.environments.activeName, 'local', 'the active environment must not change');
  });
});
