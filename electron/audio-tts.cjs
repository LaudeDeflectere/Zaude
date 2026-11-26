// Cadence-Controlled Text-to-Speech, Auto-Duration Estimator, and Voice Changer prompt builder for Zaude.
// Automatically computes exact audio duration from text + cadence tags ([fast], [slow], [emotional], [pause 0.4s])
// so the user never has to guess seconds manually.

const TTS_CADENCE_AGENT_PROMPT = `SYSTEM INSTRUCTIONS FOR ZAUDE CADENCE-CONTROLLED TEXT-TO-SPEECH:
Rewrite my raw script into natural, expressive spoken dialogue annotated with inline Zaude cadence tags so the voice synthesizer nails pacing, emotion, and rhythm.

AVAILABLE INLINE TAGS:
- [fast]            -> brisk, energetic, ~3.0 words/sec
- [normal]          -> natural conversational pace, ~2.2 words/sec
- [slow]            -> deliberate, weighty, ~1.6 words/sec
- [emotional]       -> trembling, heartfelt, slightly slower (~1.7 words/sec)
- [whisper]         -> quiet, intimate, breathy (~1.9 words/sec)
- [urgent]          -> tense, pressured, slightly faster (~2.7 words/sec)
- [pause 0.4s]      -> explicit beat of silence (0.2s to 1.5s)

RULES:
1. Keep each single generation block under ~28 words (<= 13 seconds) so pacing stays crystal clear. If the script is longer, split it into separate paragraphs separated by a blank line.
2. Put tags right BEFORE the phrase they affect, e.g.:
   [fast] Wait—don't touch that door! [pause 0.4s] [slow, emotional] I told you what's waiting on the other side.
3. Return ONLY the tagged spoken text (no stage directions outside brackets, no quotes around the whole block).`;

function estimateSpeechDuration(rawText = '') {
  const txt = String(rawText || '').trim();
  if (!txt) return { seconds: 3, wordCount: 0, pauseSec: 0, segments: [], cadenceSummary: 'Normal pace' };

  // Split by bracketed cadence/pause tags while preserving tags
  const tokens = txt.split(/(\[[^\]]+\])/g).filter(Boolean);
  let curRate = 2.2; // words per second
  let curMood = 'natural conversational pace';
  let totalSec = 0;
  let totalWords = 0;
  let totalPause = 0;
  const segments = [];
  const moods = new Set();

  for (const tok of tokens) {
    const trimmed = tok.trim();
    if (!trimmed) continue;
    const tagMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (tagMatch) {
      const inner = tagMatch[1].toLowerCase();
      const pauseM = inner.match(/pause\s*([0-9.]+)\s*(ms|s)?/);
      if (pauseM) {
        const val = Number(pauseM[1]) || 0.4;
        const pSec = pauseM[2] === 'ms' ? val / 1000 : val;
        const clamped = Math.max(0.1, Math.min(3.0, pSec));
        totalSec += clamped;
        totalPause += clamped;
        continue;
      }
      if (/fast|quick|rapid/.test(inner)) { curRate = 3.0; curMood = 'fast brisk delivery'; moods.add('fast'); }
      else if (/urgent|panic|rush/.test(inner)) { curRate = 2.7; curMood = 'urgent tense delivery'; moods.add('urgent'); }
      else if (/slow|drawl|hesitat/.test(inner)) { curRate = 1.6; curMood = 'slow deliberate delivery'; moods.add('slow'); }
      else if (/emotional|sad|cry|trembl|tender/.test(inner)) { curRate = 1.7; curMood = 'deeply emotional delivery'; moods.add('emotional'); }
      else if (/whisper|quiet|soft/.test(inner)) { curRate = 1.9; curMood = 'soft intimate whisper'; moods.add('whisper'); }
      else if (/normal|neutral|calm/.test(inner)) { curRate = 2.2; curMood = 'natural calm delivery'; moods.add('normal'); }
      else { curMood = inner; moods.add(inner); }
      continue;
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    totalWords += words.length;
    const punctCount = (trimmed.match(/[.!?…—]/g) || []).length;
    const commaCount = (trimmed.match(/[,;:]/g) || []).length;
    const segDur = (words.length / curRate) + punctCount * 0.22 + commaCount * 0.1;
    segments.push({ text: trimmed, mood: curMood, rate: curRate, dur: segDur });
    totalSec += segDur;
  }

  // Add 0.65s lead-in/tail breathing headroom; clamp to valid MiniMax-H3 range [2..15]
  const rawSeconds = Math.max(2, totalSec + 0.65);
  const seconds = Math.max(2, Math.min(15, Math.ceil(rawSeconds * 2) / 2));
  const cadenceSummary = moods.size ? Array.from(moods).join(' → ') : 'natural pace';
  return {
    seconds: Math.round(seconds),
    exactSeconds: Number(rawSeconds.toFixed(1)),
    wordCount: totalWords,
    pauseSec: Number(totalPause.toFixed(2)),
    segments,
    cadenceSummary,
    overLimit: rawSeconds > 15,
  };
}

function buildCadenceVoicePrompt({ text = '', refmodName = 'Speaker', delivery = '' } = {}) {
  const est = estimateSpeechDuration(text);
  const cleanSpeaker = String(refmodName || 'Speaker').trim() || 'Speaker';
  const dir = String(delivery || '').trim();
  const baseTone = dir ? `${dir}; ` : '';

  let cursor = 0.25;
  const timedLines = [];
  for (const seg of est.segments) {
    const startT = cursor;
    const endT = Math.min(est.seconds - 0.2, cursor + seg.dur);
    timedLines.push(
      `${startT.toFixed(2)}s–${endT.toFixed(2)}s (${seg.mood}): ${cleanSpeaker} speaks with ${seg.mood}, <d>[English] ${seg.text}</d>`
    );
    cursor = Math.min(est.seconds - 0.3, endT + 0.15);
  }

  const prompt = [
    `Close-up quiet studio portrait of ${cleanSpeaker} speaking cleanly to a close microphone in a silent treated booth (${baseTone}cadence arc: ${est.cadenceSummary}).`,
    timedLines.length ? timedLines.join('\n') : `0.25s–${(est.seconds - 0.25).toFixed(2)}s: ${cleanSpeaker} says, <d>[English] ${String(text || '').trim()}</d>`,
    'overall_soundscape: Crystal-clear dry studio voice, zero background music, zero room echo, zero crowd noise.',
    'non_diegetic_music: None.',
  ].join('\n');

  return { prompt, seconds: est.seconds, estimate: est };
}

module.exports = {
  TTS_CADENCE_AGENT_PROMPT,
  estimateSpeechDuration,
  buildCadenceVoicePrompt,
};
