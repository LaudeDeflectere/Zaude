// Local AI CLI chat runner for Zaude: integrates Claude Code, Codex, OpenCode, and Antigravity MCP.
// Pure helpers (extractToolBlocks, buildEditorPrompt, buildCliCommand) are exported for unit tests.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', bin: 'claude' },
  { id: 'codex', label: 'Codex', bin: 'codex' },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode' },
];

function findBinary(bin) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(cmd, [bin], { encoding: 'utf8', windowsHide: true });
    if (res.status === 0 && res.stdout) return res.stdout.trim().split(/\r?\n/)[0];
  } catch { /* not found */ }
  return null;
}

function detectProviders() {
  const list = PROVIDERS.map((p) => {
    const binPath = findBinary(p.bin);
    return { ...p, available: Boolean(binPath), path: binPath };
  });
  const agyPath = findBinary('agy');
  return {
    providers: list,
    antigravity: { available: Boolean(agyPath), path: agyPath },
  };
}

// Extracts structured tool call blocks of the form ```zaude-tools [...] ``` from an AI reply.
function extractToolBlocks(text) {
  const calls = [];
  const re = /```zaude-tools\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item.tool === 'string') {
          calls.push({ tool: item.tool, args: (item.args && typeof item.args === 'object') ? item.args : {} });
        }
      }
    } catch { /* ignore malformed block */ }
  }
  const cleanText = String(text || '').replace(re, '').trim();
  return { calls, cleanText };
}

function buildEditorPrompt({ userMessage, state, history = [], provider = 'claude', useMcp = false }) {
  const recent = (Array.isArray(history) ? history : []).slice(-6)
    .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${String(h.text || '').slice(0, 500)}`)
    .join('\n');

  const toolGuide = useMcp
    ? `You have live Zaude MCP tools (mcp__zaude__*) connected directly to the open Zaude editor. Call them directly to perform edits or add tips to the Help page. If you cannot call MCP tools, you may also output a \`\`\`zaude-tools JSON array block.`
    : `To perform edits directly in the open Zaude editor, include ONE fenced block tagged \`\`\`zaude-tools containing a JSON array of tool calls, like:
\`\`\`zaude-tools
[
  {"tool": "zaude_set_filters", "args": {"clipId": "c1", "brightness": 62, "contrast": 58, "temperature": 15}},
  {"tool": "zaude_add_tip", "args": {"title": "Warm Cinematic Look", "category": "Color", "author": "${provider}", "body": "Pair +15 temperature with 58 contrast and 20 vignette."}}
]
\`\`\``;

  const toolList = [
    'zaude_seek({time})',
    'zaude_select_clips({ids})',
    'zaude_add_from_bin({nameOrPath, time?})',
    'zaude_split({time?})',
    'zaude_trim({clipId, duration? | endTime?})',
    'zaude_move_clip({clipId?, clipIds?, deltaSec?, start?})',
    'zaude_delete_clips({ids, ripple?})',
    'zaude_set_filters({clipId?, brightness(0..100,50=neutral), contrast(0..100,50=neutral), saturation(0..100,50=neutral), exposure(-100..100), dynamics(-100..100), temperature(-100..100), hue(-180..180), tint(-100..100), vignette(0..100), sharpen(0..100), denoise(0..100), blur(0..100), opacity(0..1), volume(0..2), muted?, reset?})',
    'zaude_set_transform({clipId?, scale(10..400), rotation(-180..180), posX(-100..100), posY(-100..100), flipH?, flipV?, fill?, reset?})',
    'zaude_set_hsl({clipId?, hex, hue(-180..180), sat(-100..100), light(-100..100), range(1..100), addNew?, reset?})',
    'zaude_set_transition({clipId?, type: "none"|"dissolve"|"fade-black"|"fade-white"|"slide-left", duration?})',
    'zaude_separate_audio({clipId?})',
    'zaude_set_export({preset?: "youtube"|"youtube4k"|"tiktok"|"square"|"cinema"|"preview", aspect?, resTier?, fps?, quality?, format?, rangeMode?, rangeStart?, rangeEnd?, openPanel?, startRender?})',
    'zaude_add_tip({title, category, author, body})',
  ].join('\n- ');

  return [
    'You are the AI editing assistant inside Zaude (a fast desktop video editor).',
    'Be concise and practical. Execute the user request using Zaude tools when they ask for an edit or a tip.',
    toolGuide,
    'Available Zaude tools:\n- ' + toolList,
    'Current live Zaude editor state:\n' + JSON.stringify(state || {}, null, 2),
    recent ? 'Recent conversation:\n' + recent : '',
    'User request: ' + userMessage,
  ].filter(Boolean).join('\n\n');
}

function buildCliCommand({ provider, prompt, mcpConfigPath }) {
  if (provider === 'claude') {
    const args = ['-p', prompt];
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath, '--allowedTools', 'mcp__zaude__*');
    }
    return { bin: 'claude', args };
  }
  if (provider === 'codex') {
    return { bin: 'codex', args: ['exec', '--skip-git-repo-check', prompt] };
  }
  if (provider === 'opencode') {
    return { bin: 'opencode', args: ['run', '--archived', prompt] };
  }
  return null;
}

function runAiChat({ provider, userMessage, state, history, mcpServerPath, cwd }) {
  let mcpConfigPath = null;
  if (provider === 'claude' && mcpServerPath && fs.existsSync(mcpServerPath)) {
    mcpConfigPath = path.join(os.tmpdir(), `zaude-mcp-${process.pid}-${Date.now()}.json`);
    const cfg = {
      mcpServers: {
        zaude: {
          command: process.execPath,
          args: [mcpServerPath],
        },
      },
    };
    try {
      fs.writeFileSync(mcpConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch {
      mcpConfigPath = null;
    }
  }

  const prompt = buildEditorPrompt({ userMessage, state, history, provider, useMcp: Boolean(mcpConfigPath) });
  const cmd = buildCliCommand({ provider, prompt, mcpConfigPath });
  if (!cmd) {
    return { promise: Promise.resolve({ ok: false, error: `Unknown AI provider: ${provider}` }), cancel: () => {} };
  }

  let child;
  try {
    child = spawn(cmd.bin, cmd.args, {
      cwd: cwd || os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
  } catch (err) {
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    return { promise: Promise.resolve({ ok: false, error: `Could not start ${cmd.bin}: ${err.message}` }), cancel: () => {} };
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const cleanup = () => {
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
  };

  const promise = new Promise((resolve) => {
    child.on('error', (err) => {
      cleanup();
      resolve({ ok: false, error: `Could not run ${cmd.bin}: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (signal) return resolve({ ok: false, cancelled: true, error: 'Cancelled.' });
      const text = stdout.trim();
      if (code !== 0 && !text) {
        const errMsg = stderr.trim().split(/\r?\n/).slice(-4).join(' ') || `${cmd.bin} exited with code ${code}`;
        return resolve({ ok: false, error: errMsg });
      }
      const { calls, cleanText } = extractToolBlocks(text);
      resolve({
        ok: true,
        text: cleanText || (calls.length ? 'Done — applied edits to your timeline.' : text),
        calls,
      });
    });
  });

  return {
    promise,
    cancel: () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    },
  };
}

module.exports = {
  PROVIDERS,
  detectProviders,
  extractToolBlocks,
  buildEditorPrompt,
  buildCliCommand,
  runAiChat,
};
