import { defineConfig } from '@vscode/test-cli';

/**
 * The Marketplace screenshot run. Separate from .vscode-test.mjs on purpose:
 * this one resizes and focuses a real window, which is not something the
 * assertion suite should ever do, and it opens a different fixture workspace.
 */
export default defineConfig({
  label: 'screenshot',
  files: 'out/test/screenshot/**/*.test.js',
  workspaceFolder: './src/test/fixtures/screenshot',
  launchArgs: [
    '--disable-extensions',
    // Software rendering: a GPU-composited Chromium window hands PrintWindow a
    // blank surface, so this is what makes the capture possible at all.
    '--disable-gpu',
    '--disable-updates',
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--sync',
    'off'
  ],
  mocha: {
    ui: 'tdd',
    timeout: 120000,
    color: false
  }
});
