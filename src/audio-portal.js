// 🎙️ Audio-First & Lip-Sync Control Portal for Zaude.
// Step 1: Generate dialogue audio via Character RefMod (or record mic / import audio) onto timeline.
// Step 2: Manually Time Warp (0.25x..4.0x) a video clip so its duration matches the dialogue audio.
// Step 3: Select the video + audio clips and 1-click Lip-Sync on Tranklena (baking Time Warp + trims).
import * as T from './timeline.js';

const $ = (id) => document.getElementById(id);

export function initAudioPortal({ store, actions }) {
  const openBtn = $('audio-portal-open');
  const dlg = $('audio-portal-dialog');
  if (!openBtn || !dlg) return;

  const api = window.zaudeAI || null;
  let mediaRecorder = null;
  let recChunks = [];
  let recStream = null;
  let refmodsLoaded = false;

  function findSelectedPair() {
    const s = store.get();
    const selIds = s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : []);
    const selClips = selIds.map((id) => T.findClip(s.clips, id)).filter(Boolean);
    const vClip = selClips.find((c) => c.kind === 'video' && c.path)
      || (s.selected ? (() => { const c = T.findClip(s.clips, s.selected); return c && c.kind === 'video' && c.path ? c : null; })() : null)
      || s.clips.find((c) => c.kind === 'video' && c.path) || null;
    const aClip = selClips.find((c) => c.kind === 'audio' && c.path)
      || (s.selected ? (() => { const c = T.findClip(s.clips, s.selected); return c && c.kind === 'audio' && c.path ? c : null; })() : null)
      || s.clips.find((c) => c.kind === 'audio' && c.path) || null;
    return { vClip, aClip };
  }

  function refreshPairUI() {
    const { vClip, aClip } = findSelectedPair();
    const vBadge = $('ap-video-badge');
    const aBadge = $('ap-audio-badge');
    const deltaEl = $('ap-delta-badge');
    const range = $('ap-speed-range');
    const num = $('ap-speed-num');
    const runBtn = $('ap-run-lipsync');

    if (vBadge) {
      vBadge.innerHTML = vClip
        ? `🎬 <b>${vClip.name}</b><br><span class="muted">${vClip.dur.toFixed(2)}s · ${(vClip.speed || 1).toFixed(2)}× (${vClip.track})</span>`
        : '🎬 Video: <i>Select a video clip on the timeline</i>';
    }
    if (aBadge) {
      aBadge.innerHTML = aClip
        ? `🔊 <b>${aClip.name}</b><br><span class="muted">${aClip.dur.toFixed(2)}s (${aClip.track})</span>`
        : '🔊 Audio: <i>Generate, record, or select an audio clip</i>';
    }
    if (vClip && range && num) {
      const sp = (Number(vClip.speed) || 1).toFixed(2);
      if (document.activeElement !== range) range.value = sp;
      if (document.activeElement !== num) num.value = sp;
    }
    if (deltaEl) {
      if (vClip && aClip) {
        const diff = vClip.dur - aClip.dur;
        const ok = Math.abs(diff) <= 0.15;
        deltaEl.textContent = ok ? '✓ Matched!' : `Δ ${diff > 0 ? '+' : ''}${diff.toFixed(2)}s`;
        deltaEl.style.color = ok ? '#34d399' : '#fbbf24';
      } else {
        deltaEl.textContent = '—';
        deltaEl.style.color = '';
      }
    }
    if (runBtn) runBtn.disabled = !(vClip && aClip);
  }

  async function loadRefmodVoices() {
    if (refmodsLoaded || !api || !api.refmodsList) return;
    try {
      const res = await api.refmodsList();
      const sel = $('ap-refmod');
      if (res && res.ok && Array.isArray(res.refmods) && sel) {
        sel.innerHTML = '<option value="">— Generic Studio Voice —</option>' +
          res.refmods.map((m) => `<option value="${m.file}" data-name="${m.name || m.firstName || m.file}">${m.name || m.firstName || m.file} (${m.category || 'Characters'})</option>`).join('');
        refmodsLoaded = true;
      }
    } catch { /* ignore */ }
  }

  function open() {
    dlg.hidden = false;
    loadRefmodVoices();
    refreshPairUI();
  }

  function close() {
    dlg.hidden = true;
  }

  openBtn.addEventListener('click', open);
  $('ap-close')?.addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });

  store.subscribe(() => {
    if (!dlg.hidden) refreshPairUI();
  });

  // Step 1A: Generate Dialogue Voice Audio via Tranklena MiniMax-H3 RefMod
  $('ap-gen-voice')?.addEventListener('click', async () => {
    if (!api || !api.generateVoiceAudio) return;
    const dialogue = ($('ap-dialogue')?.value || '').trim();
    const delivery = ($('ap-delivery')?.value || '').trim();
    const seconds = Number($('ap-seconds')?.value) || 4;
    const sel = $('ap-refmod');
    const refmod = sel ? sel.value : '';
    const refmodName = sel && sel.selectedOptions[0] ? (sel.selectedOptions[0].dataset.name || sel.selectedOptions[0].textContent) : 'Speaker';
    const st = $('ap-voice-status');
    const btn = $('ap-gen-voice');
    if (!dialogue) {
      if (st) st.textContent = 'Type a dialogue line first.';
      return;
    }
    btn.disabled = true;
    if (st) st.textContent = `Generating ${seconds}s voice audio on Tranklena (320p · 4 steps)…`;
    try {
      const res = await api.generateVoiceAudio({ dialogue, delivery, seconds, refmod, refmodName });
      if (res && res.ok && res.path) {
        actions.insertAudioClip({ path: res.path, url: res.url, name: res.name, dur: res.dur });
        if (st) st.textContent = `✓ Added "${res.name}" (${(res.dur || seconds).toFixed(2)}s) to timeline!`;
        refreshPairUI();
      } else {
        if (st) st.textContent = `Error: ${(res && res.error) || 'Voice generation failed'}`;
      }
    } catch (e) {
      if (st) st.textContent = `Error: ${e.message || e}`;
    } finally {
      btn.disabled = false;
    }
  });

  // Step 1B: Record Microphone directly onto timeline
  $('ap-record-btn')?.addEventListener('click', async () => {
    const btn = $('ap-record-btn');
    const st = $('ap-voice-status');
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      btn.textContent = '🎤 Record Mic';
      return;
    }
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      mediaRecorder = new MediaRecorder(recStream);
      mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
      mediaRecorder.onstop = async () => {
        try { recStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        const blob = new Blob(recChunks, { type: 'audio/webm' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (st) st.textContent = 'Saving 48 kHz WAV recording…';
        const res = api && api.saveAudioRecording ? await api.saveAudioRecording({ bytes, name: 'mic_voice' }) : null;
        if (res && res.ok && res.path) {
          actions.insertAudioClip({ path: res.path, url: res.url, name: res.name, dur: res.dur });
          if (st) st.textContent = `✓ Recorded "${res.name}" (${(res.dur || 1).toFixed(2)}s) onto timeline!`;
          refreshPairUI();
        } else {
          if (st) st.textContent = `Recording failed: ${(res && res.error) || 'unknown error'}`;
        }
      };
      mediaRecorder.start();
      btn.textContent = '⏹ Stop Recording';
      if (st) st.textContent = '🔴 Recording microphone… click Stop when done.';
    } catch (e) {
      if (st) st.textContent = `Microphone error: ${e.message || e}`;
    }
  });

  // Step 1C: Import Existing Audio File onto timeline
  $('ap-import-btn')?.addEventListener('click', async () => {
    if (!api || !api.pickAudioFile) return;
    const picked = await api.pickAudioFile();
    if (!picked || picked.canceled || !picked.path) return;
    const url = await (window.zaudeDesktop && window.zaudeDesktop.mediaUrl ? window.zaudeDesktop.mediaUrl(picked.path) : null);
    actions.insertAudioClip({ path: picked.path, url, name: picked.name, dur: picked.dur || 5 });
    const st = $('ap-voice-status');
    if (st) st.textContent = `✓ Added "${picked.name}" to timeline!`;
    refreshPairUI();
  });

  // Step 2: Time Warp slider & Auto-Match button
  const applyWarp = (val, live) => {
    const { vClip } = findSelectedPair();
    if (!vClip) return;
    actions.select(vClip.id);
    actions.setSpeed(Number(val), live);
    refreshPairUI();
  };
  $('ap-speed-range')?.addEventListener('input', (e) => applyWarp(e.target.value, true));
  $('ap-speed-range')?.addEventListener('change', (e) => applyWarp(e.target.value, false));
  $('ap-speed-num')?.addEventListener('change', (e) => applyWarp(e.target.value, false));
  $('ap-match-audio')?.addEventListener('click', () => {
    const { vClip, aClip } = findSelectedPair();
    if (vClip && aClip) {
      actions.selectMany([vClip.id, aClip.id]);
      actions.matchAudioDuration();
      refreshPairUI();
    }
  });

  // Step 3: 1-Click Lip-Sync Selected Video + Audio (baking manual Time Warp + trims)
  $('ap-run-lipsync')?.addEventListener('click', async () => {
    if (!api || !api.lipSyncClip) return;
    const { vClip, aClip } = findSelectedPair();
    const st = $('ap-lipsync-status');
    const btn = $('ap-run-lipsync');
    if (!vClip || !aClip) {
      if (st) st.textContent = 'Select 1 video clip and 1 audio clip first.';
      return;
    }
    const roomPreset = $('ap-room-preset')?.value || 'none';
    btn.disabled = true;
    if (st) st.textContent = `Baking Time Warp (${(vClip.speed || 1).toFixed(2)}×) & running Lip-Sync on Tranklena…`;
    try {
      const res = await api.lipSyncClip({
        videoPath: vClip.path,
        videoSrcIn: Number(vClip.srcIn) || 0,
        videoDur: Number(vClip.dur) || 0,
        videoSpeed: Number(vClip.speed) || 1,
        audioPath: aClip.path,
        audioSrcIn: Number(aClip.srcIn) || 0,
        audioDur: Number(aClip.dur) || 0,
        roomPreset,
        roomIntensity: 1.0,
      });
      if (res && res.ok && res.output) {
        actions.replaceClipWithSynced({ clipId: vClip.id, path: res.output, url: res.url, dur: res.dur || aClip.dur });
        if (st) st.textContent = `✓ Lip-synced "${vClip.name}" to "${aClip.name}" and updated timeline in-place!`;
        refreshPairUI();
      } else {
        if (st) st.textContent = `Lip-sync failed: ${(res && res.error) || 'unknown error'}`;
      }
    } catch (e) {
      if (st) st.textContent = `Lip-sync error: ${e.message || e}`;
    } finally {
      btn.disabled = false;
    }
  });
}
