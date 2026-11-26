// Exports a Zaude timeline project into a reproducible, human-editable Multi-Shot .txt script
// that can be re-imported into Zaude's Multi-Shot tab to redo, remix, or share any project.

function formatSeconds(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(3).padStart(6, '0');
  return `${String(m).padStart(2, '0')}:${rem}`;
}

function exportProjectToScript(projectState = {}, opts = {}) {
  const title = opts.title || projectState.name || 'Zaude Project Script';
  const clips = Array.isArray(projectState.clips) ? [...projectState.clips] : [];
  clips.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));

  // Collect unique RefMods referenced in clip aiMeta / sidecars
  const castFiles = [];
  const castSlotOf = new Map();
  for (const c of clips) {
    const meta = c.aiMeta || c.meta || {};
    const mods = Array.isArray(meta.refmods) ? meta.refmods : (meta.refmod ? [meta.refmod] : []);
    for (const m of mods) {
      const f = typeof m === 'string' ? m : (m && m.file);
      if (f && !castSlotOf.has(f)) {
        castFiles.push(f);
        castSlotOf.set(f, castFiles.length);
      }
    }
  }

  const lines = [];
  lines.push(`# ${title}`);
  lines.push(`# Exported by Zaude — paste or upload into Multi-Shot (.md/.txt) to redo or remix.`);
  lines.push('');

  if (castFiles.length) {
    lines.push('zaude_cast:');
    castFiles.forEach((file, i) => {
      const name = file.split(/[\\/]/).pop().replace(/\.safetensors$/i, '');
      lines.push(`- <Subject ${i + 1}>: refmod=${file} | name=${name} | identity=1.0 | voice=1.0`);
    });
    lines.push('');
  }

  clips.forEach((clip, idx) => {
    const shotNum = idx + 1;
    const meta = clip.aiMeta || clip.meta || {};
    const dur = Math.max(0.5, Number(clip.dur) || 5);
    const srcIn = Number(clip.srcIn) || 0;
    const speed = Number(clip.speed) || 1;
    const filePath = clip.filePath || clip.path || clip.src || '';
    const mods = Array.isArray(meta.refmods) ? meta.refmods : (meta.refmod ? [meta.refmod] : []);
    const slots = mods
      .map((m) => castSlotOf.get(typeof m === 'string' ? m : (m && m.file)))
      .filter(Boolean);

    lines.push('---');
    lines.push('');
    lines.push('zaude_shot_config:');
    lines.push(`shot: ${shotNum}`);
    lines.push(`engine: ${meta.engine || 'tranklena'}`);
    lines.push(`mode: ${meta.mode || (slots.length ? 'refmod' : 'text-render')}`);
    if (slots.length) lines.push(`cast_in_shot: ${slots.map((n) => `<Subject ${n}>`).join(', ')}`);
    if (meta.model) lines.push(`model: ${meta.model}`);
    if (meta.lora) lines.push(`lora: ${meta.lora}`);
    if (meta.loraStrength != null) lines.push(`lora_strength: ${meta.loraStrength}`);
    if (meta.refmodLock != null) lines.push(`refmod_lock: ${meta.refmodLock}`);
    if (meta.outfitOverride) lines.push(`outfit_override: ${meta.outfitOverride}`);
    if (meta.backgroundImage) lines.push(`background: picture:${meta.backgroundImage}`);
    else if (meta.backgroundRefmod) lines.push(`background: refmod:${meta.backgroundRefmod}`);
    if (meta.outpaintAspect && meta.outpaintAspect !== 'keep') lines.push(`outpaint_aspect: ${meta.outpaintAspect}`);
    if (meta.cameraPullback && Number(meta.cameraPullback) !== 1) lines.push(`camera_pullback: ${meta.cameraPullback}`);
    if (filePath) lines.push(`file: ${filePath}`);
    if (srcIn > 0) lines.push(`trim_in: ${srcIn.toFixed(2)}`);
    if (speed !== 1) lines.push(`speed: ${speed}`);
    const res = meta.resolution || 640;
    const fps = meta.fps || 24;
    const steps = meta.steps || 6;
    const aspect = meta.aspect || '16:9';
    const seedPart = meta.seed ? ` | seed=${meta.seed}` : '';
    lines.push(`settings: ${res}p | ${fps}fps | ${Math.round(dur)}s | ${steps} steps | ${aspect}${seedPart}`);
    lines.push('');
    lines.push(`[Shot ${shotNum}] ${clip.name || `Clip ${shotNum}`} lasting 00:00.000–${formatSeconds(dur)}.`);
    lines.push(`summary: ${meta.summary || clip.name || `Shot ${shotNum}`}`);
    if (meta.prompt) {
      lines.push(meta.prompt.trim());
    } else {
      lines.push(`00:00.000–${formatSeconds(dur)}:`);
      lines.push(`Timeline clip "${clip.name || `Clip ${shotNum}`}"${filePath ? ` from ${filePath}` : ''}.`);
    }
    lines.push('');
  });

  return lines.join('\n').trim() + '\n';
}

module.exports = { exportProjectToScript };
