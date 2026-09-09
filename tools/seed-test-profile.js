/**
 * Seeds the isolated VS Code profile that the integration suite runs in
 * (.vscode-test/user-data, created by @vscode/test-electron).
 *
 * The point is a quiet, deterministic host: no update checks, no telemetry, no
 * built-in chat/agent features reaching for GitHub auth. Combined with
 * --disable-extensions, that leaves this extension as the only thing in the log
 * that can go wrong.
 *
 * With --screenshot it also pins the presentation settings the Marketplace
 * capture depends on, so the shot is framed identically on every run instead
 * of inheriting whatever the last session left behind.
 *
 * Run with: node tools/seed-test-profile.js [--screenshot]
 */
const fs = require('fs');
const path = require('path');

const settings = {
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'update.showReleaseNotes': false,
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'extensions.ignoreRecommendations': true,
  'workbench.startupEditor': 'none',
  'workbench.enableExperiments': false,
  'workbench.settings.enableNaturalLanguageSearch': false,
  'security.workspace.trust.enabled': false,
  'git.autofetch': false,
  'git.enabled': false,
  'npm.fetchOnlinePackageInfo': false,
  'typescript.disableAutomaticTypeAcquisition': true,
  // Built-in chat / agent host: keep it from starting up and from asking
  // GitHub for a token, which is otherwise logged on every run.
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'chat.agentSessionsViewLocation': 'disabled',
  'chat.detectParticipant.enabled': false,
  'workbench.commandPalette.experimental.suggestCommands': false
};

// Capture-only presentation. Every one of these is framing, not behaviour:
// nothing here changes what the extension does, only how much of it fits in
// one frame and whether the shot is reproducible.
const screenshotSettings = {
  // The display this runs on is at 150%, which leaves a 1920px window with
  // barely 1280 logical pixels. One step down buys back the editor width.
  'window.zoomLevel': -1,
  // Drops the "[Extension Development Host] ..." caption, which is an artefact
  // of running under the test harness and not something a user ever sees.
  'window.customTitleBarVisibility': 'never',
  'window.menuBarVisibility': 'hidden',
  // Pin the theme, so the capture cannot drift with a VS Code default change.
  'workbench.colorTheme': 'Default Dark Modern'
};

if (process.argv.includes('--screenshot')) {
  Object.assign(settings, screenshotSettings);
}

const userDir = path.join(__dirname, '..', '.vscode-test', 'user-data', 'User');
fs.mkdirSync(userDir, { recursive: true });
const target = path.join(userDir, 'settings.json');
fs.writeFileSync(target, `${JSON.stringify(settings, undefined, 2)}\n`, 'utf8');
console.log(`seeded ${path.relative(path.join(__dirname, '..'), target)}`);
