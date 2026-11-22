#!/usr/bin/env node
// Zaude MCP (Model Context Protocol) server over stdio (JSON-RPC 2.0, zero dependencies).
// Allows Antigravity, Claude Code, Codex, and OpenCode to inspect and edit the live Zaude
// timeline, filters, HSL, transforms, export settings, and write tips to the Help page.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const tipsStore = require('./tips.cjs');

const CONFIG_DIR = process.env.ZAUDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'zaude');
const BRIDGE_FILE = process.env.ZAUDE_BRIDGE_FILE || path.join(CONFIG_DIR, 'bridge.json');
const TIPS_FILE = process.env.ZAUDE_TIPS_FILE || path.join(CONFIG_DIR, 'ai-tips.json');

const TOOLS = [
  {
    name: 'zaude_get_state',
    description: 'Read the live Zaude editor state: timeline clips, playhead time, selected clips, imported bin media, and export settings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zaude_seek',
    description: 'Move the Zaude timeline playhead to a specific timestamp in seconds.',
    inputSchema: { type: 'object', properties: { time: { type: 'number', description: 'Time in seconds (>= 0)' } }, required: ['time'] },
  },
  {
    name: 'zaude_select_clips',
    description: 'Select one or more clips on the timeline by their IDs.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
  {
    name: 'zaude_add_from_bin',
    description: 'Insert a media file from the Bin onto the timeline at the given time (or current playhead).',
    inputSchema: {
      type: 'object',
      properties: {
        nameOrPath: { type: 'string', description: 'Filename or full path of a file in the Bin' },
        time: { type: 'number', description: 'Optional start time in seconds (defaults to playhead)' },
      },
      required: ['nameOrPath'],
    },
  },
  {
    name: 'zaude_split',
    description: 'Split timeline clips at a given timestamp in seconds (or at the current playhead if omitted).',
    inputSchema: { type: 'object', properties: { time: { type: 'number' } } },
  },
  {
    name: 'zaude_trim',
    description: 'Set a clip duration in seconds or trim its end to a timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        duration: { type: 'number', description: 'New clip length in seconds' },
        endTime: { type: 'number', description: 'Alternative: trim clip end to this timeline timestamp' },
      },
      required: ['clipId'],
    },
  },
  {
    name: 'zaude_move_clip',
    description: 'Move a clip (or array of clipIds) along its track by deltaSec or to an exact start time.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        clipIds: { type: 'array', items: { type: 'string' } },
        deltaSec: { type: 'number' },
        start: { type: 'number', description: 'Exact target start time in seconds (for single clipId)' },
      },
    },
  },
  {
    name: 'zaude_delete_clips',
    description: 'Delete one or more clips by ID (optionally ripple-deleting to close the gap).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        ripple: { type: 'boolean', description: 'If true, shift later clips left to close the gap (single clip)' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'zaude_set_filters',
    description: 'Adjust integer filter/color/audio properties on a clip. Brightness/contrast/saturation are 0..100 (50=neutral); exposure/dynamics/temperature/tint are -100..100 (0=neutral); hue is -180..180; vignette/sharpen/denoise/blur are 0..100; opacity is 0..1; volume is 0..2.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string', description: 'Clip ID (defaults to currently selected clip)' },
        brightness: { type: 'number' },
        contrast: { type: 'number' },
        saturation: { type: 'number' },
        exposure: { type: 'number' },
        dynamics: { type: 'number' },
        temperature: { type: 'number' },
        hue: { type: 'number' },
        tint: { type: 'number' },
        vignette: { type: 'number' },
        sharpen: { type: 'number' },
        denoise: { type: 'number' },
        blur: { type: 'number' },
        opacity: { type: 'number' },
        volume: { type: 'number' },
        muted: { type: 'boolean' },
        reset: { type: 'boolean', description: 'Reset all filters to default' },
      },
    },
  },
  {
    name: 'zaude_set_transform',
    description: 'Set video transform on a clip: scale (10..400%), rotation (-180..180 deg), posX (-100..100%), posY (-100..100%), flipH, flipV, fill, or reset.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        scale: { type: 'number' },
        rotation: { type: 'number' },
        posX: { type: 'number' },
        posY: { type: 'number' },
        flipH: { type: 'boolean' },
        flipV: { type: 'boolean' },
        fill: { type: 'boolean' },
        reset: { type: 'boolean' },
      },
    },
  },
  {
    name: 'zaude_set_hsl',
    description: 'Add or adjust a selective HSL color band on a video clip (up to 8 colors simultaneously).',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        hex: { type: 'string', description: 'Target color hex code, e.g. #3b82f6' },
        hue: { type: 'number', description: 'Hue shift -180..180' },
        sat: { type: 'number', description: 'Saturation shift -100..100' },
        light: { type: 'number', description: 'Lightness shift -100..100' },
        range: { type: 'number', description: 'Hue range 1..100 (default 35)' },
        addNew: { type: 'boolean', description: 'Add as a new color slot instead of modifying the active one' },
        reset: { type: 'boolean' },
      },
    },
  },
  {
    name: 'zaude_set_transition',
    description: 'Set a clip transition: none, dissolve, fade-black, fade-white, or slide-left, plus duration in seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        type: { type: 'string', enum: ['none', 'dissolve', 'fade-black', 'fade-white', 'slide-left'] },
        duration: { type: 'number' },
      },
      required: ['type'],
    },
  },
  {
    name: 'zaude_separate_audio',
    description: 'Detach a video clip internal audio track onto a free Audio track (A1/A2) and mute the video.',
    inputSchema: { type: 'object', properties: { clipId: { type: 'string' } } },
  },
  {
    name: 'zaude_set_export',
    description: 'Configure Zaude Export settings (platform preset, aspect ratio, resolution tier, fps, quality, format, custom range) and optionally open the Export panel or start rendering.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['youtube', 'youtube4k', 'tiktok', 'square', 'cinema', 'preview'] },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:5', '21:9'] },
        resTier: { type: 'string', enum: ['720', '1080', '2160'] },
        fps: { type: 'number', enum: [24, 30, 60] },
        quality: { type: 'string', enum: ['draft', 'standard', 'high', 'ultra'] },
        format: { type: 'string', enum: ['MP4', 'MOV'] },
        rangeMode: { type: 'string', enum: ['full', 'custom'] },
        rangeStart: { type: 'number' },
        rangeEnd: { type: 'number' },
        openPanel: { type: 'boolean' },
        startRender: { type: 'boolean' },
      },
    },
  },
  {
    name: 'zaude_list_tips',
    description: 'List all editing tips and tricks currently saved on Zaude Help & Tips page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zaude_add_tip',
    description: 'Write a helpful editing tip or workflow trick onto Zaude Help & Tips page so the user can reference it anytime.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short descriptive title for the tip' },
        category: { type: 'string', description: 'Category such as Color, Timeline, Audio, Export, AI, or Controls' },
        author: { type: 'string', description: 'AI name (e.g. Antigravity, Claude, Codex, OpenCode)' },
        body: { type: 'string', description: 'Clear, actionable tip text' },
      },
      required: ['title', 'body'],
    },
  },
];

function readBridge() {
  try {
    const info = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    if (info && info.port && info.token) return info;
  } catch { /* Zaude not running */ }
  return null;
}

function callBridge(method, urlPath, bodyObj = null) {
  const bridge = readBridge();
  if (!bridge) {
    return Promise.resolve({ ok: false, error: 'Zaude desktop app is not running (no active bridge). Launch Zaude first.' });
  }
  return new Promise((resolve) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: bridge.port,
      path: urlPath,
      method,
      headers: {
        'X-Zaude-Token': bridge.token,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ ok: false, error: `Invalid bridge response (HTTP ${res.statusCode})` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: `Could not reach Zaude app: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out waiting for Zaude app.' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function handleToolCall(name, args = {}) {
  if (name === 'zaude_list_tips') {
    const tips = tipsStore.loadTips(TIPS_FILE);
    return { ok: true, count: tips.length, tips };
  }
  if (name === 'zaude_add_tip') {
    // Prefer going through the live bridge so the open UI updates immediately; fall back to direct disk write.
    const viaBridge = await callBridge('POST', '/api/tips', args);
    if (viaBridge && viaBridge.ok) return viaBridge;
    return tipsStore.addTip(TIPS_FILE, args);
  }
  if (name === 'zaude_get_state') {
    return callBridge('GET', '/api/state');
  }
  return callBridge('POST', '/api/tool', { tool: name, args });
}

// Pure JSON-RPC handler (exported for unit tests).
async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  if (method === 'notifications/initialized' || id === undefined) return null;

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'zaude-mcp', version: '0.1.1' },
        },
      };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      if (!TOOLS.some((t) => t.name === toolName)) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
      }
      const res = await handleToolCall(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          isError: res && res.ok === false,
        },
      };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message || String(err) } };
  }
}

function startStdioServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const reply = await handleRpcMessage(msg);
        if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      }
    }
  });
}

if (require.main === module) {
  startStdioServer();
}

module.exports = { TOOLS, handleRpcMessage, handleToolCall };
