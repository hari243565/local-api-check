import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { LocalApiCheckApi } from '../../extension';
import type { ApiFileNode, RequestNode } from '../../treeView';
import { activateExtension, fixtureUri, waitFor } from './helpers';

/**
 * Exercises the live TreeDataProvider that the sidebar renders from — the same
 * instance registered with `window.createTreeView` during activation.
 */
suite('Requests sidebar', () => {
  let api: LocalApiCheckApi;

  suiteSetup(async () => {
    api = await activateExtension();
  });

  async function rootNodes(): Promise<ApiFileNode[]> {
    const nodes = (await api.tree.getChildren()) as ApiFileNode[];
    return nodes;
  }

  test('lists every .api file in the workspace', async () => {
    // findFiles can lag right after startup while the file index warms up.
    await waitFor(async () => (await rootNodes()).length === 3, 'three .api files in the tree');

    const nodes = await rootNodes();
    assert.deepEqual(
      nodes.map((n) => n.label),
      ['mixed.api', 'secrets.api', 'simple.api']
    );
    assert.deepEqual(
      nodes.map((n) => n.description),
      ['5 requests', '2 requests', '1 request']
    );
    for (const node of nodes) {
      assert.equal(node.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      assert.equal(node.command?.command, 'vscode.open');
    }
  });

  test('lists the requests inside a file, with methods and check state', async () => {
    const nodes = await rootNodes();
    const mixed = nodes.find((n) => n.label === 'mixed.api');
    assert.ok(mixed, 'mixed.api missing from the tree');

    const children = (await api.tree.getChildren(mixed)) as RequestNode[];
    assert.deepEqual(
      children.map((c) => c.label),
      [
        'Todo exists',
        'Create a post',
        'Missing todo fails on status',
        'Plain text body fails json_has',
        'Plain request with no expectations'
      ]
    );
    assert.deepEqual(
      children.map((c) => c.description),
      ['GET', 'POST', 'GET', 'GET', 'GET']
    );
    assert.deepEqual(
      children.map((c) => c.contextValue),
      [
        'localApiCheck.checkRequest',
        'localApiCheck.checkRequest',
        'localApiCheck.checkRequest',
        'localApiCheck.checkRequest',
        'localApiCheck.request'
      ]
    );
  });

  test('a request node is wired to jump to its line in the editor', async () => {
    const nodes = await rootNodes();
    const simple = nodes.find((n) => n.label === 'simple.api');
    assert.ok(simple);

    const [request] = (await api.tree.getChildren(simple)) as RequestNode[];
    assert.equal(request.label, 'Echo request');
    assert.equal(request.command?.command, 'localApiCheck.revealRequest');

    // Start somewhere else so the jump is observable.
    const other = await vscode.workspace.openTextDocument(fixtureUri('mixed.api'));
    await vscode.window.showTextDocument(other, { preview: false });

    await vscode.commands.executeCommand(
      request.command.command,
      ...(request.command.arguments ?? [])
    );

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'no active editor after revealing the request');
    assert.equal(editor.document.uri.toString(), fixtureUri('simple.api').toString());
    assert.equal(editor.selection.active.line, request.ref.headerLine);
    assert.equal(editor.document.lineAt(editor.selection.active.line).text, '### Echo request');
  });

  test('the tree reflects unsaved edits, not just what is on disk', async () => {
    const uri = fixtureUri('simple.api');
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();

    try {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(document.lineCount, 0), '\n### Added in memory\nGET http://127.0.0.1:39871/echo\n');
      assert.ok(await vscode.workspace.applyEdit(edit));

      const nodes = await rootNodes();
      const simple = nodes.find((n) => n.label === 'simple.api');
      assert.ok(simple);
      const children = (await api.tree.getChildren(simple)) as RequestNode[];
      assert.deepEqual(
        children.map((c) => c.label),
        ['Echo request', 'Added in memory']
      );
    } finally {
      const revert = new vscode.WorkspaceEdit();
      revert.replace(uri, new vscode.Range(0, 0, document.lineCount + 5, 0), original);
      await vscode.workspace.applyEdit(revert);
      if (document.isDirty) {
        await document.save();
      }
    }
  });
});
