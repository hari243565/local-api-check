/**
 * Environment variables: `{{name}}` substitution and env-file normalisation.
 * `vscode`-free so it can be unit-tested directly.
 */

import type { PreparedRequest } from './http';
import type { RequestBlock } from './parser';

export type EnvVars = Record<string, string>;

export const VARIABLE_RE = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

export interface Substitution {
  text: string;
  /** Names referenced by the text but missing from the environment. */
  unresolved: string[];
}

/**
 * Replaces every `{{name}}` with its value. Single pass on purpose: a value
 * that itself contains `{{...}}` is left alone rather than expanded, so a
 * self-referential environment can never loop.
 */
export function substitute(text: string, vars: EnvVars): Substitution {
  const unresolved: string[] = [];
  const result = text.replace(VARIABLE_RE, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return vars[name];
    }
    if (!unresolved.includes(name)) {
      unresolved.push(name);
    }
    return match;
  });
  return { text: result, unresolved };
}

/** Applies the active environment to every part of a request block. */
export function prepareWithEnv(
  block: RequestBlock,
  vars: EnvVars
): { request: PreparedRequest; unresolved: string[] } {
  const unresolved: string[] = [];
  const take = (text: string): string => {
    const result = substitute(text, vars);
    for (const name of result.unresolved) {
      if (!unresolved.includes(name)) {
        unresolved.push(name);
      }
    }
    return result.text;
  };

  return {
    request: {
      name: block.name,
      method: block.method,
      url: take(block.url),
      headers: block.headers.map((h) => ({ name: take(h.name), value: take(h.value) })),
      body: block.body === undefined ? undefined : take(block.body)
    },
    unresolved
  };
}

/**
 * Coerces the contents of an environment JSON file into flat string values.
 * Objects and arrays are stringified rather than rejected — that is friendlier
 * than an error when someone pastes a JSON snippet in as a value.
 */
export function normalizeEnvValues(raw: unknown): { vars: EnvVars; issues: string[] } {
  const vars: EnvVars = {};
  const issues: string[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { vars, issues: ['Environment file must contain a JSON object of key/value pairs.'] };
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith('_')) {
      // Convention: `_comment` style keys are notes, not variables.
      continue;
    }
    if (typeof value === 'string') {
      vars[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      vars[key] = String(value);
    } else if (value === null) {
      vars[key] = '';
    } else {
      vars[key] = JSON.stringify(value);
      issues.push(`"${key}" is not a string — used its JSON form.`);
    }
  }

  return { vars, issues };
}

/** `staging.json` -> `staging`, `staging.local.json` -> `staging.local`. */
export function envNameFromFile(fileName: string): string {
  return fileName.replace(/\.json$/i, '');
}

/** True for env files that the bundled .api-env/.gitignore keeps out of git. */
export function isLocalOnlyEnv(fileName: string): boolean {
  return /\.local\.json$/i.test(fileName);
}
