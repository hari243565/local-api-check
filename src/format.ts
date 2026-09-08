/**
 * Pure formatting helpers for the output channel. No `vscode` imports.
 */

import type { HttpResponse, PreparedRequest } from './http';

const MAX_BODY_CHARS = 100_000;

export function formatRequestHeading(request: PreparedRequest, envName?: string): string[] {
  const stamp = new Date().toLocaleTimeString();
  const env = envName ? `  [env: ${envName}]` : '';
  return [
    '',
    '─'.repeat(72),
    `${request.name}${env}`,
    `${request.method.toUpperCase()} ${request.url}`,
    `${stamp}`,
    '─'.repeat(72)
  ];
}

export function formatResponse(response: HttpResponse): string[] {
  if (!response.completed) {
    return [`✗ Request failed: ${response.error ?? 'unknown error'}`, ''];
  }

  const lines: string[] = [];
  lines.push(
    `${response.status} ${response.statusText}`.trim() + `  (${response.durationMs} ms)`
  );

  if (response.headers.length > 0) {
    lines.push('');
    for (const [name, value] of response.headers) {
      lines.push(`${name}: ${value}`);
    }
  }

  lines.push('');
  lines.push(...formatBody(response));
  lines.push('');
  return lines;
}

export function formatBody(response: HttpResponse): string[] {
  if (response.bodyText.length === 0) {
    return ['(empty body)'];
  }
  const truncated = response.bodyText.length > MAX_BODY_CHARS;
  const raw = truncated ? response.bodyText.slice(0, MAX_BODY_CHARS) : response.bodyText;
  const pretty = tryPrettyJson(raw) ?? raw;
  const lines = pretty.split('\n');
  if (truncated) {
    lines.push(
      `… (body truncated at ${MAX_BODY_CHARS.toLocaleString()} characters of ${response.bodyText.length.toLocaleString()})`
    );
  }
  return lines;
}

export function tryPrettyJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), undefined, 2);
  } catch {
    return undefined;
  }
}

/** Single-line preview of a value, for assertion failure messages. */
export function previewValue(value: unknown, maxLength = 120): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
