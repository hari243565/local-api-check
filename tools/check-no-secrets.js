/**
 * Fails the build if anything that looks like a credential would ship to users.
 *
 * The licensing design rests on one claim: the extension talks to Dodo Payments
 * only through public, unauthenticated endpoints, so no API key exists anywhere
 * in the packaged .vsix. This script is what makes that claim checkable rather
 * than merely asserted.
 *
 * It scans the exact files vsce would package (`vsce ls`) plus the bundled
 * output, and is also imported by the integration suite so the same rules run
 * against the extension as VS Code actually loaded it.
 *
 * Run with: node tools/check-no-secrets.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Patterns describe credential *material*, not the words "token" or "bearer".
 * That distinction matters here: this extension ships a secret *detector*,
 * whose own regex sources legitimately contain `sk_live_`, `authorization` and
 * `bearer`. Each rule therefore requires an actual high-entropy value.
 */
const CREDENTIAL_PATTERNS = [
  {
    name: 'a Dodo Payments API key or key-bearing identifier',
    regex: /dodo[_\-.]?payments?[_\-.]?(?:api[_\-.]?)?key/i
  },
  {
    name: 'a literal bearer token',
    regex: /bearer\s+[A-Za-z0-9_\-.]{20,}/i
  },
  {
    name: 'a vendor API key literal',
    regex:
      /(?:sk-|sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xoxb-|xoxp-|AIza|AKIA|ASIA|shpat_|dop_v1_)[A-Za-z0-9_\-]{16,}/
  },
  {
    name: 'a credential assigned to a key-shaped name',
    regex:
      /["'`]?(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["'`]?\s*[:=]\s*["'`][A-Za-z0-9_\-]{24,}["'`]/i
  }
];

/** Extensions worth reading as text. Binary assets cannot hide a usable key. */
const TEXT_EXTENSIONS = new Set([
  '.js',
  '.json',
  '.md',
  '.ts',
  '.txt',
  '.html',
  '.css',
  '.svg',
  '.api',
  '.yml',
  '.yaml',
  ''
]);

/**
 * @param {string} text
 * @returns {Array<{ rule: string, line: number, excerpt: string }>}
 */
function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of CREDENTIAL_PATTERNS) {
      const match = new RegExp(pattern.regex.source, pattern.regex.flags).exec(lines[i]);
      if (match) {
        findings.push({
          rule: pattern.name,
          line: i + 1,
          // Never print the whole match: this output could end up in a log.
          excerpt: `${match[0].slice(0, 12)}…`
        });
      }
    }
  }
  return findings;
}

function scanFile(file) {
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    return [];
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return scanText(text).map((finding) => ({ ...finding, file }));
}

/** Exactly the files vsce would put in the .vsix. */
function packagedFiles(root) {
  // Invoked through node against vsce's own entry point rather than through a
  // shell: no quoting to get wrong, and no DEP0190 warning in the build log.
  const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
  const output = execFileSync(process.execPath, [vsce, 'ls'], {
    cwd: root,
    encoding: 'utf8'
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('WARNING') && fs.existsSync(path.join(root, line)));
}

function main() {
  const root = path.join(__dirname, '..');
  const targets = new Set();

  const bundle = path.join(root, 'dist', 'extension.js');
  if (fs.existsSync(bundle)) {
    targets.add(bundle);
  }
  for (const relative of packagedFiles(root)) {
    targets.add(path.join(root, relative));
  }

  if (targets.size === 0) {
    console.error('check-no-secrets: nothing to scan — run `npm run package` first.');
    process.exit(1);
  }

  const findings = [...targets].flatMap(scanFile);
  if (findings.length > 0) {
    console.error('check-no-secrets: credential material found in files that would ship:');
    for (const finding of findings) {
      console.error(`  ${path.relative(root, finding.file)}:${finding.line} — ${finding.rule} (${finding.excerpt})`);
    }
    process.exit(1);
  }

  console.log(`check-no-secrets: ${targets.size} shipped files scanned, no credential material found.`);
}

module.exports = { scanText, scanFile, CREDENTIAL_PATTERNS };

if (require.main === module) {
  main();
}
