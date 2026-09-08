import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envNameFromFile, isLocalOnlyEnv, normalizeEnvValues, prepareWithEnv, substitute } from '../env';
import { parseApiFile } from '../parser';

test('substitutes known variables and reports unknown ones', () => {
  const result = substitute('{{base_url}}/users/{{user_id}}', { base_url: 'https://api.test' });
  assert.equal(result.text, 'https://api.test/users/{{user_id}}');
  assert.deepEqual(result.unresolved, ['user_id']);
});

test('tolerates whitespace inside the braces', () => {
  assert.equal(substitute('{{ base_url }}/x', { base_url: 'https://a.test' }).text, 'https://a.test/x');
});

test('does not re-expand values that contain braces', () => {
  const result = substitute('{{a}}', { a: '{{a}}' });
  assert.equal(result.text, '{{a}}');
  assert.deepEqual(result.unresolved, []);
});

test('reports each missing variable once', () => {
  const result = substitute('{{a}} {{a}} {{b}}', {});
  assert.deepEqual(result.unresolved, ['a', 'b']);
});

test('applies the environment to url, headers and body', () => {
  const { requests } = parseApiFile(
    [
      '### Create user',
      'POST {{base_url}}/users',
      'Authorization: Bearer {{auth_token}}',
      '',
      '{ "org": "{{org}}" }',
      ''
    ].join('\n')
  );
  const { request, unresolved } = prepareWithEnv(requests[0], {
    base_url: 'https://api.test',
    auth_token: 'tok-123'
  });

  assert.equal(request.url, 'https://api.test/users');
  assert.equal(request.headers[0].value, 'Bearer tok-123');
  assert.equal(request.body, '{ "org": "{{org}}" }');
  assert.deepEqual(unresolved, ['org']);
});

test('normalizes env values to strings and skips _comment keys', () => {
  const { vars, issues } = normalizeEnvValues({
    _comment: 'notes',
    base_url: 'https://api.test',
    port: 8080,
    debug: true,
    empty: null,
    nested: { a: 1 }
  });
  assert.deepEqual(vars, {
    base_url: 'https://api.test',
    port: '8080',
    debug: 'true',
    empty: '',
    nested: '{"a":1}'
  });
  assert.equal(issues.length, 1);
});

test('rejects env files that are not objects', () => {
  assert.deepEqual(normalizeEnvValues([1, 2]).vars, {});
  assert.equal(normalizeEnvValues([1, 2]).issues.length, 1);
});

test('derives environment names from file names', () => {
  assert.equal(envNameFromFile('staging.json'), 'staging');
  assert.equal(envNameFromFile('staging.local.json'), 'staging.local');
  assert.equal(isLocalOnlyEnv('staging.local.json'), true);
  assert.equal(isLocalOnlyEnv('staging.json'), false);
});
