# Manual purchase checklist — Dodo test mode

Everything else in Phase 2 is proven by an automated test. This is the one thing no automated
test can prove: that a real purchase produces a real key that really unlocks Pro. It needs to be
run by hand, once, in Dodo **test mode**, before this ever goes live.

Budget about ten minutes. Nothing here costs real money — test mode uses test cards.

## What Part A created (test mode, 2026-09-08)

| | |
|---|---|
| Product | `pdt_0Nn9ZzwF0EAOFP3q3Pooh` — "Local API Check — Pro License", $24.00 USD one-time, `digital_products` |
| Entitlement | `ent_0Nn9ZzuMdkI1g94JKIo2X` — License Key, `fulfillment_mode: auto`, 5 activations, no expiry |
| Verified | Read back from `GET /products/{id}`: entitlement attached, `is_recurring: false`, legacy `license_key_enabled: false` |

Both live in **test mode** (`https://test.dodopayments.com`). Nothing here has been created in live mode.

## Before you start

- [ ] Part A has been run, so the product and its License Key entitlement exist in the Dodo dashboard.
- [ ] `DODO_BASE_URL` in `src/licenseApi.ts` is `DODO_TEST_BASE_URL`. If it has been flipped to live,
      flip it back before testing, or the key you buy in test mode will not validate.
- [ ] Install the built extension into a real VS Code:
      `npm run vsix` then `code --install-extension local-api-check-0.1.0.vsix`
- [ ] Open a folder with at least one `.api` file containing an `expect:` block.

## 1. Confirm the free tier is intact

- [ ] Run **Local API Check: License Status**. It says **Free tier**.
- [ ] Send a request from the `▶ Send Request` CodeLens. It works, with no prompt and no nag.
- [ ] Switch environments from the status bar. It works.
- [ ] Paste a fake hardcoded token into a `.api` file. The warning and its quick fix both work.
- [ ] Click `✓ Run Check`. You get the upsell, naming what free includes and what Pro adds —
      **and no check runs**.

## 2. Buy the product

- [ ] Get the checkout link: Dodo dashboard → Products → **Local API Check — Pro License** → enable the
      payment/share link and copy it. The API does not return one, and the link may need enabling on the
      product first — which is why `PRODUCT_URL` in `src/licenseApi.ts` is still `undefined`. Paste the
      link back and it becomes the "Get a License" button in the **What is Pro?** dialog.
- [ ] Pay with a Dodo **test card** (the dashboard lists the current test card numbers; `4242 4242 4242 4242`
      is the usual one). Use an email inbox you can actually open.
- [ ] The payment succeeds and the order shows in the dashboard.

## 3. Receive the key

- [ ] A licence key email arrives at that address, automatically — this is what
      `fulfillment_mode: auto` is for. If it does not arrive within a couple of minutes,
      check Dodo → Entitlements → Grants: the grant should read **Delivered**, not **Pending**.
      A `Pending` grant means the entitlement was created in manual mode, which is a Part A bug.
- [ ] Copy the key.

## 4. Activate it

- [ ] Run **Local API Check: Enter License Key** and paste it.
- [ ] You get **"Pro unlocked"**.
- [ ] **Local API Check: License Status** now says **Pro — licensed**.
- [ ] In Dodo → Entitlements → the grant, an activation instance appears, named
      `local-api-check <uuid>`. Confirm it is a random id and **not** your computer's name.

## 5. Confirm Pro actually works

- [ ] `✓ Run Check` on a request now runs it and reports pass or fail.
- [ ] **Run All Checks in File** runs every `expect:` block in the file.
- [ ] **Run All Checks in Workspace** runs across every `.api` file.
- [ ] Open the **Local API Check** output channel: there is one `[license] activate: activated …` line.

## 6. Confirm it survives going offline

This is the failure mode that would hurt a paying customer most, so check it deliberately.

- [ ] Turn off wifi (or block `test.dodopayments.com` in your hosts file).
- [ ] Reload the VS Code window.
- [ ] **Run All Checks in File** still works.
- [ ] **License Status** still says Pro (it may say it could not be confirmed — that is correct;
      it must not say Free tier and must not lock anything).
- [ ] Turn wifi back on.

## 7. Confirm the key is stored where it should be

- [ ] Search the project folder for the key text. It is not there.
- [ ] Confirm nothing was added to your repo: `git status` is clean.

## 8. Clean up

- [ ] Run **Local API Check: Remove License Key**.
- [ ] **License Status** says **Free tier** again, and Pro commands show the upsell again.

## If anything above fails

Note which numbered step, what you expected, and what happened, then stop — a failure here means
the wiring is wrong, and the fix belongs in code rather than in a workaround. Steps 1, 5 and 6 are
the ones that matter most: free must stay whole, Pro must actually unlock, and a dropped connection
must never lock out someone who has paid.
