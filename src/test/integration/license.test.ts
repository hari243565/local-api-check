import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CheckResult } from '../../assert';
import type { LocalApiCheckApi } from '../../extension';
import type { LicenseEntryResult } from '../../license';
import {
  ACTIVATE_PATH,
  DODO_BASE_URL,
  DODO_LIVE_BASE_URL,
  DODO_TEST_BASE_URL,
  VALIDATE_PATH
} from '../../licenseApi';
import type { SendSummary } from '../../runner';
import {
  EXTENSION_ID,
  TEST_INSTANCE_ID,
  TEST_LICENSE_KEY,
  activateExtension,
  clearTestLicense,
  grantTestLicense,
  licenseStub,
  showFixture,
  useEnvironment,
  waitFor
} from './helpers';
import { ensureTestServers, requestCount, resetRequestCount } from './testServer';

/**
 * Proves the free/Pro split against the real, registered commands.
 *
 * The licence server is stubbed throughout — no automated test may depend on
 * Dodo Payments being reachable — but everything on this side of the stub is
 * the shipping code path: the real commands, the real SecretStorage, the real
 * gate.
 */
suite('Licensing', () => {
  let api: LocalApiCheckApi;

  /** The three commands behind the paywall. */
  const PRO_COMMANDS = [
    'localApiCheck.runCheck',
    'localApiCheck.runAllChecksInFile',
    'localApiCheck.runAllChecksInWorkspace'
  ];

  suiteSetup(async function () {
    this.timeout(30_000);
    await ensureTestServers();
    api = await activateExtension();
    await useEnvironment('local');
    await clearTestLicense();
  });

  suiteTeardown(async () => {
    await clearTestLicense();
  });

  async function checkRef(): Promise<{ uri: string; headerLine: number }> {
    const document = await showFixture('mixed.api');
    const headerLine = document
      .getText()
      .split('\n')
      .findIndex((line) => line.startsWith('### Todo exists'));
    assert.ok(headerLine >= 0, 'fixture block not found');
    return { uri: document.uri.toString(), headerLine };
  }

  // -------------------------------------------------------------------------
  // Free tier
  // -------------------------------------------------------------------------

  test('with no key stored the extension is on the free tier', async () => {
    const snapshot = await api.license.snapshot();
    assert.equal(snapshot.state, 'free');
    assert.equal(snapshot.pro, false);

    const message = await vscode.commands.executeCommand<string>('localApiCheck.licenseStatus');
    assert.match(message, /free tier/i);
    // The status has to say what free already includes, not just what is missing.
    assert.match(message, /sending requests/i);
  });

  test('the free tier is not crippled: sending a request still works unlicensed', async function () {
    this.timeout(30_000);
    assert.equal(await api.license.isPro(), false, 'this test is only meaningful unlicensed');

    const document = await showFixture('simple.api');
    const headerLine = document
      .getText()
      .split('\n')
      .findIndex((line) => line.startsWith('### Echo request'));

    const summary = await vscode.commands.executeCommand<SendSummary>(
      'localApiCheck.sendRequest',
      { uri: document.uri.toString(), headerLine }
    );

    assert.ok(summary, 'Send Request returned nothing on the free tier');
    assert.equal(summary.completed, true);
    assert.equal(summary.status, 200);
    assert.equal(summary.url, 'http://127.0.0.1:39871/echo');
  });

  test('every Pro command is blocked before a licence, and none of them hits the network', async function () {
    this.timeout(30_000);
    assert.equal(await api.license.isPro(), false);

    await showFixture('mixed.api');
    const ref = await checkRef();
    resetRequestCount();

    const blocked = [
      await vscode.commands.executeCommand<CheckResult | undefined>(
        'localApiCheck.runCheck',
        ref
      ),
      await vscode.commands.executeCommand<CheckResult[] | undefined>(
        'localApiCheck.runAllChecksInFile'
      ),
      await vscode.commands.executeCommand<CheckResult[] | undefined>(
        'localApiCheck.runAllChecksInWorkspace'
      )
    ];

    for (let i = 0; i < blocked.length; i++) {
      assert.equal(blocked[i], undefined, `${PRO_COMMANDS[i]} produced a result without a licence`);
    }
    // A gate that returns undefined after doing the work is not a gate.
    assert.equal(
      requestCount(),
      0,
      'a blocked Pro command still sent HTTP requests'
    );
  });

  test('the upsell says what free includes and what Pro adds', async () => {
    const message = await api.license.showUpsell('Run All Checks in File');
    assert.match(message, /Run All Checks in File is a Pro feature/);
    assert.match(message, /sending requests/i);
    assert.match(message, /environments/i);
    assert.match(message, /hardcoded-secret warnings/i);
    assert.match(message, /expect:/);
  });

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  test('entering a key activates it against the documented endpoint and unlocks Pro', async function () {
    this.timeout(30_000);
    await clearTestLicense();
    licenseStub.acceptEverything();

    const result = await vscode.commands.executeCommand<LicenseEntryResult>(
      'localApiCheck.enterLicenseKey',
      TEST_LICENSE_KEY
    );

    assert.ok(result?.ok, `activation failed: ${result?.message}`);

    const activateCalls = licenseStub.calls.filter((call) => call.path === ACTIVATE_PATH);
    assert.equal(activateCalls.length, 1, 'expected exactly one activation call');
    const body = activateCalls[0].body as { license_key: string; name: string };
    assert.equal(body.license_key, TEST_LICENSE_KEY);
    // A stable per-install id, not the machine name.
    assert.match(body.name, /^local-api-check [0-9a-z-]{8,}$/i);
    assert.ok(!body.name.includes(os.hostname()), 'the hostname must not be sent');

    const snapshot = await api.license.snapshot();
    assert.equal(snapshot.state, 'pro');
    assert.equal(snapshot.pro, true);

    const status = await vscode.commands.executeCommand<string>('localApiCheck.licenseStatus');
    assert.match(status, /Pro — licensed/);
  });

  test('the key and instance id live in SecretStorage, and nowhere else', async function () {
    this.timeout(30_000);
    await grantTestLicense();

    // Reaching past `private` deliberately: this is the one claim worth
    // verifying against the real ExtensionContext rather than trusting.
    const context = (api.license as unknown as { context: vscode.ExtensionContext }).context;

    // Polled rather than read once: the assertion is that the credentials
    // really do reach SecretStorage, not that the write is synchronous.
    await waitFor(
      async () => (await context.secrets.get('localApiCheck.licenseKey')) === TEST_LICENSE_KEY,
      'the licence key to reach SecretStorage'
    );
    await waitFor(
      async () =>
        (await context.secrets.get('localApiCheck.licenseKeyInstanceId')) === TEST_INSTANCE_ID,
      'the instance id to reach SecretStorage'
    );

    for (const memento of [context.globalState, context.workspaceState]) {
      for (const key of memento.keys()) {
        const serialized = JSON.stringify(memento.get(key) ?? null);
        assert.ok(
          !serialized.includes(TEST_LICENSE_KEY),
          `the licence key leaked into state under "${key}"`
        );
        assert.ok(
          !serialized.includes(TEST_INSTANCE_ID),
          `the instance id leaked into state under "${key}"`
        );
      }
    }

    // And nothing wrote it into the user's project.
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
    for (const uri of files) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      assert.ok(
        !text.includes(TEST_LICENSE_KEY),
        `the licence key was written into ${vscode.workspace.asRelativePath(uri)}`
      );
    }
  });

  test('a rejected key surfaces the message from the licence server verbatim', async function () {
    this.timeout(30_000);
    await clearTestLicense();
    licenseStub.activate = {
      transport: 'response',
      status: 422,
      bodyText: JSON.stringify({ message: 'license key has reached its activation limit' })
    };

    const result = await vscode.commands.executeCommand<LicenseEntryResult>(
      'localApiCheck.enterLicenseKey',
      'PRO-EXHAUSTED-KEY'
    );

    assert.equal(result?.ok, false);
    assert.match(result.message, /license key has reached its activation limit/);
    assert.equal((await api.license.snapshot()).state, 'free', 'a rejected key must not be stored');
  });

  test('an unreachable licence server during activation does not store the key', async function () {
    this.timeout(30_000);
    await clearTestLicense();
    licenseStub.activate = { transport: 'timeout', message: 'timed out after 10000 ms' };

    const result = await vscode.commands.executeCommand<LicenseEntryResult>(
      'localApiCheck.enterLicenseKey',
      TEST_LICENSE_KEY
    );

    assert.equal(result?.ok, false);
    assert.match(result.message, /could not reach the licence server/i);
    assert.match(result.message, /timeout/);
    const snapshot = await api.license.snapshot();
    assert.equal(
      snapshot.state,
      'free',
      `last licence event was: ${snapshot.lastOutcome ?? '(none)'}`
    );
  });

  // -------------------------------------------------------------------------
  // Pro, unlocked
  // -------------------------------------------------------------------------

  test('once licensed, all three Pro commands actually run', async function () {
    this.timeout(60_000);
    await grantTestLicense();
    await useEnvironment('local');

    const single = await vscode.commands.executeCommand<CheckResult>(
      'localApiCheck.runCheck',
      await checkRef()
    );
    assert.ok(single, 'Run Check produced nothing while licensed');
    assert.equal(single.name, 'Todo exists');
    assert.equal(single.passed, true);

    await showFixture('mixed.api');
    resetRequestCount();
    const inFile = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInFile'
    );
    assert.ok(inFile, 'Run All Checks in File produced nothing while licensed');
    assert.equal(inFile.length, 4);
    assert.ok(requestCount() >= 4, 'the checks did not actually reach the server');

    const inWorkspace = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInWorkspace'
    );
    assert.ok(inWorkspace, 'Run All Checks in Workspace produced nothing while licensed');
    assert.equal(inWorkspace.length, 5);
  });

  // -------------------------------------------------------------------------
  // Revalidation: fail open, revoke only on an explicit no
  // -------------------------------------------------------------------------

  test('an explicit valid:false revokes Pro and re-locks the commands', async function () {
    this.timeout(30_000);
    await grantTestLicense();
    licenseStub.respondToValidate({
      transport: 'response',
      status: 200,
      bodyText: JSON.stringify({ valid: false })
    });

    const outcome = await api.license.refreshIfStale(true);
    assert.deepEqual(outcome, { kind: 'invalid' });

    const snapshot = await api.license.snapshot();
    assert.equal(
      snapshot.state,
      'revoked',
      `last licence event was: ${snapshot.lastOutcome ?? '(none)'}`
    );
    assert.equal(snapshot.pro, false);

    resetRequestCount();
    const result = await vscode.commands.executeCommand<CheckResult[] | undefined>(
      'localApiCheck.runAllChecksInFile'
    );
    assert.equal(result, undefined, 'a revoked licence still ran checks');
    assert.equal(requestCount(), 0);

    const status = await vscode.commands.executeCommand<string>('localApiCheck.licenseStatus');
    assert.match(status, /reported invalid/i);
    // Free features are never withdrawn.
    assert.match(status, /sending requests, environments and secret warnings are unaffected/i);
  });

  test('fail open: an unreachable licence server leaves the licence exactly as it was', async function () {
    this.timeout(30_000);
    await grantTestLicense();
    const before = await api.license.snapshot();
    assert.equal(before.state, 'pro');

    for (const failure of [
      { transport: 'network', message: 'fetch failed (ECONNREFUSED)' } as const,
      { transport: 'timeout', message: 'timed out after 10000 ms' } as const,
      { transport: 'response', status: 503, bodyText: 'Service Unavailable' } as const,
      { transport: 'response', status: 200, bodyText: 'not json' } as const
    ]) {
      licenseStub.respondToValidate(failure);
      const outcome = await api.license.refreshIfStale(true);

      assert.ok(
        typeof outcome === 'object' && outcome.kind === 'unreachable',
        `${JSON.stringify(failure)} should be unreachable, got ${JSON.stringify(outcome)}`
      );

      const after = await api.license.snapshot();
      assert.equal(after.state, 'pro', `${failure.transport} revoked a valid licence`);
      assert.equal(after.pro, true);
      assert.equal(
        after.lastValidatedAt,
        before.lastValidatedAt,
        'an unreachable server must not touch the last-confirmed timestamp'
      );
      // And the distinction is recorded, not flattened into one event.
      assert.match(after.lastOutcome ?? '', /unreachable/);
      assert.doesNotMatch(after.lastOutcome ?? '', /INVALID/);
    }

    // Pro commands keep working throughout.
    await showFixture('mixed.api');
    const results = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInFile'
    );
    assert.ok(results, 'Pro was lost after a licence-server outage');
  });

  test('a confirmed licence is not revalidated on every command', async function () {
    this.timeout(30_000);
    await grantTestLicense();
    const before = licenseStub.calls.filter((call) => call.path === VALIDATE_PATH).length;

    await showFixture('mixed.api');
    await vscode.commands.executeCommand('localApiCheck.runAllChecksInFile');
    await vscode.commands.executeCommand('localApiCheck.runCheck', await checkRef());
    await api.license.refreshIfStale();

    const after = licenseStub.calls.filter((call) => call.path === VALIDATE_PATH).length;
    assert.equal(after, before, 'the licence was revalidated inside the 21-day window');
  });

  test('removing the licence returns the extension to the free tier', async function () {
    this.timeout(30_000);
    await grantTestLicense();
    await vscode.commands.executeCommand('localApiCheck.removeLicense');

    const snapshot = await api.license.snapshot();
    assert.equal(snapshot.state, 'free');
    assert.equal(snapshot.pro, false);

    await showFixture('mixed.api');
    resetRequestCount();
    assert.equal(
      await vscode.commands.executeCommand('localApiCheck.runAllChecksInFile'),
      undefined
    );
    assert.equal(requestCount(), 0);
  });

  // -------------------------------------------------------------------------
  // The security constraint, checked against what actually shipped
  // -------------------------------------------------------------------------

  test('the loaded extension bundle contains no credential material', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const bundle = path.join(extension.extensionPath, 'dist', 'extension.js');
    assert.ok(fs.existsSync(bundle), `no bundle at ${bundle}`);

    // The same rules the packaging check runs, applied to the extension as VS
    // Code actually loaded it.
    const { scanText } = require('../../../tools/check-no-secrets') as {
      scanText: (text: string) => Array<{ rule: string; line: number; excerpt: string }>;
    };
    const findings = scanText(fs.readFileSync(bundle, 'utf8'));
    assert.deepEqual(
      findings,
      [],
      `credential material in the shipped bundle: ${JSON.stringify(findings)}`
    );
  });

  test('the shipped bundle points only at the two documented Dodo hosts', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const bundle = fs.readFileSync(
      path.join(extension.extensionPath, 'dist', 'extension.js'),
      'utf8'
    );

    const hosts = new Set(
      [...bundle.matchAll(/https:\/\/[a-z0-9.-]*dodopayments\.com/gi)].map((m) => m[0])
    );

    // The property that matters is that no third host is baked in — a proxy,
    // a staging shim, anything that would take licence traffic somewhere the
    // documentation does not name. The unused constant is legitimately tree-
    // shaken away by esbuild, so its absence proves nothing either way.
    for (const host of hosts) {
      assert.ok(
        host === DODO_TEST_BASE_URL || host === DODO_LIVE_BASE_URL,
        `unexpected Dodo host baked into the bundle: ${host}`
      );
    }
    assert.ok(hosts.has(DODO_BASE_URL), 'the active licence base URL did not survive bundling');
  });
});
