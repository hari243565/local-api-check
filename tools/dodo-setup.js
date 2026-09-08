/**
 * One-off Dodo Payments product setup. NOT part of the extension.
 *
 * This is the only place an API key is ever used, and it is read at run time
 * from a file path you pass in — never hardcoded, never committed, and this
 * whole directory is excluded from the packaged .vsix by .vscodeignore.
 *
 * It creates, in order:
 *   1. a License Key entitlement with automatic fulfillment  (POST /entitlements)
 *   2. a one-time payment product                            (POST /products)
 *   3. the link between them                                 (PATCH /products/{id})
 *
 * Usage:
 *   node tools/dodo-setup.js --key-file <path-to-file-containing-the-test-key>
 *
 * Options:
 *   --price <cents>      default 2400 ($24.00)
 *   --currency <code>    default USD
 *   --tax-category <c>   default digital_products
 *   --activations <n>    default 5
 *   --live               target live mode instead of test mode
 *   --dry-run            print what would be sent, send nothing
 */
const fs = require('fs');

const TEST_BASE_URL = 'https://test.dodopayments.com';
const LIVE_BASE_URL = 'https://live.dodopayments.com';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const options = {
  keyFile: arg('key-file'),
  price: Number(arg('price', '2400')),
  currency: arg('currency', 'USD'),
  taxCategory: arg('tax-category', 'digital_products'),
  activations: Number(arg('activations', '5')),
  baseUrl: flag('live') ? LIVE_BASE_URL : TEST_BASE_URL,
  dryRun: flag('dry-run')
};

if (!options.keyFile) {
  console.error('dodo-setup: --key-file <path> is required.');
  process.exit(2);
}

function readApiKey() {
  const raw = fs.readFileSync(options.keyFile, 'utf8').trim();
  if (raw.length === 0) {
    throw new Error(`${options.keyFile} is empty`);
  }
  return raw;
}

/** Never logs the key, and never echoes a response header. */
async function call(method, path, body, apiKey) {
  const url = `${options.baseUrl}${path}`;
  if (options.dryRun) {
    console.log(`[dry-run] ${method} ${url}\n${JSON.stringify(body, undefined, 2)}`);
    return { dryRun: true, id: `would-be-created-by-${method}-${path}` };
  }

  const response = await fetch(url, {
    method,
    headers: {
      // The one and only place a Dodo API key is used. It lives in this
      // process for the length of this script and nowhere else.
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    throw new Error(`${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  return parsed ?? {};
}

async function main() {
  const apiKey = readApiKey();
  console.log(
    `dodo-setup: ${options.dryRun ? 'DRY RUN against' : 'targeting'} ${options.baseUrl}\n`
  );

  // 1. The entitlement that actually issues keys. Automatic fulfillment means
  //    Dodo generates and emails the key on payment, with nothing to run.
  const entitlementBody = {
    name: 'Local API Check Pro License',
    description: 'Unlocks the pass/fail check system in the Local API Check VS Code extension.',
    integration_type: 'license_key',
    integration_config: {
      fulfillment_mode: 'auto',
      activations_limit: options.activations
      // No duration fields: a one-time purchase should not expire.
    }
  };
  const entitlement = await call('POST', '/entitlements', entitlementBody, apiKey);
  console.log(`1/3 entitlement created: ${entitlement.id ?? '(no id returned)'}`);

  // 2. The product itself. Price and name are dashboard-editable afterwards.
  const productBody = {
    name: 'Local API Check — Pro License',
    description:
      'One-time licence for Local API Check Pro: expect: blocks, Run Check, and Run All Checks in File and Workspace.',
    tax_category: options.taxCategory,
    price: {
      type: 'one_time_price',
      price: options.price,
      currency: options.currency,
      discount: 0,
      pay_what_you_want: false,
      purchasing_power_parity: false,
      tax_inclusive: false
    }
  };
  const product = await call('POST', '/products', productBody, apiKey);
  const productId = product.product_id ?? product.id;
  console.log(`2/3 product created: ${productId ?? '(no id returned)'}`);

  // 3. Attach. `entitlements` replaces the whole set, which is what we want on
  //    a product that has just been created.
  if (!options.dryRun) {
    await call(
      'PATCH',
      `/products/${productId}`,
      { entitlements: [{ entitlement_id: entitlement.id }] },
      apiKey
    );
  }
  console.log('3/3 entitlement attached to the product\n');

  console.log('Done. Record these:');
  console.log(`  entitlement_id : ${entitlement.id ?? '(dry run)'}`);
  console.log(`  product_id     : ${productId ?? '(dry run)'}`);
  console.log(
    '\nNext: copy the product/checkout link from the Dodo dashboard into PRODUCT_URL in src/licenseApi.ts.'
  );
}

main().catch((err) => {
  console.error(`dodo-setup: ${err.message}`);
  process.exit(1);
});
