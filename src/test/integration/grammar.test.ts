import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';
import { EXTENSION_ID, activateExtension, fixtureUri } from './helpers';

const SCOPE_NAME = 'source.local-api-check';

/**
 * Runs the shipped TextMate grammar through the same engine VS Code uses
 * (vscode-textmate over vscode-oniguruma) and asserts that real fixture lines
 * are classified with the scopes a theme colours. A grammar that merely parses
 * as JSON proves nothing; this proves the tokens.
 */
suite('Syntax highlighting', () => {
  let grammar: textmate.IGrammar;
  let extensionPath: string;

  suiteSetup(async function () {
    this.timeout(30_000);
    await activateExtension();

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    extensionPath = extension.extensionPath;

    const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
    const wasm = fs.readFileSync(wasmPath);
    await oniguruma.loadWASM(
      wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer
    );

    const registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
        createOnigString: (source) => new oniguruma.OnigString(source)
      }),
      loadGrammar: async (scopeName) => {
        if (scopeName !== SCOPE_NAME) {
          return null;
        }
        const grammarPath = path.join(extensionPath, 'syntaxes', 'api.tmLanguage.json');
        return textmate.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath);
      }
    });

    const loaded = await registry.loadGrammar(SCOPE_NAME);
    assert.ok(loaded, `could not load the ${SCOPE_NAME} grammar`);
    grammar = loaded;
  });

  interface Token {
    line: number;
    text: string;
    scopes: string[];
  }

  /** Tokenizes a whole file the way VS Code does, line by line with a rule stack. */
  function tokenize(content: string): Token[] {
    const tokens: Token[] = [];
    let ruleStack = textmate.INITIAL;
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const result = grammar.tokenizeLine(lines[i], ruleStack);
      for (const token of result.tokens) {
        const text = lines[i].substring(token.startIndex, token.endIndex);
        if (text.trim().length > 0) {
          tokens.push({ line: i, text, scopes: token.scopes });
        }
      }
      ruleStack = result.ruleStack;
    }
    return tokens;
  }

  async function tokenizeFixture(name: string): Promise<Token[]> {
    const content = fs.readFileSync(fixtureUri(name).fsPath, 'utf8');
    return tokenize(content);
  }

  /**
   * The scopes on the token with exactly this text. `line` is required
   * whenever the same literal appears more than once in a fixture — several do
   * (`"title"` is both an expected key and a JSON body key), and they must not
   * be confused for one another.
   */
  function scopesOf(tokens: Token[], text: string, line?: number): string[] {
    const candidates = tokens.filter((t) => t.text === text && (line === undefined || t.line === line));
    assert.ok(
      candidates.length > 0,
      `no token with the exact text ${JSON.stringify(text)}${line === undefined ? '' : ` on line ${line}`}`
    );
    if (line === undefined) {
      assert.equal(
        candidates.length,
        1,
        `${JSON.stringify(text)} appears ${candidates.length} times — pass a line to disambiguate`
      );
    }
    return candidates[0].scopes;
  }

  /** 0-based index of the first line containing `needle`. */
  function lineWith(name: string, needle: string): number {
    const content = fs.readFileSync(fixtureUri(name).fsPath, 'utf8');
    const line = content.split(/\r?\n/).findIndex((text) => text.includes(needle));
    assert.ok(line >= 0, `fixture ${name} has no line containing ${JSON.stringify(needle)}`);
    return line;
  }

  test('the grammar is registered for the .api language', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')
    ) as { contributes: { grammars: Array<{ language: string; scopeName: string }> } };
    const entry = manifest.contributes.grammars.find((g) => g.scopeName === SCOPE_NAME);
    assert.ok(entry, 'package.json contributes no grammar for the .api scope');
    assert.equal(entry.language, 'local-api-check');
  });

  test('block headers, methods, headers and variables get distinct scopes', async () => {
    const tokens = await tokenizeFixture('simple.api');

    assert.ok(
      scopesOf(tokens, 'Echo request').includes('entity.name.section.api'),
      'the request name should be a section heading'
    );
    assert.ok(
      scopesOf(tokens, '###').includes('punctuation.definition.heading.api'),
      'the ### marker should be heading punctuation'
    );
    assert.ok(
      scopesOf(tokens, 'GET').includes('keyword.control.method.api'),
      'the HTTP method should be a keyword'
    );
    assert.ok(
      scopesOf(tokens, 'Authorization').includes('support.type.property-name.api'),
      'a header name should be a property name'
    );
    assert.ok(
      scopesOf(tokens, '{{auth_token}}').includes('variable.other.template.api'),
      'a {{variable}} in a header value should be a variable'
    );
    assert.ok(
      scopesOf(tokens, '{{base_url}}').includes('variable.other.template.api'),
      'a {{variable}} in the URL should be a variable'
    );
  });

  test('the expect block and its assertions get their own scopes', async () => {
    const tokens = await tokenizeFixture('simple.api');

    assert.ok(
      scopesOf(tokens, 'expect').includes('keyword.control.expect.api'),
      'expect: should be its own keyword, not a header name'
    );
    assert.ok(
      !scopesOf(tokens, 'expect').includes('support.type.property-name.api'),
      'expect: must not be classified as a request header'
    );
    assert.ok(
      scopesOf(tokens, 'status').includes('support.function.assertion.api'),
      'status should be an assertion name'
    );
    assert.ok(
      scopesOf(tokens, 'json_has').includes('support.function.assertion.api'),
      'json_has should be an assertion name'
    );
    assert.ok(
      scopesOf(tokens, '200').includes('constant.numeric.api'),
      'an expected status should be a number'
    );
  });

  test('comments are comments, and a JSON body is classified', async () => {
    const tokens = await tokenizeFixture('mixed.api');

    const comment = tokens.find((t) => t.text.startsWith('# Fixture'));
    assert.ok(comment, 'the leading comment produced no token');
    assert.ok(
      comment.scopes.includes('comment.line.number-sign.api'),
      `expected a comment scope, got ${comment.scopes.join(', ')}`
    );

    const bodyLine = lineWith('mixed.api', '"title": "fixture post"');
    assert.ok(
      scopesOf(tokens, '"title"', bodyLine).includes('support.type.property-name.json.api'),
      'a JSON body key should be a property name'
    );
    assert.ok(
      scopesOf(tokens, '"fixture post"', bodyLine).includes('string.quoted.double.json.api'),
      'a JSON body string should be a string'
    );
    assert.ok(
      scopesOf(tokens, '1', lineWith('mixed.api', '"userId": 1')).includes(
        'constant.numeric.json.api'
      ),
      'a JSON body number should be a number'
    );

    // The same literal inside an expect list must be classified as part of the
    // expectation, not as a JSON body key.
    const expectLine = lineWith('mixed.api', 'json_has: ["id", "title"]');
    const inExpect = scopesOf(tokens, '"title"', expectLine);
    assert.ok(inExpect.includes('constant.other.expectation.api'), inExpect.join(', '));
    assert.ok(!inExpect.includes('support.type.property-name.json.api'));
  });

  test('a block header is never mistaken for a comment', async () => {
    const tokens = await tokenizeFixture('secrets.api');
    const header = tokens.find((t) => t.text === 'Leaky request');
    assert.ok(header);
    assert.ok(header.scopes.includes('entity.name.section.api'));
    assert.ok(!header.scopes.some((s) => s.startsWith('comment.')));
  });
});
