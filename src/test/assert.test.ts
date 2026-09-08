import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateExpectations, formatSummary, lookupJsonPath, summaryText } from '../assert';
import type { HttpResponse } from '../http';
import { parseApiFile } from '../parser';

function response(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    completed: true,
    status: 200,
    statusText: 'OK',
    headers: [],
    bodyText: '{"id":1,"email":"a@b.test"}',
    durationMs: 12,
    ...overrides
  };
}

function expectOf(source: string) {
  return parseApiFile(source).requests[0].expect;
}

const EXPECT_200_WITH_KEYS = expectOf(
  '### x\nGET https://e.test/\n\nexpect:\n  status: 200\n  json_has: ["id", "email"]\n'
);

test('passes when status and keys match', () => {
  const result = evaluateExpectations('x', EXPECT_200_WITH_KEYS, response());
  assert.equal(result.passed, true);
  assert.equal(result.assertions.length, 3);
});

test('reports the actual status on a mismatch', () => {
  const result = evaluateExpectations(
    'x',
    EXPECT_200_WITH_KEYS,
    response({ status: 404, statusText: 'Not Found' })
  );
  assert.equal(result.passed, false);
  assert.equal(result.assertions[0].detail, 'expected status 200, got 404 Not Found');
});

test('reports a missing json key and what the body did have', () => {
  const result = evaluateExpectations(
    'x',
    EXPECT_200_WITH_KEYS,
    response({ bodyText: '{"id":1}' })
  );
  assert.equal(result.passed, false);
  const failure = result.assertions.find((a) => !a.ok);
  assert.match(failure?.detail ?? '', /key "email" is missing/);
  assert.match(failure?.detail ?? '', /body has: id/);
});

test('fails json_has cleanly when the body is not JSON', () => {
  const result = evaluateExpectations(
    'x',
    EXPECT_200_WITH_KEYS,
    response({ bodyText: '<html>nope</html>' })
  );
  assert.equal(result.passed, false);
  assert.match(result.assertions[1].detail ?? '', /not JSON/);
});

test('fails when the request never completed', () => {
  const result = evaluateExpectations(
    'x',
    EXPECT_200_WITH_KEYS,
    response({ completed: false, status: 0, bodyText: '', error: 'getaddrinfo ENOTFOUND' })
  );
  assert.equal(result.passed, false);
  assert.equal(result.transportError, 'getaddrinfo ENOTFOUND');
});

test('a null value still counts as present', () => {
  const result = evaluateExpectations(
    'x',
    expectOf('### x\nGET https://e.test/\n\nexpect:\n  json_has: ["email"]\n'),
    response({ bodyText: '{"email":null}' })
  );
  assert.equal(result.passed, true);
});

test('an expect block with no entries passes trivially', () => {
  const result = evaluateExpectations('x', expectOf('### x\nGET https://e.test/\n\nexpect:\n'), response());
  assert.equal(result.passed, true);
  assert.equal(result.assertions.length, 0);
});

test('lookupJsonPath walks objects and arrays', () => {
  const body = { data: { id: 7 }, items: [{ name: 'a' }] };
  assert.equal(lookupJsonPath(body, 'data.id').found, true);
  assert.equal(lookupJsonPath(body, 'items.0.name').value, 'a');
  assert.equal(lookupJsonPath(body, 'items.1.name').found, false);
  assert.equal(lookupJsonPath(body, 'data.missing').found, false);
});

test('lookupJsonPath prefers an exact key containing a dot', () => {
  assert.equal(lookupJsonPath({ 'a.b': 1 }, 'a.b').value, 1);
});

test('summary counts passes and failures', () => {
  const results = [
    { name: 'a', passed: true, assertions: [], durationMs: 1 },
    { name: 'b', passed: false, assertions: [], durationMs: 1 },
    { name: 'c', passed: true, assertions: [], durationMs: 1 }
  ];
  assert.equal(summaryText(results), '2 passed, 1 failed');
  const lines = formatSummary(results, 'demo.api');
  assert.ok(lines.some((l) => l.includes('2 passed, 1 failed')));
  assert.ok(lines.some((l) => l.includes('✗ b')));
});

test('summary explains an empty run', () => {
  assert.match(formatSummary([], 'demo.api').join('\n'), /No checks found/);
});
