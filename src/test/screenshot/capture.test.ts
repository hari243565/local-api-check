import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { CheckResult } from '../../assert';
import { EXTENSION_ID, grantTestLicense, showFixture, fixtureUri } from '../integration/helpers';
import { ensureTestServers } from '../integration/testServer';

const run = promisify(execFile);

/**
 * Produces the Marketplace screenshot from the real running extension.
 *
 * This is a capture, not a mock-up: the workbench in the PNG is this suite's
 * own VS Code instance, the CodeLenses are the ones the provider actually
 * returned, and the "3 passed, 1 failed" line is the real output of the real
 * check runner against the local fixture server.
 *
 * It lives outside the integration suite on purpose. It resizes and focuses a
 * window, which is exactly the kind of side effect an assertion suite should
 * not have, so `npm run test:integration` never picks it up. Run it with
 * `npm run screenshot`.
 */

const WINDOW_WIDTH = 1920;
const WINDOW_HEIGHT = 1080;
/** Mirrors window.zoomLevel = -1, seeded by tools/seed-test-profile.js --screenshot. */
const ZOOM_FACTOR = 0.8;
/** VS Code's title bar height in logical pixels. */
const TITLE_BAR_LOGICAL_HEIGHT = 35;

/** The extension host runs on the test instance's own Code.exe. */
function testInstanceExecutable(repoRoot: string): string {
  const exe = process.execPath;
  const sandbox = path.join(repoRoot, '.vscode-test');
  assert.ok(
    path.normalize(exe).toLowerCase().startsWith(path.normalize(sandbox).toLowerCase()),
    `refusing to capture: process.execPath (${exe}) is not inside ${sandbox}, so the ` +
      'window found by executable path might not be this suite’s instance'
  );
  return exe;
}

async function captureScript(repoRoot: string, args: string[]): Promise<Record<string, unknown>> {
  const script = path.join(repoRoot, 'tools', 'capture-window.ps1');
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  );
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  assert.ok(line, `capture-window.ps1 printed nothing for: ${args.join(' ')}`);
  return JSON.parse(line) as Record<string, unknown>;
}

/** Gives the renderer time to paint what the commands above just asked for. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('Marketplace screenshot', () => {
  test('captures the real workbench with CodeLenses and a check result', async function () {
    if (process.platform !== 'win32') {
      this.skip();
    }

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not installed in the capture instance`);
    const repoRoot = extension.extensionPath;
    const exe = testInstanceExecutable(repoRoot);

    await ensureTestServers();
    await grantTestLicense();

    // Size the window first, so every layout below settles at the final
    // geometry instead of reflowing under the camera.
    const arranged = await captureScript(repoRoot, [
      '-ExePath', exe,
      '-Mode', 'arrange',
      '-Width', String(WINDOW_WIDTH),
      '-Height', String(WINDOW_HEIGHT)
    ]);
    assert.equal(arranged.mode, 'arrange');
    const scale = Number(arranged.scale);
    assert.ok(Number.isFinite(scale) && scale > 0, `no usable display scale: ${arranged.scale}`);
    console.log(
      `window: ${arranged.width}x${arranged.height} at ${scale}x — ${String(arranged.title)}`
    );

    // Under the harness the title bar reads "[Extension Development Host] ...",
    // which is an artefact of how this window was launched and nothing a user
    // ever sees. It is the one part of the frame that gets trimmed.
    const cropTop = Math.round(TITLE_BAR_LOGICAL_HEIGHT * scale * ZOOM_FACTOR);

    // The extension's own view, so the sidebar in the shot is this extension
    // rather than the file explorer.
    await vscode.commands.executeCommand('localApiCheck.requests.focus');
    const document = await showFixture('checks.api');
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'no active editor to photograph');
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    // Proof the CodeLenses in the frame are real: the provider is asked for
    // them directly, and the shot is only taken if it returned some.
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      document.uri
    );
    assert.ok(lenses && lenses.length > 0, 'the CodeLens provider returned nothing to photograph');
    const titles = new Set(lenses.map((lens) => lens.command?.title ?? ''));
    assert.ok(
      [...titles].some((t) => t.includes('Send Request')),
      `no "Send Request" CodeLens: ${[...titles].join(', ')}`
    );
    assert.ok(
      [...titles].some((t) => t.includes('Run Check')),
      `no "Run Check" CodeLens: ${[...titles].join(', ')}`
    );

    const results = await vscode.commands.executeCommand<CheckResult[]>(
      'localApiCheck.runAllChecksInFile'
    );
    assert.ok(results, 'Run All Checks in File returned nothing — is the test licence missing?');
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    assert.equal(passed, 3, `fixture should produce 3 passing checks, got ${passed}`);
    assert.equal(failed, 1, `fixture should produce 1 failing check, got ${failed}`);

    await vscode.commands.executeCommand('localApiCheck.showOutput');
    // A leftover toast would sit on top of the very thing being photographed.
    await vscode.commands.executeCommand('notifications.clearAll');
    await settle(3000);

    const target = path.join(repoRoot, 'images', 'screenshot.png');
    await fs.rm(target, { force: true });
    const shot = await captureScript(repoRoot, [
      '-ExePath', exe,
      '-Mode', 'capture',
      '-Out', target,
      '-CropTop', String(cropTop)
    ]);
    console.log(`capture: ${JSON.stringify(shot)}`);

    const png = await fs.readFile(target);
    assert.ok(png.length > 20_000, `screenshot is suspiciously small: ${png.length} bytes`);
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'the captured file is not a PNG'
    );
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(width >= 1000 && height >= 600, `captured window is too small: ${width}x${height}`);
    console.log(`saved ${path.relative(repoRoot, target)} — ${width}x${height}, ${png.length} bytes`);

    // The fixture must survive the run untouched; nothing here edits it, and
    // this is what proves the next run starts from the same state.
    const onDisk = await fs.readFile(fixtureUri('checks.api').fsPath, 'utf8');
    assert.ok(onDisk.includes('### Get user profile'), 'the fixture was modified by the capture');
  });
});
