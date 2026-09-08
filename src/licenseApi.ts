/**
 * Dodo Payments license API — request building and response interpretation.
 *
 * Deliberately `vscode`-free and transport-injectable, so every branch below
 * (including the failure branches, which are the ones that actually decide
 * whether a paying user keeps access) is unit-testable with no network.
 *
 * Both endpoints used here are PUBLIC and unauthenticated by design:
 *   POST /licenses/activate  { license_key, name }                     -> { id, ... }
 *   POST /licenses/validate  { license_key, license_key_instance_id }  -> { valid }
 *
 * No API key is sent, stored, or bundled — see `buildLicenseRequest`, which is
 * the single place headers are constructed and is asserted header-by-header in
 * the unit suite. If a change here ever needs an Authorization header, that is
 * a design error: the key would ship inside every user .vsix.
 */

export const DODO_TEST_BASE_URL = 'https://test.dodopayments.com';
export const DODO_LIVE_BASE_URL = 'https://live.dodopayments.com';

/**
 * The one constant to flip when the Dodo account moves from test to live mode.
 * Nothing else in the codebase hardcodes a Dodo host.
 */
export const DODO_BASE_URL = DODO_TEST_BASE_URL;

/**
 * Public product page, filled in once the Dodo product exists. Until then the
 * upsell explains Pro without pretending there is somewhere to buy it.
 */
export const PRODUCT_URL: string | undefined = undefined;

/** License calls are short; a slow one must never stall extension activation. */
export const LICENSE_TIMEOUT_MS = 10_000;

/** A confirmed license is not re-checked again until this much time has passed. */
export const REVALIDATE_AFTER_MS = 21 * 24 * 60 * 60 * 1000;

export const ACTIVATE_PATH = '/licenses/activate';
export const VALIDATE_PATH = '/licenses/validate';

/** Why a call produced no usable answer. Never conflated with "invalid". */
export type UnreachableReason = 'timeout' | 'network' | 'http' | 'malformed';

export type TransportResult =
  | { transport: 'response'; status: number; bodyText: string }
  | { transport: 'timeout'; message: string }
  | { transport: 'network'; message: string };

/** The seam the unit suite and the integration suite substitute. */
export type PostJson = (
  url: string,
  body: unknown,
  timeoutMs: number
) => Promise<TransportResult>;

export interface LicenseHttpRequest {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  };
}

/**
 * Every header sent to Dodo, in one place. Exactly these two: a public
 * endpoint takes no credentials, and there is nowhere else to add one.
 */
export const LICENSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  accept: 'application/json'
});

/**
 * Builds the exact HTTP request sent to Dodo. Kept separate from sending so a
 * test can assert the URL, the body and — critically — the complete header set.
 */
export function buildLicenseRequest(
  baseUrl: string,
  path: string,
  body: unknown
): LicenseHttpRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, '')}${path}`,
    init: {
      method: 'POST',
      headers: { ...LICENSE_HEADERS },
      body: JSON.stringify(body)
    }
  };
}

/** The real transport. Mirrors http.ts: abortable, and never throws. */
export async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<TransportResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...LICENSE_HEADERS },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return {
      transport: 'response',
      status: response.status,
      bodyText: await response.text()
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return { transport: 'timeout', message: `timed out after ${timeoutMs} ms` };
    }
    return { transport: 'network', message: describe(err) };
  } finally {
    clearTimeout(timer);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && cause.message !== err.message) {
      return `${err.message} (${cause.message})`;
    }
    return err.message;
  }
  return String(err);
}

export interface LicenseDeps {
  post: PostJson;
  baseUrl?: string;
  timeoutMs?: number;
}

export type ActivationOutcome =
  /** Dodo accepted the key and returned an instance id. */
  | { kind: 'activated'; instanceId: string }
  /** Dodo answered and said no — bad key, activation limit reached, etc. */
  | { kind: 'rejected'; status: number; message: string }
  /** No answer. Says nothing about whether the key is valid. */
  | { kind: 'unreachable'; reason: UnreachableReason; message: string };

export type ValidationOutcome =
  | { kind: 'valid' }
  /** The one and only thing that revokes Pro locally: an explicit valid:false. */
  | { kind: 'invalid' }
  | { kind: 'unreachable'; reason: UnreachableReason; message: string };

/** POST /licenses/activate. `instanceName` is a per-install id, never a hostname. */
export async function activateLicense(
  licenseKey: string,
  instanceName: string,
  deps: LicenseDeps
): Promise<ActivationOutcome> {
  const { url } = buildLicenseRequest(deps.baseUrl ?? DODO_BASE_URL, ACTIVATE_PATH, {});
  const result = await deps.post(
    url,
    { license_key: licenseKey, name: instanceName },
    deps.timeoutMs ?? LICENSE_TIMEOUT_MS
  );

  if (result.transport !== 'response') {
    return { kind: 'unreachable', reason: result.transport, message: result.message };
  }

  const parsed = parseJson(result.bodyText);

  if (result.status >= 200 && result.status < 300) {
    const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
    if (id.length === 0) {
      // A 2xx with no instance id is not an activation, and pretending it is
      // would store a key that can never be validated afterwards.
      return {
        kind: 'unreachable',
        reason: 'malformed',
        message: 'the licence server returned no activation id'
      };
    }
    return { kind: 'activated', instanceId: id };
  }

  // The user needs the actual words from the server here, not a house style
  // message that hides whether the key was wrong or simply used up.
  return { kind: 'rejected', status: result.status, message: errorMessage(parsed, result) };
}

/** POST /licenses/validate. Fails open on anything that is not an explicit no. */
export async function validateLicense(
  licenseKey: string,
  instanceId: string | undefined,
  deps: LicenseDeps
): Promise<ValidationOutcome> {
  const { url } = buildLicenseRequest(deps.baseUrl ?? DODO_BASE_URL, VALIDATE_PATH, {});
  const body: Record<string, string> = { license_key: licenseKey };
  if (instanceId) {
    body.license_key_instance_id = instanceId;
  }

  const result = await deps.post(url, body, deps.timeoutMs ?? LICENSE_TIMEOUT_MS);

  if (result.transport !== 'response') {
    return { kind: 'unreachable', reason: result.transport, message: result.message };
  }
  if (result.status < 200 || result.status >= 300) {
    const parsed = parseJson(result.bodyText);
    return {
      kind: 'unreachable',
      reason: 'http',
      message: `HTTP ${result.status}: ${errorMessage(parsed, result)}`
    };
  }

  const parsed = parseJson(result.bodyText);
  if (typeof parsed?.valid !== 'boolean') {
    return {
      kind: 'unreachable',
      reason: 'malformed',
      message: 'the licence server returned no "valid" field'
    };
  }
  return parsed.valid ? { kind: 'valid' } : { kind: 'invalid' };
}

export type LicenseState =
  /** No key stored. Everything in the free tier is still fully available. */
  | 'free'
  /** Key stored and confirmed within the revalidation window. */
  | 'pro'
  /** Key stored, but not confirmed lately. Stays unlocked — this is fail-open. */
  | 'unconfirmed'
  /** The licence server explicitly answered valid:false. The only lock-out. */
  | 'revoked';

export interface LicenseFacts {
  hasKey: boolean;
  revoked: boolean;
  lastValidatedAt?: number;
  /** Injectable so the 21-day boundary is testable without waiting three weeks. */
  now?: number;
}

/**
 * The whole entitlement decision, as a pure function of stored facts.
 *
 * Kept `vscode`-free on purpose: this is the rule that decides whether a
 * paying customer keeps access, so it is unit-tested at every boundary rather
 * than inferred from the behaviour of the surrounding class.
 */
export function licenseStateOf(facts: LicenseFacts): LicenseState {
  if (!facts.hasKey) {
    return 'free';
  }
  if (facts.revoked) {
    return 'revoked';
  }
  const now = facts.now ?? Date.now();
  if (facts.lastValidatedAt !== undefined && now - facts.lastValidatedAt < REVALIDATE_AFTER_MS) {
    return 'pro';
  }
  // A stored key that has not been confirmed lately still works. Losing access
  // because a check could not be made is the failure mode this design exists
  // to prevent.
  return 'unconfirmed';
}

/** Whether a state unlocks the paid features. */
export function isProState(state: LicenseState): boolean {
  return state === 'pro' || state === 'unconfirmed';
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const ERROR_FIELDS = ['message', 'error', 'detail', 'error_description'];

/** Digs the explanation from the server out of an error body. */
export function errorMessage(
  parsed: Record<string, unknown> | undefined,
  result: { status: number; bodyText: string }
): string {
  for (const field of ERROR_FIELDS) {
    const value = parsed?.[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    // Some APIs nest, e.g. { error: { message: "..." } }.
    if (value !== null && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).message;
      if (typeof nested === 'string' && nested.trim().length > 0) {
        return nested.trim();
      }
    }
  }
  const raw = result.bodyText.trim();
  if (raw.length > 0) {
    return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  }
  return `HTTP ${result.status}`;
}
