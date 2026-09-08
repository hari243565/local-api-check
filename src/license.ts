import * as vscode from 'vscode';
import {
  DODO_BASE_URL,
  LICENSE_TIMEOUT_MS,
  PRODUCT_URL,
  REVALIDATE_AFTER_MS,
  activateLicense,
  isProState,
  licenseStateOf,
  postJson,
  validateLicense,
  type ActivationOutcome,
  type LicenseState,
  type PostJson,
  type ValidationOutcome
} from './licenseApi';

export type { LicenseState } from './licenseApi';

/**
 * The license key and its activation instance id live in SecretStorage, which
 * is the OS keychain — never globalState, never a file in the project.
 */
const SECRET_KEY = 'localApiCheck.licenseKey';
const SECRET_INSTANCE = 'localApiCheck.licenseKeyInstanceId';

/** Non-secret bookkeeping. A random per-install id, not anything about the machine. */
const INSTALL_ID_KEY = 'localApiCheck.installId';
const LAST_VALIDATED_KEY = 'localApiCheck.lastValidatedAt';
const REVOKED_KEY = 'localApiCheck.licenseRevoked';

export interface LicenseSnapshot {
  state: LicenseState;
  /** Whether Pro features are unlocked right now. */
  pro: boolean;
  lastValidatedAt?: number;
  /** What the most recent licence call did, for the output channel. */
  lastOutcome?: string;
}

export interface LicenseEntryResult {
  ok: boolean;
  state: LicenseState;
  /** What the user was told — the server message verbatim on rejection. */
  message: string;
}

/** Free tier, stated the same way everywhere it is shown. */
export const FREE_FEATURES =
  'Free forever: sending requests, .api-env environments, and hardcoded-secret warnings.';
export const PRO_FEATURES =
  'Pro adds the pass/fail check system: expect: blocks, Run Check, Run All Checks in File, and Run All Checks in Workspace.';

/**
 * Owns license state: entry, activation, cached revalidation, and the answer
 * to "is Pro unlocked".
 *
 * The rule that matters most is fail-open. A network error, a timeout, an HTTP
 * error or a malformed body all leave the last known state untouched; only an
 * explicit `{ valid: false }` revokes access. A paying user whose wifi dropped
 * keeps working.
 */
export class LicenseManager {
  /**
   * Swapped by the test suites so no automated test ever touches the real
   * licence server. Production always uses the fetch-backed transport.
   */
  transport: PostJson = postJson;
  baseUrl: string = DODO_BASE_URL;

  private lastOutcome: string | undefined;
  private readonly changed = new vscode.EventEmitter<LicenseSnapshot>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void
  ) {}

  dispose(): void {
    this.changed.dispose();
  }

  private cachedInstallId: string | undefined;

  /** A stable, random identifier for this installation. Never a hostname. */
  async installId(): Promise<string> {
    if (this.cachedInstallId) {
      return this.cachedInstallId;
    }
    const existing = this.context.globalState.get<string>(INSTALL_ID_KEY);
    if (typeof existing === 'string' && existing.length > 0) {
      this.cachedInstallId = existing;
      return existing;
    }
    const generated =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.cachedInstallId = generated;
    await this.context.globalState.update(INSTALL_ID_KEY, generated);
    return generated;
  }

  /**
   * SecretStorage is the persistence layer, but not the source of truth for a
   * decision made this often.
   *
   * Two reasons. A `get` issued straight after a `store` or `delete` can still
   * answer with the previous value — which would let a removed licence look
   * active, or a rejected key look accepted, for as long as the write takes to
   * settle. And the gate runs on every Pro command, which should not mean a
   * keychain round trip each time.
   *
   * So the cache is authoritative for this window and is updated before the
   * write, never after it. A second VS Code window picks up a licence change
   * when it next activates.
   */
  private cachedKey: string | undefined;
  private cachedInstanceId: string | undefined;
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.cachedKey = (await this.context.secrets.get(SECRET_KEY)) || undefined;
    this.cachedInstanceId = (await this.context.secrets.get(SECRET_INSTANCE)) || undefined;
    this.loaded = true;
  }

  private async storedKey(): Promise<string | undefined> {
    await this.load();
    return this.cachedKey;
  }

  private async storedInstanceId(): Promise<string | undefined> {
    await this.load();
    return this.cachedInstanceId;
  }

  private async storeCredentials(key: string, instanceId: string): Promise<void> {
    this.cachedKey = key;
    this.cachedInstanceId = instanceId;
    this.loaded = true;
    await this.context.secrets.store(SECRET_KEY, key);
    await this.context.secrets.store(SECRET_INSTANCE, instanceId);
  }

  private async forgetCredentials(): Promise<void> {
    this.cachedKey = undefined;
    this.cachedInstanceId = undefined;
    this.loaded = true;
    await this.context.secrets.delete(SECRET_KEY);
    await this.context.secrets.delete(SECRET_INSTANCE);
  }

  /**
   * The same rule as the credentials above, for the same reason: a `get`
   * straight after an `update` can still answer with the previous value, which
   * would make a licence look unconfirmed the instant after it was confirmed.
   * Memory is authoritative; globalState is persistence.
   */
  private cachedLastValidatedAt: number | undefined;
  private cachedRevoked = false;
  private stateLoaded = false;

  private loadState(): void {
    if (this.stateLoaded) {
      return;
    }
    const value = this.context.globalState.get<number>(LAST_VALIDATED_KEY);
    this.cachedLastValidatedAt = typeof value === 'number' ? value : undefined;
    this.cachedRevoked = this.context.globalState.get<boolean>(REVOKED_KEY) === true;
    this.stateLoaded = true;
  }

  private get lastValidatedAt(): number | undefined {
    this.loadState();
    return this.cachedLastValidatedAt;
  }

  private get revoked(): boolean {
    this.loadState();
    return this.cachedRevoked;
  }

  /** Records a confirmation from the licence server. */
  private async markConfirmed(): Promise<void> {
    this.cachedLastValidatedAt = Date.now();
    this.cachedRevoked = false;
    this.stateLoaded = true;
    await this.context.globalState.update(LAST_VALIDATED_KEY, this.cachedLastValidatedAt);
    await this.context.globalState.update(REVOKED_KEY, false);
  }

  /** Records the one answer that takes Pro away. */
  private async markRevoked(): Promise<void> {
    this.loadState();
    this.cachedRevoked = true;
    await this.context.globalState.update(REVOKED_KEY, true);
  }

  private async clearState(): Promise<void> {
    this.cachedLastValidatedAt = undefined;
    this.cachedRevoked = false;
    this.stateLoaded = true;
    await this.context.globalState.update(LAST_VALIDATED_KEY, undefined);
    await this.context.globalState.update(REVOKED_KEY, undefined);
  }

  async snapshot(): Promise<LicenseSnapshot> {
    const key = await this.storedKey();
    const lastValidatedAt = this.lastValidatedAt;

    const state: LicenseState = licenseStateOf({
      hasKey: key !== undefined,
      revoked: this.revoked,
      lastValidatedAt
    });

    return {
      state,
      pro: isProState(state),
      lastValidatedAt,
      lastOutcome: this.lastOutcome
    };
  }

  async isPro(): Promise<boolean> {
    return (await this.snapshot()).pro;
  }

  private async record(outcome: string): Promise<void> {
    this.lastOutcome = outcome;
    this.log(`[license] ${outcome}`);
    this.changed.fire(await this.snapshot());
  }

  /**
   * Prompts for a key (or takes one directly, which is how a keybinding, a
   * task, or the test suite drives it) and activates it against Dodo.
   */
  async enterKey(provided?: string): Promise<LicenseEntryResult> {
    let key = provided;
    if (typeof key !== 'string') {
      key = await vscode.window.showInputBox({
        title: 'Local API Check: enter your Pro license key',
        prompt: 'The key emailed to you after purchase. Stored in your OS keychain, never in a file.',
        placeHolder: 'XXXX-XXXX-XXXX-XXXX',
        ignoreFocusOut: true,
        // Not a password, but it is a credential — do not leave it on screen.
        password: true,
        validateInput: (value) =>
          value.trim().length === 0 ? 'Enter a license key, or press Escape to cancel.' : undefined
      });
    }

    key = key?.trim();
    if (!key) {
      const snapshot = await this.snapshot();
      return { ok: false, state: snapshot.state, message: 'Cancelled — no key entered.' };
    }

    const instanceName = `local-api-check ${await this.installId()}`;
    const outcome: ActivationOutcome = await activateLicense(key, instanceName, {
      post: this.transport,
      baseUrl: this.baseUrl,
      timeoutMs: LICENSE_TIMEOUT_MS
    });

    if (outcome.kind === 'activated') {
      await this.storeCredentials(key, outcome.instanceId);
      // Activation is itself a confirmation from the licence server.
      await this.markConfirmed();
      await this.record(`activate: activated (instance ${outcome.instanceId})`);
      const message = 'Local API Check: Pro unlocked. Checks and Run All Checks are enabled.';
      void vscode.window.showInformationMessage(message);
      return { ok: true, state: (await this.snapshot()).state, message };
    }

    if (outcome.kind === 'rejected') {
      // Surface exactly what Dodo said: "already at activation limit" and
      // "no such key" are different problems with different fixes.
      await this.record(`activate: rejected by the licence server (HTTP ${outcome.status}) — ${outcome.message}`);
      const message = `Local API Check: that license key was not accepted — ${outcome.message}`;
      void vscode.window.showErrorMessage(message);
      return { ok: false, state: (await this.snapshot()).state, message };
    }

    // Unreachable: the key is not stored, because there is no instance id to
    // store with it. Nothing about the existing state changes.
    await this.record(`activate: licence server unreachable (${outcome.reason}) — ${outcome.message}`);
    const message = `Local API Check: could not reach the licence server (${outcome.reason}: ${outcome.message}). Your key was not saved — try again when you are back online.`;
    void vscode.window.showErrorMessage(message);
    return { ok: false, state: (await this.snapshot()).state, message };
  }

  /** Forgets the stored license. Used by the user, and by test teardown. */
  async removeKey(): Promise<void> {
    await this.forgetCredentials();
    await this.clearState();
    await this.record('remove: license key deleted from this machine');
  }

  /**
   * Revalidates, but only when the cached result has aged out. Called once at
   * activation — never per command.
   */
  async refreshIfStale(force = false): Promise<ValidationOutcome | 'skipped'> {
    const key = await this.storedKey();
    if (!key) {
      return 'skipped';
    }

    const lastValidatedAt = this.lastValidatedAt;
    const fresh =
      !this.revoked &&
      lastValidatedAt !== undefined &&
      Date.now() - lastValidatedAt < REVALIDATE_AFTER_MS;
    if (fresh && !force) {
      return 'skipped';
    }

    const outcome = await validateLicense(key, await this.storedInstanceId(), {
      post: this.transport,
      baseUrl: this.baseUrl,
      timeoutMs: LICENSE_TIMEOUT_MS
    });

    if (outcome.kind === 'valid') {
      await this.markConfirmed();
      await this.record('validate: valid — Pro confirmed');
      return outcome;
    }

    if (outcome.kind === 'invalid') {
      // The only path that takes Pro away.
      await this.markRevoked();
      await this.record('validate: EXPLICITLY INVALID — Pro revoked on this machine');
      void vscode.window.showWarningMessage(
        'Local API Check: your Pro license is no longer valid. Checks are locked; sending requests and environments still work.'
      );
      return outcome;
    }

    // Unreachable is not a revocation, and must never be handled as one.
    const previous = (await this.snapshot()).state;
    await this.record(
      `validate: licence server unreachable (${outcome.reason}) — ${outcome.message}; keeping last known state: ${previous}`
    );
    return outcome;
  }

  /** Plain language, no jargon, for the License Status command. */
  statusMessage(snapshot: LicenseSnapshot): string {
    switch (snapshot.state) {
      case 'pro':
        return `Local API Check: Pro — licensed. Last confirmed ${describeWhen(snapshot.lastValidatedAt)}.`;
      case 'unconfirmed':
        return `Local API Check: Pro license found but could not be confirmed ${
          snapshot.lastValidatedAt === undefined
            ? 'yet'
            : `since ${describeWhen(snapshot.lastValidatedAt)}`
        } — Pro stays unlocked and it will retry.`;
      case 'revoked':
        return 'Local API Check: this license key was reported invalid by the licence server, so Pro is locked. Sending requests, environments and secret warnings are unaffected.';
      case 'free':
      default:
        return `Local API Check: Free tier. ${FREE_FEATURES} ${PRO_FEATURES}`;
    }
  }

  /** Shows status, with the actions that make sense for the current state. */
  async showStatus(): Promise<string> {
    const snapshot = await this.snapshot();
    const message = this.statusMessage(snapshot);
    const actions = snapshot.state === 'free' ? ['Enter License Key'] : ['Remove License Key'];
    void vscode.window.showInformationMessage(message, ...actions).then((choice) => {
      if (choice === 'Enter License Key') {
        void vscode.commands.executeCommand('localApiCheck.enterLicenseKey');
      } else if (choice === 'Remove License Key') {
        void vscode.commands.executeCommand('localApiCheck.removeLicense');
      }
    });
    return message;
  }

  /**
   * Shown when a Pro command is invoked without a license. Honest about what
   * the free tier already does, rather than implying the tool is crippled.
   */
  async showUpsell(feature: string): Promise<string> {
    const snapshot = await this.snapshot();
    const lead =
      snapshot.state === 'revoked'
        ? `${feature} is a Pro feature, and this license key is no longer valid.`
        : `${feature} is a Pro feature.`;
    const message = `Local API Check: ${lead} ${FREE_FEATURES} ${PRO_FEATURES}`;

    const actions = ['Enter License Key', 'What is Pro?'];
    void vscode.window.showInformationMessage(message, ...actions).then((choice) => {
      if (choice === 'Enter License Key') {
        void vscode.commands.executeCommand('localApiCheck.enterLicenseKey');
      } else if (choice === 'What is Pro?') {
        void this.explainPro();
      }
    });
    return message;
  }

  private async explainPro(): Promise<void> {
    const detail = `${FREE_FEATURES}\n\n${PRO_FEATURES}\n\nOne-time purchase, no subscription and no account. The license is stored in your OS keychain and checked at most once every 21 days; if the check cannot be made, Pro keeps working.`;
    if (PRODUCT_URL) {
      const buy = 'Get a License';
      const choice = await vscode.window.showInformationMessage(detail, { modal: true }, buy);
      if (choice === buy) {
        await vscode.env.openExternal(vscode.Uri.parse(PRODUCT_URL));
      }
      return;
    }
    await vscode.window.showInformationMessage(detail, { modal: true });
  }
}

function describeWhen(timestamp?: number): string {
  if (timestamp === undefined) {
    return 'never';
  }
  const days = Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  if (days <= 0) {
    return 'today';
  }
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
