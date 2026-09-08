/**
 * Parser for `.api` files.
 *
 * Deliberately free of any `vscode` imports so it can be unit-tested with
 * plain node:test. Line numbers are 0-based to match the VS Code API.
 *
 * Format:
 *
 *   ### Get user profile
 *   GET {{base_url}}/users/{{user_id}}
 *   Authorization: Bearer {{auth_token}}
 *
 *   { "optional": "json body" }
 *
 *   expect:
 *     status: 200
 *     json_has: ["id", "email"]
 */

export interface HeaderEntry {
  name: string;
  value: string;
  /** 0-based line the header sits on. */
  line: number;
}

export interface ExpectBlock {
  status?: number;
  /** Keys that must exist in the JSON response body. Dot paths allowed: `data.id`. */
  jsonHas: string[];
  /** 0-based line of the `expect:` keyword. */
  line: number;
}

export interface ParseIssue {
  message: string;
  line: number;
}

export interface RequestBlock {
  /** Name from the `### <name>` header, or a generated fallback. */
  name: string;
  method: string;
  url: string;
  headers: HeaderEntry[];
  /** Raw request body, blank padding trimmed. Undefined when there is none. */
  body?: string;
  expect?: ExpectBlock;
  /** 0-based line of the `###` header. */
  headerLine: number;
  /** 0-based line of the `METHOD URL` line. */
  requestLine: number;
  /** 0-based line of the last line belonging to this block. */
  endLine: number;
  /** Line of the body's first line, when there is a body. */
  bodyLine?: number;
  issues: ParseIssue[];
}

export interface ParsedApiFile {
  requests: RequestBlock[];
  /** Issues not tied to a specific request block. */
  issues: ParseIssue[];
}

const KNOWN_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE'
];

const HEADER_RE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s?(.*)$/;
const BLOCK_RE = /^###+\s*(.*)$/;
const EXPECT_RE = /^expect\s*:\s*$/i;

/** True for a `#` comment line that is not a `###` block header. */
function isComment(line: string): boolean {
  return /^#/.test(line) && !BLOCK_RE.test(line);
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

export function parseApiFile(text: string): ParsedApiFile {
  const lines = text.split(/\r?\n/);
  const requests: RequestBlock[] = [];
  const issues: ParseIssue[] = [];

  // Index every block header first; each block runs until the next header.
  const headerIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (BLOCK_RE.test(lines[i])) {
      headerIndexes.push(i);
    }
  }

  for (let i = 0; i < headerIndexes.length; i++) {
    const start = headerIndexes[i];
    const end = i + 1 < headerIndexes.length ? headerIndexes[i + 1] - 1 : lines.length - 1;
    requests.push(parseBlock(lines, start, end, requests.length));
  }

  // Content before the first `###` that isn't blank or a comment is a mistake
  // worth pointing out — it is silently ignored otherwise.
  const firstHeader = headerIndexes.length > 0 ? headerIndexes[0] : lines.length;
  for (let i = 0; i < firstHeader; i++) {
    if (!isBlank(lines[i]) && !isComment(lines[i])) {
      issues.push({
        line: i,
        message: 'Content outside a request block is ignored. Requests start with `### <name>`.'
      });
      break;
    }
  }

  return { requests, issues };
}

function parseBlock(
  lines: string[],
  start: number,
  end: number,
  index: number
): RequestBlock {
  const blockIssues: ParseIssue[] = [];
  const nameMatch = BLOCK_RE.exec(lines[start]);
  const rawName = (nameMatch?.[1] ?? '').trim();
  const name = rawName.length > 0 ? rawName : `Request ${index + 1}`;

  let i = start + 1;

  // Skip blank lines and comments ahead of the request line.
  while (i <= end && (isBlank(lines[i]) || isComment(lines[i]))) {
    i++;
  }

  if (i > end) {
    blockIssues.push({ line: start, message: `Request "${name}" has no request line.` });
    return {
      name,
      method: 'GET',
      url: '',
      headers: [],
      headerLine: start,
      requestLine: start,
      endLine: end,
      issues: blockIssues
    };
  }

  const requestLine = i;
  const parsedLine = parseRequestLine(lines[i], i);
  if (parsedLine.issue) {
    blockIssues.push(parsedLine.issue);
  }
  i++;

  // Headers: contiguous `Name: value` lines directly after the request line.
  const headers: HeaderEntry[] = [];
  while (i <= end) {
    const line = lines[i];
    if (isBlank(line)) {
      break;
    }
    if (isComment(line)) {
      i++;
      continue;
    }
    if (EXPECT_RE.test(line)) {
      break;
    }
    const m = HEADER_RE.exec(line);
    if (!m) {
      break;
    }
    headers.push({ name: m[1], value: m[2].trim(), line: i });
    i++;
  }

  // Body: everything up to `expect:` or the end of the block.
  const bodyLines: string[] = [];
  let bodyStart = -1;
  let expectLine = -1;
  while (i <= end) {
    if (EXPECT_RE.test(lines[i])) {
      expectLine = i;
      break;
    }
    if (bodyStart === -1 && !isBlank(lines[i])) {
      bodyStart = i;
    }
    bodyLines.push(lines[i]);
    i++;
  }

  let body: string | undefined;
  let bodyLine: number | undefined;
  const trimmedBody = trimBlankEdges(bodyLines);
  if (trimmedBody.length > 0) {
    body = trimmedBody.join('\n');
    bodyLine = bodyStart >= 0 ? bodyStart : undefined;
  }

  let expect: ExpectBlock | undefined;
  if (expectLine >= 0) {
    expect = parseExpect(lines, expectLine, end, blockIssues);
  }

  return {
    name,
    method: parsedLine.method,
    url: parsedLine.url,
    headers,
    body,
    expect,
    headerLine: start,
    requestLine,
    endLine: end,
    bodyLine,
    issues: blockIssues
  };
}

function parseRequestLine(
  line: string,
  lineNumber: number
): { method: string; url: string; issue?: ParseIssue } {
  const trimmed = line.trim();
  const parts = trimmed.split(/\s+/);
  const first = parts[0]?.toUpperCase() ?? '';

  if (KNOWN_METHODS.includes(first)) {
    const url = parts
      .slice(1)
      .filter((p) => !/^HTTP\/[\d.]+$/i.test(p))
      .join(' ');
    if (url.length === 0) {
      return {
        method: first,
        url: '',
        issue: { line: lineNumber, message: `Missing URL after ${first}.` }
      };
    }
    return { method: first, url };
  }

  // No recognised method — treat the whole line as a URL and default to GET.
  return { method: 'GET', url: trimmed };
}

function parseExpect(
  lines: string[],
  expectLine: number,
  end: number,
  blockIssues: ParseIssue[]
): ExpectBlock {
  const expect: ExpectBlock = { jsonHas: [], line: expectLine };

  for (let i = expectLine + 1; i <= end; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) {
      continue;
    }
    // The expect block ends at the first line that isn't indented.
    if (!/^\s/.test(line)) {
      break;
    }
    const m = HEADER_RE.exec(line.trim());
    if (!m) {
      blockIssues.push({ line: i, message: `Unrecognised expect entry: "${line.trim()}"` });
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === 'status') {
      const status = Number.parseInt(value, 10);
      if (Number.isNaN(status)) {
        blockIssues.push({ line: i, message: `expect.status must be a number, got "${value}".` });
      } else {
        expect.status = status;
      }
    } else if (key === 'json_has') {
      const keys = parseStringList(value);
      if (keys.length === 0) {
        blockIssues.push({ line: i, message: 'expect.json_has needs at least one key.' });
      }
      expect.jsonHas.push(...keys);
    } else {
      blockIssues.push({
        line: i,
        message: `Unknown expectation "${m[1]}". Supported: status, json_has.`
      });
    }
  }

  return expect;
}

/** Accepts `["a", "b"]` and the looser `a, b`. */
export function parseStringList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v)).filter((v) => v.length > 0);
      }
    } catch {
      // Fall through to the looser comma-separated form below.
    }
  }
  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter((part) => part.length > 0);
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) {
    start++;
  }
  while (end > start && isBlank(lines[end - 1])) {
    end--;
  }
  return lines.slice(start, end);
}
