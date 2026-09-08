import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  label: 'integration',
  files: 'out/test/integration/**/*.test.js',
  // A dedicated fixture workspace, so the suite never sees the repo's own
  // examples/ or .api-env/ folders.
  workspaceFolder: './src/test/fixtures/workspace',
  launchArgs: [
    // Non-negotiable: every other installed extension stays off, so a failure
    // or a stack trace in the log can only have come from this extension.
    '--disable-extensions',
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
    timeout: 30000,
    color: false
  }
});
