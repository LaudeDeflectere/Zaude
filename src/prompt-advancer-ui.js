// Frontend controller for Zaude's AI Prompt Advancer & Learning Prompt Database.
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function getFormContext(targetField) {
  const form = $('t2v-form');
  if (!form) return { mode: 'text-render', context: {} };
  const fd = new FormData(form);
  let mode = String(fd.get('mode') || 'text-render');
  const refmodMode = String(fd.get('refmodMode') || 'generate');
  const hasFirstFrame = Boolean(String(fd.get('firstFrame') || '').trim());
  const hasLastFrame = Boolean(String(fd.get('lastFrame') || '').trim());
  const isContinue = mode === 'refmod' && refmodMode === 'continue';

  if (targetField === 'objectPrompt' || mode === 'auto') {
    mode = 'stylize';
  } else if (isContinue) {
    mode = 'continue';
  } else if (hasFirstFrame && hasLastFrame) {
    mode = 'fl2v';
  }

  // Gather selected RefMod character names from active tiles if present
  const refmods = [];
  document.querySelectorAll('#ai-refmod-grid .refmod-tile.selected .refmod-name').forEach((el) => {
    const t = el.textContent.trim();
    if (t) refmods.push(t);
  });

  const activeStylizeBtn = document.querySelector('#ai-stylize-pills button.on');
  return {
    mode,
    context: {
      seconds: Number(fd.get('seconds')) || 7,
      resolution: Number(fd.get('resolution')) || 640,
      aspect: String(fd.get('aspect') || '16:9'),
      refmods,
      hasFirstFrame,
      hasLastFrame,
      isContinue,
      stylizeAction: activeStylizeBtn ? activeStylizeBtn.dataset.stylizeAct : '',
    },
  };
}

function initPromptAdvancerUi() {
  const api = window.zaudePrompt;
  const form = $('t2v-form');
  const panel = $('pa-panel');
  const dbPanel = $('pdb-panel');
  if (!api || !form || !panel || !dbPanel) return;

  let activeTarget = 'prompt'; // 'prompt' | 'objectPrompt'
  let currentDraft = '';
  let lastResult = null;
  let dbCache = [];
  let busy = false;

  const getTextarea = () => form.elements[activeTarget] || form.elements.prompt;

  function setStatus(text, isErr = false) {
    const el = $('pa-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isErr ? '#f87171' : '';
  }

  function renderQuestions(questions) {
    const box = $('pa-questions');
    if (!questions || !questions.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="pa-subhead">Clarifying Questions <span class="muted">(pick options or type below, then click Refine)</span></div>
      ${questions.map((q, idx) => `
        <div class="pa-q-item" data-q-idx="${idx}" data-q-text="${esc(q.question)}">
          <div class="pa-q-label">${idx + 1}. ${esc(q.question)}</div>
          ${q.options && q.options.length ? `
            <div class="pa-q-chips">
              ${q.options.map((opt) => `<button type="button" class="pa-chip" data-chip-val="${esc(opt)}">${esc(opt)}</button>`).join('')}
            </div>
          ` : ''}
          <input type="text" class="pa-q-input" placeholder="Your answer (click a chip above or type custom)…">
        </div>
      `).join('')}
      <div class="pa-q-footer">
        <button type="button" class="ai-btn-purple" id="pa-refine-btn">✨ Refine Prompt with My Answers</button>
      </div>
    `;
  }

  function renderResult(res) {
    lastResult = res;
    const matchedEl = $('pa-matched');
    const refs = res.referencedExamples || [];
    if (refs.length) {
      matchedEl.hidden = false;
      matchedEl.innerHTML = `<span class="muted">Compared against Prompt DB:</span> ` +
        refs.map((r) => `<span class="pa-ref-pill">📚 ${esc(r.title)} (${'★'.repeat(r.rating || 4)})</span>`).join(' ');
    } else {
      matchedEl.hidden = true;
    }

    renderQuestions(res.questions || []);

    const outBox = $('pa-result');
    outBox.hidden = false;
    $('pa-output').value = res.enhancedPrompt || '';
    $('pa-title').value = res.suggestedTitle || '';
    $('pa-notes').value = '';

    const impEl = $('pa-improvements');
    const imps = res.improvements || [];
    impEl.innerHTML = imps.map((i) => `<li>${esc(i)}</li>`).join('');
    impEl.hidden = !imps.length;

    const statusMsg = res.status === 'clarify' && res.questions && res.questions.length
      ? `${res.provider || 'AI'} asked ${res.questions.length} clarifying question(s) + drafted an upgraded prompt`
      : `Enhanced by ${res.provider || 'AI'} — ready to apply`;
    setStatus(statusMsg);
  }

  async function runAdvance(answers = []) {
    const ta = getTextarea();
    const draft = String((ta && ta.value) || '').trim();
    currentDraft = draft;
    const { mode, context } = getFormContext(activeTarget);
    const provider = $('pa-provider').value || 'auto';

    panel.hidden = false;
    dbPanel.hidden = true;
    busy = true;
    $('pa-cancel').hidden = false;
    $('pa-questions').hidden = true;
    $('pa-result').hidden = true;
    $('pa-matched').hidden = true;
    setStatus(answers.length ? 'Refining prompt with your answers…' : 'Analyzing draft & comparing against Prompt Database…');

    const res = await api.advance({ draft, mode, context, answers, provider });
    if (!res || !res.ok) {
      busy = false;
      $('pa-cancel').hidden = true;
      setStatus((res && res.error) || 'Failed to start AI Prompt Advancer', true);
    }
  }

  api.onEvent((ev) => {
    if (!ev) return;
    if (ev.type === 'start') {
      setStatus(`Running ${ev.provider || 'AI'} (comparing ${ev.referencedCount || 0} Prompt DB examples)…`);
    } else if (ev.type === 'done') {
      busy = false;
      $('pa-cancel').hidden = true;
      if (ev.cancelled) {
        setStatus('Cancelled.');
        return;
      }
      if (!ev.ok) {
        setStatus(ev.error || 'AI Prompt Advancer failed.', true);
        return;
      }
      renderResult(ev);
    }
  });

  // Wire "✨ Advance Prompt" and "📚 Prompt DB" buttons
  document.addEventListener('click', (e) => {
    const advBtn = e.target.closest('[data-prompt-advance-target]');
    if (advBtn) {
      activeTarget = advBtn.dataset.promptAdvanceTarget || 'prompt';
      runAdvance([]);
      return;
    }
    const dbBtn = e.target.closest('[data-prompt-db-toggle]');
    if (dbBtn) {
      activeTarget = dbBtn.dataset.promptDbToggle || 'prompt';
      const opening = dbPanel.hidden;
      dbPanel.hidden = !opening;
      if (opening) {
        panel.hidden = true;
        refreshDb();
      }
      return;
    }
    // Clickable clarifying question option chips
    const chip = e.target.closest('.pa-chip');
    if (chip) {
      const item = chip.closest('.pa-q-item');
      if (item) {
        const input = item.querySelector('.pa-q-input');
        const val = chip.dataset.chipVal || '';
        item.querySelectorAll('.pa-chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        if (input) input.value = val;
      }
      return;
    }
    // Refine with user's clarifying answers
    if (e.target.closest('#pa-refine-btn')) {
      const answers = [];
      panel.querySelectorAll('.pa-q-item').forEach((item) => {
        const qText = item.dataset.qText || '';
        const ans = String((item.querySelector('.pa-q-input') || {}).value || '').trim();
        if (qText && ans) answers.push({ question: qText, answer: ans });
      });
      if (!answers.length) {
        setStatus('Pick an option or type at least one answer to refine.', true);
        return;
      }
      runAdvance(answers);
      return;
    }
  });

  $('pa-cancel').addEventListener('click', () => {
    api.cancel();
    busy = false;
    $('pa-cancel').hidden = true;
    setStatus('Cancelling…');
  });
  $('pa-close').addEventListener('click', () => {
    if (busy) api.cancel();
    panel.hidden = true;
  });
  $('pa-rerun').addEventListener('click', () => runAdvance([]));

  function applyPrompt(alsoSave) {
    const enhanced = String($('pa-output').value || '').trim();
    if (!enhanced) return;
    const ta = getTextarea();
    if (ta) {
      ta.value = enhanced;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    }
    if (alsoSave) {
      const { mode } = getFormContext(activeTarget);
      api.saveDb({
        title: String($('pa-title').value || '').trim() || (lastResult && lastResult.suggestedTitle) || '',
        mode,
        originalDraft: currentDraft,
        enhancedPrompt: enhanced,
        notes: String($('pa-notes').value || '').trim(),
        tags: (lastResult && lastResult.suggestedTags) || [mode],
        rating: 5,
      }).then((r) => {
        if (r && r.ok) {
          dbCache = r.examples || dbCache;
          setStatus('Applied & saved to Prompt Database! Future runs will learn from it.');
        }
      });
    } else {
      panel.hidden = true;
    }
  }

  $('pa-apply').addEventListener('click', () => applyPrompt(false));
  $('pa-apply-save').addEventListener('click', () => applyPrompt(true));

  // ---------- Learning Prompt Database Drawer ----------
  async function refreshDb() {
    const res = await api.listDb();
    dbCache = (res && res.examples) || [];
    renderDbList();
  }

  function renderDbList() {
    const q = String(($('pdb-search') || {}).value || '').trim().toLowerCase();
    const modeFilter = String(($('pdb-filter-mode') || {}).value || '');
    const filtered = dbCache.filter((ex) => {
      if (modeFilter && ex.mode !== modeFilter) return false;
      if (!q) return true;
      const hay = `${ex.title} ${ex.enhancedPrompt} ${ex.notes || ''} ${(ex.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });

    $('pdb-count').textContent = `(${dbCache.length} saved)`;
    const listEl = $('pdb-list');
    if (!filtered.length) {
      listEl.innerHTML = `<div class="muted" style="padding:10px;text-align:center">No matching prompts yet. Save working prompts to teach the AI!</div>`;
      return;
    }
    listEl.innerHTML = filtered.map((ex) => {
      const stars = [1, 2, 3, 4, 5].map((n) =>
        `<button type="button" class="pdb-star ${n <= (ex.rating || 4) ? 'on' : ''}" data-pdb-rate="${esc(ex.id)}" data-stars="${n}" title="Rate ${n}/5">★</button>`
      ).join('');
      return `
        <div class="pdb-card" data-pdb-id="${esc(ex.id)}">
          <div class="pdb-card-head">
            <span class="pdb-mode">${esc(ex.mode || 'text')}</span>
            <strong class="pdb-title">${esc(ex.title)}</strong>
            <span class="pdb-stars">${stars}</span>
            <button type="button" class="pdb-use" data-pdb-use="${esc(ex.id)}">Use</button>
            <button type="button" class="pdb-del" data-pdb-del="${esc(ex.id)}" title="Delete">✕</button>
          </div>
          <div class="pdb-body">${esc(ex.enhancedPrompt)}</div>
          ${ex.notes ? `<div class="pdb-notes">💡 ${esc(ex.notes)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  $('pdb-search').addEventListener('input', renderDbList);
  $('pdb-filter-mode').addEventListener('change', renderDbList);
  $('pdb-close').addEventListener('click', () => { dbPanel.hidden = true; });

  $('pdb-save-current').addEventListener('click', async () => {
    const ta = getTextarea();
    const text = String((ta && ta.value) || '').trim();
    if (!text) return;
    const { mode } = getFormContext(activeTarget);
    const res = await api.saveDb({
      title: text.slice(0, 56),
      mode,
      originalDraft: text,
      enhancedPrompt: text,
      notes: 'Saved directly by user as a working prompt',
      tags: [mode],
      rating: 5,
    });
    if (res && res.ok) {
      dbCache = res.examples || dbCache;
      renderDbList();
    }
  });

  $('pdb-list').addEventListener('click', async (e) => {
    const useBtn = e.target.closest('[data-pdb-use]');
    if (useBtn) {
      const ex = dbCache.find((x) => x.id === useBtn.dataset.pdbUse);
      if (ex) {
        const ta = getTextarea();
        if (ta) {
          ta.value = ex.enhancedPrompt;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.focus();
        }
        dbPanel.hidden = true;
      }
      return;
    }
    const rateBtn = e.target.closest('[data-pdb-rate]');
    if (rateBtn) {
      const res = await api.rateDb({ id: rateBtn.dataset.pdbRate, rating: Number(rateBtn.dataset.stars) });
      if (res && res.ok) {
        dbCache = res.examples || dbCache;
        renderDbList();
      }
      return;
    }
    const delBtn = e.target.closest('[data-pdb-del]');
    if (delBtn) {
      const res = await api.removeDb(delBtn.dataset.pdbDel);
      if (res && res.ok) {
        dbCache = res.examples || dbCache;
        renderDbList();
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPromptAdvancerUi);
} else {
  initPromptAdvancerUi();
}
