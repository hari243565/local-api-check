import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickVariableName, scanForSecrets } from '../secrets';

test('flags a hardcoded bearer token', () => {
  const findings = scanForSecrets(
    '### x\nGET https://api.test/me\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef0123456789\n'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].kind, 'bearer token');
  assert.equal(findings[0].suggestedName, 'auth_token');
  assert.equal(findings[0].value, 'eyJhbGciOiJIUzI1NiJ9abcdef0123456789');
});

test('reports the exact columns of the secret', () => {
  const line = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef0123456789';
  const [finding] = scanForSecrets(line);
  assert.equal(line.slice(finding.startColumn, finding.endColumn), finding.value);
});

test('says nothing when a variable is used', () => {
  assert.deepEqual(
    scanForSecrets('### x\nGET https://api.test/me\nAuthorization: Bearer {{auth_token}}\n'),
    []
  );
});

test('ignores obvious placeholders', () => {
  assert.deepEqual(scanForSecrets('Authorization: Bearer replace-me\n'), []);
  assert.deepEqual(scanForSecrets('Authorization: Bearer <your-token-here>\n'), []);
  assert.deepEqual(scanForSecrets('X-Api-Key: xxxxxxxxxxxxxxxxxxxx\n'), []);
});

test('ignores short values that are unlikely to be credentials', () => {
  assert.deepEqual(scanForSecrets('Authorization: Bearer abc123\n'), []);
});

test('flags provider key prefixes wherever they appear', () => {
  const findings = scanForSecrets('X-Custom: ghp_ABCdef0123456789ABCdef0123456789ABCD\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'provider key');
});

test('flags a key in a query string', () => {
  const findings = scanForSecrets('GET https://api.test/v1/items?api_key=abcd1234efgh5678ijkl\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, 'abcd1234efgh5678ijkl');
});

test('flags a secret inside a JSON body', () => {
  const findings = scanForSecrets('{\n  "client_secret": "s3cr3t0123456789abcdef"\n}\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
});

test('skips comment lines and block headers', () => {
  assert.deepEqual(
    scanForSecrets('# Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef0123456789\n'),
    []
  );
  assert.deepEqual(
    scanForSecrets('### Bearer ghp_ABCdef0123456789ABCdef0123456789ABCD\n'),
    []
  );
});

test('reports one finding per literal even when two patterns match', () => {
  const findings = scanForSecrets('X-Api-Key: sk_live_ABCdef0123456789ABCdef\n');
  assert.equal(findings.length, 1);
});

test('picks a non-colliding variable name', () => {
  assert.equal(pickVariableName('auth_token', {}, 'v'), 'auth_token');
  assert.equal(pickVariableName('auth_token', { auth_token: 'v' }, 'v'), 'auth_token');
  assert.equal(pickVariableName('auth_token', { auth_token: 'other' }, 'v'), 'auth_token_2');
  assert.equal(
    pickVariableName('auth_token', { auth_token: 'other', auth_token_2: 'more' }, 'v'),
    'auth_token_3'
  );
});
