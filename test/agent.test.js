import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tips = require('../electron/tips.cjs');
const aiChat = require('../electron/ai-chat.cjs');

test('tips store seeds starters, adds AI tips, and removes tips cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-tips-'));
  try {
    const file = path.join(dir, 'ai-tips.json');
    const initial = tips.loadTips(file);
    assert.ok(initial.length >= 3);

    const added = tips.addTip(file, {
      title: 'Quick Fade Out',
      category: 'Transitions',
      author: 'Claude',
      body: 'Use Fade to Black with 0.8s duration for clean scene endings.',
    });
    assert.equal(added.ok, true);
    assert.equal(added.tip.author, 'Claude');
    assert.equal(tips.loadTips(file)[0].title, 'Quick Fade Out');

    const after = tips.removeTip(file, added.tip.id);
    assert.equal(after.ok, true);
    assert.equal(tips.loadTips(file).some((t) => t.id === added.tip.id), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractToolBlocks parses zaude-tools JSON blocks and cleans reply text', () => {
  const reply = `I boosted brightness and saved a tip for you.\n\`\`\`zaude-tools\n[\n  {"tool": "zaude_set_filters", "args": {"brightness": 65}},\n  {"tool": "zaude_add_tip", "args": {"title": "Bright Look", "body": "Set brightness to 65"}}\n]\n\`\`\``;
  const { calls, cleanText } = aiChat.extractToolBlocks(reply);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'zaude_set_filters');
  assert.equal(calls[0].args.brightness, 65);
  assert.equal(calls[1].tool, 'zaude_add_tip');
  assert.equal(cleanText, 'I boosted brightness and saved a tip for you.');
});

test('buildCliCommand supports claude (with MCP), codex, and opencode', () => {
  const claude = aiChat.buildCliCommand({ provider: 'claude', prompt: 'hi', mcpConfigPath: '/tmp/m.json' });
  assert.equal(claude.bin, 'claude');
  assert.ok(claude.args.includes('--mcp-config'));
  const codex = aiChat.buildCliCommand({ provider: 'codex', prompt: 'hi' });
  assert.deepEqual(codex, { bin: 'codex', args: ['exec', '--skip-git-repo-check', 'hi'] });
  const oc = aiChat.buildCliCommand({ provider: 'opencode', prompt: 'hi' });
  assert.deepEqual(oc, { bin: 'opencode', args: ['run', '--archived', 'hi'] });
});

test('MCP server handles initialize, tools/list, and zaude_add_tip / zaude_list_tips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-mcp-'));
  try {
    process.env.ZAUDE_TIPS_FILE = path.join(dir, 'tips.json');
    process.env.ZAUDE_BRIDGE_FILE = path.join(dir, 'no-bridge.json');
    delete require.cache[require.resolve('../electron/mcp-server.cjs')];
    const mcp = require('../electron/mcp-server.cjs');

    const init = await mcp.handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'zaude-mcp');

    const listed = await mcp.handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(listed.result.tools.some((t) => t.name === 'zaude_set_filters'));
    assert.ok(listed.result.tools.some((t) => t.name === 'zaude_add_tip'));

    const addRes = await mcp.handleRpcMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'zaude_add_tip',
        arguments: { title: 'MCP Tip', category: 'AI', author: 'Antigravity', body: 'Use MCP to automate edits!' },
      },
    });
    assert.equal(addRes.result.isError, false);
    const listRes = await mcp.handleRpcMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'zaude_list_tips', arguments: {} },
    });
    assert.ok(listRes.result.content[0].text.includes('MCP Tip'));
  } finally {
    delete process.env.ZAUDE_TIPS_FILE;
    delete process.env.ZAUDE_BRIDGE_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
