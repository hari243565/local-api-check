/**
 * A deliberately small scanner for secrets hardcoded into `.api` files instead
 * of being pulled from an environment variable.
 *
 * This is a nudge, never a block: false negatives are much cheaper than
 * annoying false positives, so the pattern list stays short and specific.
 * Adding a rule means adding one entry to PATTERNS.
 *
 * `vscode`-free so it can be unit-tested directly.
 */

export interface SecretFinding {
  /** 0-based line. */
  line: number;
  /** 0-based column of the first character of the secret value. */
  startColumn: number;
  endColumn: number;
  /** The literal that looks like a secret. */
  value: string;
  /** Short description of what matched, shown to the user. */
  kind: string;
  /** Variable name to offer in the quick fix, e.g. `auth_token`. */
  suggestedName: string;
}

interface SecretPattern {
  kind: string;
  suggestedName: string;
  regex: RegExp;
  /** Extra confirmation beyond the regex. */
  looksSecret?: (value: string) => boolean;
}

/** Values people type as reminders, not credentials. */
const PLACEHOLDER_RE =
  /^(?:x+|y+|\.+|-+|_+|0+|replace[-_ ]?me|change[-_ ]?me|your[-_ ]?\w+|todo|tbd|none|null|undefined|placeholder|secret|token|password|test|example|dummy|foo|bar|<[^>]*>)$/i;

const MIN_LENGTH = 16;

/** Mixed-case/digit-bearing strings long enough to be a real credential. */
function looksRandom(value: string): boolean {
  if (value.length < MIN_LENGTH) {
    return false;
  }
  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);
  return hasDigit && hasLetter;
}

const PATTERNS: SecretPattern[] = [
  {
    kind: 'bearer token',
    suggestedName: 'auth_token',
    regex: /^\s*authorization\s*:\s*bearer\s+(\S+)\s*$/i,
    looksSecret: looksRandom
  },
  {
    kind: 'basic auth credentials',
    suggestedName: 'auth_basic',
    regex: /^\s*authorization\s*:\s*basic\s+(\S+)\s*$/i,
    looksSecret: (v) => v.length >= MIN_LENGTH
  },
  {
    kind: 'API key header',
    suggestedName: 'api_key',
    regex: /^\s*(?:x-api-key|api-key|apikey|x-auth-token)\s*:\s*(\S+)\s*$/i,
    looksSecret: (v) => v.length >= MIN_LENGTH
  },
  {
    kind: 'key in a URL or form body',
    suggestedName: 'api_key',
    regex: /(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|token|secret)=([^&\s"']+)/i,
    looksSecret: looksRandom
  },
  {
    kind: 'secret in a JSON body',
    suggestedName: 'api_key',
    regex:
      /"(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|token|secret|password)"\s*:\s*"([^"]+)"/i,
    looksSecret: looksRandom
  },
  {
    // Vendor prefixes are specific enough to flag on sight.
    kind: 'provider key',
    suggestedName: 'api_key',
    regex:
      /\b((?:sk-|sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xoxb-|xoxp-|xoxa-|AIza|AKIA|ASIA|SG\.|shpat_|npm_|dop_v1_)[A-Za-z0-9_\-]{10,})/
  }
];

export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);

  for (let line = 0; line < lines.length; line++) {
    const content = lines[line];
    if (content.trim().startsWith('#')) {
      continue; // Comments and block headers.
    }

    for (const pattern of PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags.replace('g', '') + 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const value = match[1];
        if (!value || value.includes('{{')) {
          continue; // Already a variable.
        }
        if (PLACEHOLDER_RE.test(value)) {
          continue;
        }
        if (pattern.looksSecret && !pattern.looksSecret(value)) {
          continue;
        }
        const startColumn = match.index + match[0].lastIndexOf(value);
        if (findings.some((f) => f.line === line && f.startColumn === startColumn)) {
          continue; // Two patterns caught the same literal.
        }
        findings.push({
          line,
          startColumn,
          endColumn: startColumn + value.length,
          value,
          kind: pattern.kind,
          suggestedName: pattern.suggestedName
        });
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.startColumn - b.startColumn);
}

/**
 * Picks a variable name that does not collide with an existing, differently
 * valued key in the environment.
 */
export function pickVariableName(
  preferred: string,
  existing: Record<string, string>,
  value: string
): string {
  if (!(preferred in existing) || existing[preferred] === value) {
    return preferred;
  }
  for (let i = 2; i < 100; i++) {
    const candidate = `${preferred}_${i}`;
    if (!(candidate in existing) || existing[candidate] === value) {
      return candidate;
    }
  }
  return `${preferred}_${Date.now()}`;
}
