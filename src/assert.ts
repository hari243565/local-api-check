/**
 * Evaluates `expect:` blocks against a response. The assertion vocabulary is
 * deliberately tiny for v1: `status` and `json_has`.
 *
 * `vscode`-free so it can be unit-tested directly.
 */

import { previewValue } from './format';
import type { HttpResponse, PreparedRequest } from './http';
import type { ExpectBlock } from './parser';

export interface AssertionResult {
  ok: boolean;
  /** What was checked, e.g. `status` or `json_has "id"`. */
  label: string;
  /** Human-readable reason, only meaningful when `ok` is false. */
  detail?: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  assertions: AssertionResult[];
  durationMs: number;
  status?: number;
  /** Set when the request never completed, in which case the check fails. */
  transportError?: string;
}

export function evaluateExpectations(
  name: string,
  expect: ExpectBlock | undefined,
  response: HttpResponse
): CheckResult {
  if (!response.completed) {
    return {
      name,
      passed: false,
      durationMs: response.durationMs,
      transportError: response.error ?? 'request failed',
      assertions: [
        { ok: false, label: 'request', detail: response.error ?? 'request failed' }
      ]
    };
  }

  const assertions: AssertionResult[] = [];

  if (expect?.status !== undefined) {
    const ok = response.status === expect.status;
    assertions.push({
      ok,
      label: `status ${expect.status}`,
      detail: ok
        ? undefined
        : `expected status ${expect.status}, got ${response.status}${
            response.statusText ? ` ${response.statusText}` : ''
          }`
    });
  }

  if (expect && expect.jsonHas.length > 0) {
    const parsed = parseJsonBody(response.bodyText);
    if (!parsed.ok) {
      for (const key of expect.jsonHas) {
        assertions.push({
          ok: false,
          label: `json_has "${key}"`,
          detail: `response body is not JSON (${parsed.error})`
        });
      }
    } else {
      for (const key of expect.jsonHas) {
        const found = lookupJsonPath(parsed.value, key);
        assertions.push({
          ok: found.found,
          label: `json_has "${key}"`,
          detail: found.found
            ? undefined
            : `key "${key}" is missing from the response body${describeShape(parsed.value)}`
        });
      }
    }
  }

  return {
    name,
    passed: assertions.every((a) => a.ok),
    assertions,
    durationMs: response.durationMs,
    status: response.status
  };
}

function parseJsonBody(
  bodyText: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (bodyText.trim().length === 0) {
    return { ok: false, error: 'empty body' };
  }
  try {
    return { ok: true, value: JSON.parse(bodyText) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Looks a key up in a parsed JSON body. Exact top-level keys win, so a key that
 * genuinely contains a dot still works; otherwise the key is walked as a dot
 * path (`data.id`, `items.0.name`).
 */
export function lookupJsonPath(root: unknown, key: string): { found: boolean; value?: unknown } {
  if (isPlainRecord(root) && Object.prototype.hasOwnProperty.call(root, key)) {
    return { found: true, value: root[key] };
  }

  let current: unknown = root;
  for (const segment of key.split('.')) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    if (isPlainRecord(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** " — body has keys: id, name" — helps explain a json_has failure. */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) {
    return ` — body is an array of ${value.length}`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return ' — body is an empty object';
    }
    return ` — body has: ${previewValue(keys.join(', '), 80)}`;
  }
  return ` — body is ${previewValue(value, 40)}`;
}

export function formatCheckResult(
  request: PreparedRequest,
  result: CheckResult,
  envName?: string
): string[] {
  const mark = result.passed ? '✓' : '✗';
  const env = envName ? ` [env: ${envName}]` : '';
  const status = result.transportError
    ? 'request failed'
    : `${result.status} in ${result.durationMs} ms`;
  const lines = [`${mark} ${result.name}${env} — ${status}`];
  lines.push(`    ${request.method.toUpperCase()} ${request.url}`);

  if (!result.passed) {
    for (const assertion of result.assertions) {
      if (!assertion.ok) {
        lines.push(`    ✗ ${assertion.detail ?? assertion.label}`);
      }
    }
  }
  return lines;
}

export function formatSummary(results: CheckResult[], scope: string): string[] {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  if (results.length === 0) {
    return ['', `No checks found in ${scope}. Add an "expect:" block to a request to make it a check.`];
  }

  const lines = ['', '─'.repeat(72), `${passed} passed, ${failed} failed  (${scope})`];
  if (failed > 0) {
    for (const result of results.filter((r) => !r.passed)) {
      lines.push(`  ✗ ${result.name}`);
    }
  }
  lines.push('─'.repeat(72));
  return lines;
}

/** One-line version for a notification / status message. */
export function summaryText(results: CheckResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  return `${passed} passed, ${results.length - passed} failed`;
}
