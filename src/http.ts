/**
 * HTTP execution. Uses the Node runtime's native `fetch` — no dependencies,
 * no proxy service, nothing but the request the user wrote.
 *
 * `vscode`-free so it stays unit-testable.
 */

export interface PreparedRequest {
  name: string;
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  body?: string;
}

export interface HttpResponse {
  /** False when the request never completed (DNS failure, timeout, bad URL). */
  completed: boolean;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyText: string;
  durationMs: number;
  /** Set when `completed` is false. */
  error?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export async function sendHttpRequest(
  request: PreparedRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<HttpResponse> {
  const started = Date.now();

  const urlError = validateUrl(request.url);
  if (urlError) {
    return {
      completed: false,
      status: 0,
      statusText: '',
      headers: [],
      bodyText: '',
      durationMs: 0,
      error: urlError
    };
  }

  const headers = new Headers();
  for (const header of request.headers) {
    headers.append(header.name, header.value);
  }

  const method = request.method.toUpperCase();
  const hasBody = request.body !== undefined && !BODYLESS_METHODS.has(method);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(request.url, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'follow',
      signal: controller.signal
    });

    const bodyText = await response.text();
    const responseHeaders: Array<[string, string]> = [];
    response.headers.forEach((value, key) => {
      responseHeaders.push([key, value]);
    });

    return {
      completed: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      bodyText,
      durationMs: Date.now() - started
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const aborted = controller.signal.aborted;
    return {
      completed: false,
      status: 0,
      statusText: '',
      headers: [],
      bodyText: '',
      durationMs,
      error: aborted ? `Request timed out after ${timeoutMs} ms` : describeError(err)
    };
  } finally {
    clearTimeout(timer);
  }
}

export function validateUrl(url: string): string | undefined {
  if (url.trim().length === 0) {
    return 'No URL in this request block.';
  }
  const unresolved = /\{\{\s*([^}]+?)\s*\}\}/.exec(url);
  if (unresolved) {
    return `Unresolved variable {{${unresolved[1]}}} in the URL.`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Not a valid absolute URL: "${url}"`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported protocol "${parsed.protocol}" — only http and https are supported.`;
  }
  return undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // fetch wraps the useful detail (ENOTFOUND, ECONNREFUSED) in `cause`.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && cause.message !== err.message) {
      return `${err.message} (${cause.message})`;
    }
    return err.message;
  }
  return String(err);
}
