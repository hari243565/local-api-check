import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseApiFile, parseStringList } from '../parser';

const SAMPLE = [
  '# a leading comment',
  '',
  '### Get user profile',
  'GET https://example.test/users/1',
  'Authorization: Bearer abc',
  'Accept: application/json',
  '',
  'expect:',
  '  status: 200',
  '  json_has: ["id", "email"]',
  '',
  '### Create user',
  'POST https://example.test/users',
  'Content-Type: application/json',
  '',
  '{',
  '  "name": "Test User"',
  '}',
  '',
  'expect:',
  '  status: 201',
  ''
].join('\n');

test('parses two blocks with names, methods and urls', () => {
  const { requests } = parseApiFile(SAMPLE);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].name, 'Get user profile');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, 'https://example.test/users/1');
  assert.equal(requests[1].name, 'Create user');
  assert.equal(requests[1].method, 'POST');
});

test('parses headers without swallowing the body', () => {
  const { requests } = parseApiFile(SAMPLE);
  assert.deepEqual(
    requests[0].headers.map((h) => [h.name, h.value]),
    [
      ['Authorization', 'Bearer abc'],
      ['Accept', 'application/json']
    ]
  );
  assert.equal(requests[0].body, undefined);
  assert.equal(requests[1].body, '{\n  "name": "Test User"\n}');
});

test('parses expect blocks', () => {
  const { requests } = parseApiFile(SAMPLE);
  assert.equal(requests[0].expect?.status, 200);
  assert.deepEqual(requests[0].expect?.jsonHas, ['id', 'email']);
  assert.equal(requests[1].expect?.status, 201);
  assert.deepEqual(requests[1].expect?.jsonHas, []);
});

test('records line numbers for each block', () => {
  const { requests } = parseApiFile(SAMPLE);
  assert.equal(requests[0].headerLine, 2);
  assert.equal(requests[0].requestLine, 3);
  assert.equal(requests[1].headerLine, 11);
  assert.equal(requests[1].bodyLine, 15);
});

test('handles CRLF line endings', () => {
  const { requests } = parseApiFile(SAMPLE.replace(/\n/g, '\r\n'));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body, '{\n  "name": "Test User"\n}');
});

test('defaults to GET when no method is given', () => {
  const { requests } = parseApiFile('### bare\nhttps://example.test/ping\n');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, 'https://example.test/ping');
});

test('names unnamed blocks', () => {
  const { requests } = parseApiFile('###\nGET https://example.test/\n');
  assert.equal(requests[0].name, 'Request 1');
});

test('flags unknown expectations instead of silently ignoring them', () => {
  const { requests } = parseApiFile(
    '### x\nGET https://example.test/\n\nexpect:\n  status: 200\n  body_matches: nope\n'
  );
  assert.equal(requests[0].expect?.status, 200);
  assert.equal(requests[0].issues.length, 1);
  assert.match(requests[0].issues[0].message, /Unknown expectation/);
});

test('flags a non-numeric status', () => {
  const { requests } = parseApiFile('### x\nGET https://e.test/\n\nexpect:\n  status: OK\n');
  assert.equal(requests[0].expect?.status, undefined);
  assert.match(requests[0].issues[0].message, /must be a number/);
});

test('expect block ends at an unindented line', () => {
  const { requests } = parseApiFile(
    '### x\nGET https://e.test/\n\nexpect:\n  status: 200\n\n### y\nGET https://e.test/2\n'
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].expect?.status, 200);
  assert.equal(requests[1].expect, undefined);
});

test('reports content before the first block', () => {
  const { issues } = parseApiFile('GET https://example.test/\n\n### x\nGET https://e.test/\n');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 0);
});

test('empty file yields no requests', () => {
  const { requests, issues } = parseApiFile('');
  assert.equal(requests.length, 0);
  assert.equal(issues.length, 0);
});

test('parseStringList accepts both JSON arrays and bare lists', () => {
  assert.deepEqual(parseStringList('["a", "b"]'), ['a', 'b']);
  assert.deepEqual(parseStringList('a, b'), ['a', 'b']);
  assert.deepEqual(parseStringList('  "a" ,b '), ['a', 'b']);
  assert.deepEqual(parseStringList(''), []);
});
