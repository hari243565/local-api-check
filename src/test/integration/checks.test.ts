import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CheckResult } from '../../assert';
import { activateExtension, showFixture, useEnvironment } from './helpers';
import { ensureTestServers } from './testServer';

/**
 * Runs the check suite through the real commands, against the mixed-outcome
 * fixture whose passes and failures are designed in advance.
 */
suite('Run All Checks', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await ensureTestServers();
    await activateExtension();
    await useEnvironment('local');
  });

  function failureDetails(result: CheckResult): string[] {
    return result.assertions.filter((a) => !a.ok).map((a) => a.detail ?? a.label);
  }

  test('in file: two pass and two fail, exactly as the fixture is designed', async function () {
    this.timeout(30_000);
    await showFixture('mixed.api');

    const results = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInFile'
    );
    assert.ok(results, 'the command returned no results');

    assert.equal(results.length, 4, 'the block without expectations must be skipped');
    assert.deepEqual(
      results.map((r) => r.name),
      [
        'Todo exists',
        'Create a post',
        'Missing todo fails on status',
        'Plain text body fails json_has'
      ]
    );
    assert.deepEqual(
      results.map((r) => r.passed),
      [true, true, false, false]
    );
    assert.equal(results.filter((r) => r.passed).length, 2);
    assert.equal(results.filter((r) => !r.passed).length, 2);
  });

  test('failures explain themselves', async function () {
    this.timeout(30_000);
    await showFixture('mixed.api');

    const results = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInFile'
    );
    assert.ok(results);

    const statusFailure = results.find((r) => r.name === 'Missing todo fails on status');
    assert.ok(statusFailure);
    assert.equal(statusFailure.status, 404);
    assert.deepEqual(failureDetails(statusFailure), ['expected status 200, got 404 Not Found']);

    const jsonFailure = results.find((r) => r.name === 'Plain text body fails json_has');
    assert.ok(jsonFailure);
    assert.equal(jsonFailure.status, 200, 'the status assertion in this block should pass');
    const details = failureDetails(jsonFailure);
    assert.equal(details.length, 1);
    assert.match(details[0], /json_has|not JSON/i);
    assert.match(details[0], /not JSON/i);
  });

  test('passing checks assert both status and json_has', async function () {
    this.timeout(30_000);
    await showFixture('mixed.api');

    const results = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInFile'
    );
    const todo = results?.find((r) => r.name === 'Todo exists');
    assert.ok(todo);
    assert.equal(todo.passed, true);
    assert.deepEqual(
      todo.assertions.map((a) => a.label),
      ['status 200', 'json_has "id"', 'json_has "title"']
    );
    assert.ok(todo.assertions.every((a) => a.ok));
  });

  test('in workspace: every .api file is included', async function () {
    this.timeout(60_000);

    const results = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInWorkspace'
    );
    assert.ok(results, 'the command returned no results');

    // mixed.api contributes four checks, simple.api one, secrets.api none.
    assert.equal(results.length, 5);
    assert.equal(results.filter((r) => r.passed).length, 3);
    assert.equal(results.filter((r) => !r.passed).length, 2);

    const names = results.map((r) => r.name);
    assert.ok(names.includes('Echo request'), 'simple.api was not included');
    assert.ok(names.includes('Todo exists'), 'mixed.api was not included');
  });

  test('a single check runs through the Run Check command', async function () {
    this.timeout(30_000);
    const document = await showFixture('mixed.api');
    const headerLine = document
      .getText()
      .split('\n')
      .findIndex((line) => line.startsWith('### Missing todo'));

    const result = await vscode.commands.executeCommand<CheckResult>(
      'localApiCheck.runCheck',
      { uri: document.uri.toString(), headerLine }
    );

    assert.ok(result);
    assert.equal(result.name, 'Missing todo fails on status');
    assert.equal(result.passed, false);
    assert.equal(result.status, 404);
  });
});
