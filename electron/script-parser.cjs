// Parser for Zaude Multi-Shot Cinematic Scripts (.md / .txt).
// Supports both the classic Mannimmate H3 syntax (subject_definitions + --- + [Shot N])
// and the upgraded Zaude syntax (zaude_cast, background_lock, zaude_shot_config).

function parseTimestampToSeconds(ts) {
  const m = String(ts || '').trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const mins = m[1] ? Number(m[1]) : 0;
  const secs = Number(m[2]);
  if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
  return mins * 60 + secs;
}

function parseCastSection(text) {
  const cast = new Map(); // slotNum -> { slot, file, name, identityStrength, voiceStrength }
  let backgroundLock = { type: 'none', value: '' };
  const m = text.match(/zaude_cast:\s*\n([\s\S]*?)(?=\n(?:subject_definitions:|style_definitions:|zaude_shot_config:|---)|$)/i);
  if (!m) return { cast, backgroundLock };

  const lines = m[1].split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s*[-*]\s*/, '').trim();
    if (!line || line.startsWith('#')) continue;

    if (/^background_lock\s*:/i.test(line)) {
      const val = line.replace(/^background_lock\s*:/i, '').trim();
      const pic = val.match(/picture\s*=\s*([^|\s#]+)/i);
      const rm = val.match(/refmod\s*=\s*([^|\s#]+)/i);
      if (pic && pic[1] && !/^</.test(pic[1])) {
        backgroundLock = { type: 'picture', value: pic[1].trim() };
      } else if (rm && rm[1] && !/^</.test(rm[1])) {
        backgroundLock = { type: 'refmod', value: rm[1].trim().split('|')[0] };
      }
      continue;
    }

    const subjMatch = line.match(/<Subject\s+(\d+)>\s*:\s*(.+)$/i);
    if (!subjMatch) continue;
    const slot = Number(subjMatch[1]);
    const rest = subjMatch[2];
    const fileM = rest.match(/refmod\s*=\s*([^|\s#]+)/i);
    const nameM = rest.match(/name\s*=\s*([^|#]+)/i);
    const idM = rest.match(/identity\s*=\s*([0-9.]+)/i);
    const voiceM = rest.match(/voice\s*=\s*([0-9.]+)/i);
    const file = fileM ? fileM[1].trim() : '';
    const name = nameM ? nameM[1].trim() : (file || `Subject ${slot}`);
    cast.set(slot, {
      slot,
      file,
      name,
      identityStrength: idM ? Number(idM[1]) : 1.0,
      voiceStrength: voiceM ? Number(voiceM[1]) : 1.0,
    });
  }
  return { cast, backgroundLock };
}

function parseGlobalSubjectDefinitions(text) {
  const defs = new Map(); // slotNum -> full line
  const m = text.match(/subject_definitions:\s*\n([\s\S]*?)(?=\n(?:retention_analysis:|detailed_description:|style_definitions:|zaude_shot_config:|\[Shot\s+\d+\]|---)|$)/i);
  if (!m) return defs;
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const sm = line.match(/^<Subject\s+(\d+)>/i);
    if (sm) {
      defs.set(Number(sm[1]), line);
    }
  }
  return defs;
}

function parseShotConfig(block) {
  const cfg = {
    shot: null,
    engine: '',
    mode: '',
    stylizeAction: '',
    castSlots: [],
    speakingSlots: [],
    background: '',
    resolution: null,
    fps: null,
    seconds: null,
    steps: null,
    aspect: '',
    seed: null,
    post: '',
  };
  const m = block.match(/zaude_shot_config:\s*\n([\s\S]*?)(?=\n(?:style_definitions:|retention_analysis:|detailed_description:|\[Shot\s+\d+\]|subject_definitions:)|$)/i);
  if (!m) return { cfg, strippedBlock: block };

  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const kv = line.match(/^([a-z_]+)\s*:\s*(.+)$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();

    if (key === 'shot') cfg.shot = Number(val) || null;
    else if (key === 'engine') cfg.engine = val.toLowerCase();
    else if (key === 'mode') {
      if (val.toLowerCase().startsWith('stylize:')) {
        cfg.mode = 'auto';
        cfg.stylizeAction = val.split(':')[1].trim().toLowerCase();
      } else {
        cfg.mode = val.toLowerCase();
      }
    } else if (key === 'cast_in_shot') {
      const nums = [...val.matchAll(/<Subject\s+(\d+)>/gi)].map((x) => Number(x[1]));
      cfg.castSlots = Array.from(new Set(nums));
    } else if (key === 'speaking') {
      const nums = [...val.matchAll(/<Subject\s+(\d+)>/gi)].map((x) => Number(x[1]));
      cfg.speakingSlots = Array.from(new Set(nums));
    } else if (key === 'background') {
      cfg.background = val;
    } else if (key === 'post') {
      cfg.post = val.toLowerCase();
    } else if (key === 'settings') {
      const resM = val.match(/(\d{3,4})p/i);
      const fpsM = val.match(/(\d+)\s*fps/i);
      const secM = val.match(/(\d+(?:\.\d+)?)\s*s\b/i);
      const stepM = val.match(/(\d+)\s*steps?/i);
      const aspM = val.match(/\b(16:9|9:16)\b/);
      const seedM = val.match(/seed\s*=\s*(\d+)/i);
      if (resM) cfg.resolution = Number(resM[1]);
      if (fpsM) cfg.fps = Number(fpsM[1]);
      if (secM) cfg.seconds = Number(secM[1]);
      if (stepM) cfg.steps = Number(stepM[1]);
      if (aspM) cfg.aspect = aspM[1];
      if (seedM) cfg.seed = Number(seedM[1]);
    }
  }

  const strippedBlock = block.replace(m[0], '').trim();
  return { cfg, strippedBlock };
}

function parseMultiShotScript(rawText) {
  const clean = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return { ok: false, error: 'Script is empty.', shots: [] };

  const { cast, backgroundLock } = parseCastSection(clean);
  const globalSubjects = parseGlobalSubjectDefinitions(clean);

  // Split into sections by horizontal rule `---` on its own line
  let rawBlocks = clean
    .split(/\n\s*---+\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  // Filter out header-only blocks (containing only zaude_cast / subject_definitions and no [Shot N])
  let shotBlocks = rawBlocks.filter((b) => /\[Shot\s+\d+\]/i.test(b) || /detailed_description:|style_definitions:/i.test(b));

  // If the user didn't use `---` between multiple `[Shot N]` blocks, split on `[Shot N]`
  if (shotBlocks.length === 1 && (shotBlocks[0].match(/\[Shot\s+\d+\]/gi) || []).length > 1) {
    const single = shotBlocks[0];
    const parts = single.split(/(?=\[Shot\s+\d+\])/i).map((p) => p.trim()).filter(Boolean);
    const preamble = !/^\[Shot\s+\d+\]/i.test(parts[0]) ? parts.shift() : '';
    shotBlocks = parts.map((p) => (preamble ? `${preamble}\n\n${p}` : p));
  }

  // Strip global zaude_cast and global subject_definitions from the first block if they were combined without `---`
  const shots = shotBlocks.map((rawBlock, idx) => {
    let block = rawBlock
      .replace(/zaude_cast:\s*\n[\s\S]*?(?=\n(?:subject_definitions:|style_definitions:|zaude_shot_config:|\[Shot\s+\d+\])|$)/i, '')
      .trim();

    const { cfg, strippedBlock } = parseShotConfig(block);
    block = strippedBlock;

    // Extract [Shot N] header & duration from `lasting 00:00.000–00:05.000`
    const shotHeaderM = block.match(/\[Shot\s+(\d+)\]([^\n]*)/i);
    const shotNumber = cfg.shot || (shotHeaderM ? Number(shotHeaderM[1]) : idx + 1);
    let parsedSeconds = cfg.seconds;
    if (!parsedSeconds && shotHeaderM) {
      const durM = shotHeaderM[2].match(/(\d+:\d+(?:\.\d+)?)\s*[–-]\s*(\d+:\d+(?:\.\d+)?)/);
      if (durM) {
        const s0 = parseTimestampToSeconds(durM[1]);
        const s1 = parseTimestampToSeconds(durM[2]);
        if (s0 != null && s1 != null && s1 > s0) {
          parsedSeconds = Math.max(1, Math.min(30, Math.round(s1 - s0)));
        }
      }
    }
    const seconds = parsedSeconds || 5;

    // Extract summary line for UI display
    const summaryM = block.match(/summary\s*:\s*([^\n]+)/i);
    const summary = summaryM
      ? summaryM[1].trim()
      : (shotHeaderM ? shotHeaderM[2].replace(/lasting\s+[^\n]+/i, '').trim() : `Shot ${shotNumber}`);

    // Determine which <Subject N> slots actually appear in this shot (after removing any inline subject_definitions)
    const blockNoSubjDefs = block.replace(/subject_definitions:\s*\n[\s\S]*?(?=\n(?:retention_analysis:|detailed_description:|style_definitions:|\[Shot\s+\d+\])|$)/i, '').trim();
    const detectedSlots = cfg.castSlots.length
      ? cfg.castSlots
      : Array.from(new Set([...blockNoSubjDefs.matchAll(/<Subject\s+(\d+)>/gi)].map((x) => Number(x[1])))).sort((a, b) => a - b);

    // Build filtered subject_definitions ONLY for characters present in this shot,
    // and renumber <Subject N> / (SN) densely to 1..K so mannimmate_cli.py --refmod slot indices match 1-to-1!
    const slotRemap = new Map();
    detectedSlots.forEach((oldSlot, i) => slotRemap.set(oldSlot, i + 1));
    const remapText = (txt) => String(txt || '')
      .replace(/<Subject\s+(\d+)>/gi, (m, num) => {
        const mapped = slotRemap.get(Number(num));
        return mapped ? `<Subject ${mapped}>` : m;
      })
      .replace(/\(S(\d+)\)/g, (m, num) => {
        const mapped = slotRemap.get(Number(num));
        return mapped ? `(S${mapped})` : m;
      });

    const activeDefLines = detectedSlots
      .map((slot) => globalSubjects.get(slot))
      .filter(Boolean)
      .map((line) => remapText(line));

    const promptParts = [];
    if (activeDefLines.length) {
      promptParts.push('subject_definitions:\n' + activeDefLines.join('\n'));
    }
    promptParts.push(remapText(blockNoSubjDefs));
    const assembledPrompt = promptParts.join('\n\n').trim();

    // Resolve RefMods for the present cast slots
    const refmods = detectedSlots
      .map((slot) => cast.get(slot))
      .filter((c) => c && c.file)
      .map((c) => ({
        file: c.file,
        name: c.name,
        identityStrength: c.identityStrength,
        voiceStrength: c.voiceStrength,
      }));

    // Determine mode
    let mode = cfg.mode || (refmods.length ? 'refmod' : 'text-render');
    let refmodMode = 'generate';
    if (mode === 'continue') {
      mode = 'refmod';
      refmodMode = 'continue';
    }

    // Resolve background override
    let backgroundImage = backgroundLock.type === 'picture' ? backgroundLock.value : '';
    let backgroundRefmod = backgroundLock.type === 'refmod' ? backgroundLock.value : '';
    if (cfg.background) {
      const picM = cfg.background.match(/^picture\s*:\s*(.+)$/i);
      const rmM = cfg.background.match(/^refmod\s*:\s*(.+)$/i);
      if (picM) backgroundImage = picM[1].trim();
      else if (rmM) backgroundRefmod = rmM[1].trim().split('|')[0];
    }

    return {
      index: idx,
      shotNumber,
      summary: summary || `Shot ${shotNumber}`,
      engine: cfg.engine || 'tranklena',
      mode,
      refmodMode,
      stylizeAction: cfg.stylizeAction || '',
      castSlots: detectedSlots,
      refmods,
      seconds,
      resolution: cfg.resolution || 640,
      fps: cfg.fps || 24,
      steps: cfg.steps || null,
      aspect: cfg.aspect || '16:9',
      seed: cfg.seed || null,
      backgroundImage,
      backgroundRefmod,
      post: cfg.post || 'none',
      prompt: assembledPrompt,
    };
  });

  if (!shots.length) {
    return { ok: false, error: 'No shots found. Separate shots with --- or [Shot 1], [Shot 2] headers.', shots: [] };
  }

  return {
    ok: true,
    cast: Array.from(cast.values()),
    backgroundLock,
    shotCount: shots.length,
    shots,
  };
}

module.exports = {
  parseMultiShotScript,
  parseTimestampToSeconds,
};
