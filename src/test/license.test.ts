import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVATE_PATH,
  BUY_ACTION,
  DODO_BASE_URL,
  DODO_LIVE_BASE_URL,
  DODO_LIVE_CHECKOUT_URL,
  DODO_TEST_BASE_URL,
  DODO_TEST_CHECKOUT_URL,
  LICENSE_HEADERS,
  PRODUCT_URL,
  proDialogActions,
  REVALIDATE_AFTER_MS,
  VALIDATE_PATH,
  activateLicense,
  buildLicenseRequest,
  errorMessage,
  isProState,
  licenseStateOf,
  validateLicense,
  type PostJson,
  type TransportResult
} from '../licenseApi';

const KEY = 'PRO-AAAA-BBBB-CCCC-DDDD';
const INSTANCE = 'lki_123';

interface Call {
  url: string;
  body: unknown;
  timeoutMs: number;
}

/** A transport that records what it was asked to send and replies as told. */
function recording(...replies: TransportResult[]): { post: PostJson; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const post: PostJson = async (url, body, timeoutMs) => {
    calls.push({ url, body, timeoutMs });
    return replies[Math.min(index++, replies.length - 1)];
  };
  return { post, calls };
}

function ok(status: number, payload: unknown): TransportResult {
  return { transport: 'response', status, bodyText: JSON.stringify(payload) };
}

// ---------------------------------------------------------------------------
// Request building — including the constraint that no credential is ever sent.
// ---------------------------------------------------------------------------

test('the base URL is a single named constant, flippable between test and live', () => {
  assert.equal(DODO_TEST_BASE_URL, 'https://test.dodopayments.com');
  assert.equal(DODO_LIVE_BASE_URL, 'https://live.dodopayments.com');
  assert.ok(
    DODO_BASE_URL === DODO_TEST_BASE_URL || DODO_BASE_URL === DODO_LIVE_BASE_URL,
    'DODO_BASE_URL must be one of the two documented environment URLs'
  );
});

test('no license request ever carries an authorization header', () => {
  for (const path of [ACTIVATE_PATH, VALIDATE_PATH]) {
    const { init } = buildLicenseRequest(DODO_BASE_URL, path, { license_key: KEY });

    // Exactly two headers, and neither of them is a credential. These
    // endpoints are public by design; an API key here would be shipped to
    // every user inside the .vsix.
    assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'content-type']);
    for (const name of Object.keys(init.headers)) {
      assert.doesNotMatch(name.toLowerCase(), /auth|api[-_]?key|token|secret|bearer/);
    }
    for (const value of Object.values(init.headers)) {
      assert.doesNotMatch(value.toLowerCase(), /bearer|sk_|api[-_]?key/);
    }
  }
  assert.deepEqual(Object.keys(LICENSE_HEADERS).sort(), ['accept', 'content-type']);
});

test('request URLs are built from the base URL without doubling slashes', () => {
  assert.equal(
    buildLicenseRequest('https://test.dodopayments.com/', ACTIVATE_PATH, {}).url,
    'https://test.dodopayments.com/licenses/activate'
  );
  assert.equal(
    buildLicenseRequest('https://live.dodopayments.com', VALIDATE_PATH, {}).url,
    'https://live.dodopayments.com/licenses/validate'
  );
});

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

test('activation posts the documented body and returns the instance id', async () => {
  const { post, calls } = recording(ok(200, { id: INSTANCE, business_id: 'biz_1' }));

  const outcome = await activateLicense(KEY, 'local-api-check abc-123', { post });

  assert.deepEqual(outcome, { kind: 'activated', instanceId: INSTANCE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DODO_BASE_URL}/licenses/activate`);
  // Exactly the two documented fields, and the name is the per-install id.
  assert.deepEqual(calls[0].body, {
    license_key: KEY,
    name: 'local-api-check abc-123'
  });
});

test('a rejected activation surfaces the real server message, not a generic one', async () => {
  const { post } = recording(
    ok(422, { message: 'license key has reached its activation limit' })
  );

  const outcome = await activateLicense(KEY, 'install-1', { post });

  assert.equal(outcome.kind, 'rejected');
  assert.ok(outcome.kind === 'rejected');
  assert.equal(outcome.status, 422);
  assert.equal(outcome.message, 'license key has reached its activation limit');
});

test('a 2xx activation with no instance id is treated as unreachable, not as success', async () => {
  const { post } = recording(ok(200, { business_id: 'biz_1' }));

  const outcome = await activateLicense(KEY, 'install-1', { post });

  // Storing a key with no instance id would leave it permanently unvalidatable.
  assert.equal(outcome.kind, 'unreachable');
  assert.ok(outcome.kind === 'unreachable');
  assert.equal(outcome.reason, 'malformed');
});

test('activation reports a timeout as a transport failure, not as a bad key', async () => {
  const { post } = recording({ transport: 'timeout', message: 'timed out after 10000 ms' });

  const outcome = await activateLicense(KEY, 'install-1', { post });

  assert.equal(outcome.kind, 'unreachable');
  assert.ok(outcome.kind === 'unreachable');
  assert.equal(outcome.reason, 'timeout');
});

// ---------------------------------------------------------------------------
// Validation — the fail-open contract
// ---------------------------------------------------------------------------

test('validation posts the key and the instance id when one is stored', async () => {
  const { post, calls } = recording(ok(200, { valid: true }));

  const outcome = await validateLicense(KEY, INSTANCE, { post });

  assert.deepEqual(outcome, { kind: 'valid' });
  assert.equal(calls[0].url, `${DODO_BASE_URL}/licenses/validate`);
  assert.deepEqual(calls[0].body, {
    license_key: KEY,
    license_key_instance_id: INSTANCE
  });
});

test('validation omits the instance id when there is none', async () => {
  const { post, calls } = recording(ok(200, { valid: true }));

  await validateLicense(KEY, undefined, { post });

  assert.deepEqual(calls[0].body, { license_key: KEY });
});

test('an explicit valid:false is the only outcome that revokes', async () => {
  const { post } = recording(ok(200, { valid: false }));

  assert.deepEqual(await validateLicense(KEY, INSTANCE, { post }), { kind: 'invalid' });
});

test('fail open: a network error leaves the licence undecided', async () => {
  const { post } = recording({
    transport: 'network',
    message: 'fetch failed (ENOTFOUND test.dodopayments.com)'
  });

  const outcome = await validateLicense(KEY, INSTANCE, { post });

  assert.equal(outcome.kind, 'unreachable');
  assert.ok(outcome.kind === 'unreachable');
  assert.equal(outcome.reason, 'network');
  assert.notEqual(outcome.kind, 'invalid');
});

test('fail open: a timeout leaves the licence undecided', async () => {
  const { post } = recording({ transport: 'timeout', message: 'timed out after 10000 ms' });

  const outcome = await validateLicense(KEY, INSTANCE, { post });

  assert.equal(outcome.kind, 'unreachable');
  assert.ok(outcome.kind === 'unreachable');
  assert.equal(outcome.reason, 'timeout');
});

test('fail open: a malformed 200 body leaves the licence undecided', async () => {
  for (const body of ['not json at all', '{"valid":"yes"}', '{}', '[]']) {
    const outcome = await validateLicense(KEY, INSTANCE, {
      post: async () => ({ transport: 'response', status: 200, bodyText: body })
    });

    assert.equal(
      outcome.kind,
      'unreachable',
      `body ${JSON.stringify(body)} must not be read as a verdict`
    );
    assert.ok(outcome.kind === 'unreachable');
    assert.equal(outcome.reason, 'malformed');
  }
});

test('fail open: a 5xx (and a 404) leaves the licence undecided', async () => {
  for (const status of [404, 500, 502, 503]) {
    const { post } = recording(ok(status, { message: 'upstream unavailable' }));

    const outcome = await validateLicense(KEY, INSTANCE, { post });

    assert.equal(outcome.kind, 'unreachable', `HTTP ${status} must not revoke a licence`);
    assert.ok(outcome.kind === 'unreachable');
    assert.equal(outcome.reason, 'http');
    assert.match(outcome.message, new RegExp(`HTTP ${status}`));
  }
});

test('the revalidation window is 21 days', () => {
  assert.equal(REVALIDATE_AFTER_MS, 21 * 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// The purchase link
// ---------------------------------------------------------------------------

test('the checkout link matches the mode the extension is pointed at', () => {
  // The failure this guards against is a test-mode checkout URL surviving into
  // a live build, which would send real buyers somewhere that cannot sell.
  if (DODO_BASE_URL === DODO_TEST_BASE_URL) {
    assert.equal(PRODUCT_URL, DODO_TEST_CHECKOUT_URL);
    assert.match(PRODUCT_URL ?? '', /^https:\/\/test\.checkout\.dodopayments\.com\//);
  } else {
    assert.equal(PRODUCT_URL, DODO_LIVE_CHECKOUT_URL);
    assert.ok(
      PRODUCT_URL === undefined || !PRODUCT_URL.includes('test.checkout.'),
      'a live build must never offer a test-mode checkout link'
    );
  }
});

test('the checkout link is a well-formed URL for the product Part A created', () => {
  assert.ok(PRODUCT_URL, 'no product URL is configured');
  const url = new URL(PRODUCT_URL);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/buy/pdt_0Nn9ZzwF0EAOFP3q3Pooh');
  assert.equal(url.searchParams.get('quantity'), '1');
});

test('the purchase button appears only when there is somewhere to buy', () => {
  assert.deepEqual(proDialogActions('https://example.test/buy/x'), [BUY_ACTION]);
  assert.deepEqual(proDialogActions(undefined), []);
});

const NOW = Date.UTC(2026, 8, 8);

test('no stored key means the free tier', () => {
  const state = licenseStateOf({ hasKey: false, revoked: false, now: NOW });
  assert.equal(state, 'free');
  assert.equal(isProState(state), false);
});

test('a key confirmed inside the window is Pro', () => {
  const state = licenseStateOf({
    hasKey: true,
    revoked: false,
    lastValidatedAt: NOW - 20 * 24 * 60 * 60 * 1000,
    now: NOW
  });
  assert.equal(state, 'pro');
  assert.equal(isProState(state), true);
});

test('past the window the licence is unconfirmed — and still unlocked', () => {
  const state = licenseStateOf({
    hasKey: true,
    revoked: false,
    lastValidatedAt: NOW - 22 * 24 * 60 * 60 * 1000,
    now: NOW
  });
  assert.equal(state, 'unconfirmed');
  // The point of the whole design: an overdue check never locks a paying user out.
  assert.equal(isProState(state), true);
});

test('the 21-day boundary is exact', () => {
  const justInside = licenseStateOf({
    hasKey: true,
    revoked: false,
    lastValidatedAt: NOW - (REVALIDATE_AFTER_MS - 1),
    now: NOW
  });
  const justOutside = licenseStateOf({
    hasKey: true,
    revoked: false,
    lastValidatedAt: NOW - REVALIDATE_AFTER_MS,
    now: NOW
  });
  assert.equal(justInside, 'pro');
  assert.equal(justOutside, 'unconfirmed');
});

test('a key that was never confirmed is unconfirmed, not free and not revoked', () => {
  assert.equal(licenseStateOf({ hasKey: true, revoked: false, now: NOW }), 'unconfirmed');
});

test('only an explicit revocation locks Pro', () => {
  const state = licenseStateOf({
    hasKey: true,
    revoked: true,
    lastValidatedAt: NOW - 1000,
    now: NOW
  });
  assert.equal(state, 'revoked');
  assert.equal(isProState(state), false);
});

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

test('server error messages are dug out of whichever field carries them', () => {
  const cases: Array<[unknown, string]> = [
    [{ message: 'invalid license key' }, 'invalid license key'],
    [{ error: 'key not found' }, 'key not found'],
    [{ detail: 'activation limit reached' }, 'activation limit reached'],
    [{ error: { message: 'nested explanation' } }, 'nested explanation']
  ];
  for (const [payload, expected] of cases) {
    const bodyText = JSON.stringify(payload);
    assert.equal(
      errorMessage(payload as Record<string, unknown>, { status: 422, bodyText }),
      expected
    );
  }
});

test('an unrecognisable error body falls back to the raw text, then to the status', () => {
  assert.equal(errorMessage(undefined, { status: 500, bodyText: 'Internal Server Error' }), 'Internal Server Error');
  assert.equal(errorMessage(undefined, { status: 503, bodyText: '   ' }), 'HTTP 503');
  const long = 'x'.repeat(400);
  const truncated = errorMessage(undefined, { status: 500, bodyText: long });
  assert.equal(truncated.length, 301);
  assert.ok(truncated.endsWith('…'));
});
