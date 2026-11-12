// One question as a card: its text and content, the input for its type, a note, and the ways out (you decide, later,
// skip), the agent's "applied" note, and a thread to discuss it. Answers save as you go.
import { esc, debounce, ago } from './util.js';
import { icon } from './icons.js';
import { md, renderBlocks, block } from './blocks.js';
import { isStale, recommendationText } from '../../src/model.ts';

const STATUS_TEXT = { answered: 'Answered', delegated: 'You decide', skipped: 'Skipped', later: 'Later' };

/**
 * ctx: {
 *   answer(qid), thread(qid), save(qid, input) → Promise<answer>, clear(qid), message(qid, body), keep(qid),
 *   picked(qid) after a pick that can move on (cards), why(qid) → why a hidden question is hidden, readOnly,
 *   unseen(qid) → agent messages not seen yet, seen(qid)
 * }
 */
export function renderQuestion(q, ctx, opts = {}) {
  const card = document.createElement('article');
  card.className = 'q-card';
  card.id = 'q-' + q.id;
  card.dataset.q = q.id;
  draw(card, q, ctx, opts);
  return card;
}

function cardClass(q, a, hidden) {
  return `q-card${hidden ? ' q-hidden' : ''}${a && a.status !== 'later' ? ' done' : ''}${q.priority === 'blocking' ? ' blocking' : ''}${isStale(q, a) ? ' stale' : ''}`;
}

function topHtml(q, a, hidden) {
  const badges = [
    q.priority === 'blocking' ? `<span class="badge danger">${icon('warning', 13)}Blocking</span>` : q.priority === 'high' ? '<span class="badge warn">High</span>' : q.priority === 'low' ? '<span class="badge">Low</span>' : '',
    a ? `<span class="badge ${a.status === 'later' ? 'warn' : 'ok'}">${a.status === 'answered' ? icon('check', 13) : ''}${STATUS_TEXT[a.status]}</span>` : '',
    isStale(q, a) ? '<span class="badge warn">Changed</span>' : '',
    hidden ? `<span class="badge">${icon('eye', 13)}Hidden</span>` : '',
  ].join('');
  return `${q.header ? `<span class="q-header">${esc(q.header)}</span>` : ''}${badges}<a class="q-id" href="#" data-link="${esc(q.id)}" title="Copy a link to this question">${esc(q.id)}</a>`;
}

/** Just the badges and the card's state (while typing, so the input keeps its focus). */
export function refreshTop(card, q, ctx, opts = {}) {
  const a = ctx.answer(q.id);
  card.className = cardClass(q, a, !!opts.hidden);
  const top = card.querySelector('.q-top');
  if (top) top.innerHTML = topHtml(q, a, !!opts.hidden);
}

export function draw(card, q, ctx, opts = {}) {
  const a = ctx.answer(q.id);
  const thread = ctx.thread(q.id);
  const stale = isStale(q, a);
  const hidden = !!opts.hidden;
  card.className = cardClass(q, a, hidden);
  card.innerHTML = `<div class="q-top">${topHtml(q, a, hidden)}</div>`;
  card.append(md(q.question, '', 'q-text'));
  if (hidden && ctx.why) card.insertAdjacentHTML('beforeend', `<p class="q-why-hidden">${icon('info', 14)}<span>${esc(ctx.why(q.id))}</span></p>`);
  if (q.why) card.append(md(q.why, '', 'q-why'));
  if (q.content.length) {
    const c = document.createElement('div');
    c.className = 'q-content';
    renderBlocks(c, q.content);
    card.append(c);
  }
  if (stale) {
    card.insertAdjacentHTML(
      'beforeend',
      `<div class="q-stale">${icon('warning', 16)}<span>This question changed after you answered it. Check your answer${ctx.readOnly ? '' : ', then keep it or change it'}.</span>${ctx.readOnly ? '' : '<button class="btn small" data-act="keep">Keep my answer</button>'}</div>`,
    );
  }
  const input = document.createElement('div');
  input.className = 'q-input';
  card.append(input);
  const disabled = hidden || ctx.readOnly;
  inputFor(q, a, input, ctx, disabled);

  if (a?.ack) card.insertAdjacentHTML('beforeend', `<div class="q-ack">${icon('check', 15)}<span><b>Applied</b>${a.ack.note ? ': ' + esc(a.ack.note) : ''}</span></div>`);

  // the note
  const noteWrap = document.createElement('div');
  noteWrap.className = 'q-note';
  const hasNote = !!a?.note;
  noteWrap.hidden = !hasNote;
  if (q.allowNote) {
    noteWrap.innerHTML = `<textarea rows="2" placeholder="A note (anything the agent should know)" ${disabled ? 'disabled' : ''}>${esc(a?.note || '')}</textarea>`;
    const ta = noteWrap.querySelector('textarea');
    autosize(ta);
    const saveNote = debounce(() => saveWith(q, ctx, card, { note: ta.value }, true), 700);
    ta.addEventListener('input', () => {
      autosize(ta);
      flag(card, 'Saving…');
      saveNote();
    });
    card.append(noteWrap);
  }

  // what's left: the ways out, the thread
  const unseen = ctx.unseen?.(q.id) || 0;
  const acts = document.createElement('footer');
  acts.className = 'q-acts';
  const btn = (act, ic, text, on = false, title = '') => `<button class="chip${on ? ' on' : ''}" data-act="${act}" ${title ? `title="${esc(title)}"` : ''} ${disabled && act !== 'thread' ? 'disabled' : ''}>${icon(ic, 14)}<span>${text}</span></button>`;
  const rec = recommendationText(q);
  acts.innerHTML = [
    q.allowNote && !hasNote ? btn('note', 'pen', 'Note') : '',
    btn('delegated', 'sparkles', 'You decide', a?.status === 'delegated', rec ? `Go with the recommendation: ${rec}` : 'Let the agent choose'),
    btn('later', 'clock', 'Later', a?.status === 'later', 'Come back to it'),
    btn('skipped', 'x', 'Skip', a?.status === 'skipped', "Doesn't matter / don't know"),
    `<button class="chip" data-act="thread">${icon('chat', 14)}<span>Discuss${thread.length ? ` (${thread.length})` : ''}</span>${unseen ? `<span class="dot" title="New reply"></span>` : ''}</button>`,
    a && !disabled ? btn('clear', 'undo', 'Clear') : '',
    '<span class="saved" aria-live="polite"></span>',
  ].join('');
  card.append(acts);

  const th = document.createElement('div');
  th.className = 'q-thread';
  th.hidden = !opts.threadOpen;
  drawThread(th, q, ctx);
  card.append(th);

  card.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const act = t.dataset.act;
    if (act === 'note') {
      noteWrap.hidden = false;
      t.remove();
      noteWrap.querySelector('textarea')?.focus();
    } else if (act === 'thread') {
      th.hidden = !th.hidden;
      if (!th.hidden) {
        ctx.seen?.(q.id);
        t.querySelector('.dot')?.remove();
        th.querySelector('textarea')?.focus();
      }
    } else if (act === 'clear') ctx.clear(q.id);
    else if (act === 'keep') {
      const cur = ctx.answer(q.id);
      if (cur) ctx.save(q.id, plainAnswer(cur));
    } else if (act === 'delegated' || act === 'later' || act === 'skipped') {
      const cur = ctx.answer(q.id);
      if (cur?.status === act) ctx.clear(q.id);
      else ctx.save(q.id, { status: act, note: cur?.note || '' }).then(() => act !== 'later' && ctx.picked?.(q.id));
    }
  };
}

/** the answer as the page sends it */
function plainAnswer(a) {
  const { status, picked, other, text, number, order, note } = a;
  return { status, picked, other, text, number, order, note };
}

/** Save the current answer with these fields changed (keeping what's there). typing: don't redraw the card (it has the focus). */
function saveWith(q, ctx, card, patch, typing = false) {
  const cur = ctx.answer(q.id);
  const base = cur ? plainAnswer(cur) : { status: 'answered' };
  // a note on its own (no answer yet) is fine for choices and text; elsewhere it waits for an answer
  if (!cur && 'note' in patch && !patch.note.trim()) return Promise.resolve();
  if (!cur && 'note' in patch && (q.type === 'number' || q.type === 'scale' || q.type === 'rank' || q.type === 'yesno')) {
    flag(card, 'The note saves with your answer');
    return Promise.resolve();
  }
  const next = { ...base, ...patch };
  if ('picked' in patch || 'other' in patch || 'text' in patch || 'number' in patch || 'order' in patch) next.status = 'answered';
  return ctx.save(q.id, next, { quiet: typing }).then(
    () => flag(card, 'Saved'),
    (e) => flag(card, e.message, true),
  );
}

export function flag(card, text, bad = false) {
  const s = card.querySelector('.saved');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('bad', bad);
  clearTimeout(s.__t);
  if (!bad && text === 'Saved') s.__t = setTimeout(() => (s.textContent = ''), 1600);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
}

// ── inputs, by type ──

function inputFor(q, a, el, ctx, disabled) {
  const card = () => el.closest('.q-card');
  const answered = a?.status === 'answered' ? a : undefined;
  const delegated = a?.status === 'delegated';
  switch (q.type) {
    case 'single':
    case 'multi':
    case 'yesno': {
      const multi = q.type === 'multi';
      const picked = new Set(answered?.picked || []);
      const recs = new Set(Array.isArray(q.recommended) ? q.recommended : []);
      const list = document.createElement('div');
      list.className = `opts${q.type === 'yesno' ? ' yesno' : ''}`;
      list.setAttribute('role', multi ? 'group' : 'radiogroup');
      for (const o of q.options) {
        const wrap = document.createElement('div');
        wrap.className = 'opt-wrap';
        const on = picked.has(o.id);
        const chosen = delegated && recs.has(o.id);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `opt${on ? ' on' : ''}${chosen ? ' chosen' : ''}${o.recommended ? ' rec' : ''}${multi ? ' multi' : ''}`;
        b.dataset.o = o.id;
        b.disabled = disabled;
        b.setAttribute('role', multi ? 'checkbox' : 'radio');
        b.setAttribute('aria-checked', String(on));
        const reveals = o.shows.length ? `<span class="opt-shows">${icon('plus', 12)}Opens ${o.shows.length === 1 ? 'a follow-up' : o.shows.length + ' follow-ups'}</span>` : '';
        b.innerHTML = `<span class="tick">${on || chosen ? icon('check', 14) : ''}</span><span class="opt-main"><span class="opt-label">${esc(o.label)}${o.recommended ? `<span class="rec-tag">${chosen ? 'Chosen for you' : 'Recommended'}</span>` : ''}</span>${reveals}</span>`;
        if (o.description) b.querySelector('.opt-main').append(md(o.description, '', 'opt-desc'));
        wrap.append(b);
        if (o.content.length) {
          const c = document.createElement('div');
          c.className = 'opt-content';
          for (const blk of o.content) c.append(block(blk));
          wrap.append(c);
        }
        list.append(wrap);
      }
      el.append(list);
      let other;
      if (q.allowOther) {
        other = document.createElement('label');
        other.className = `opt other${answered?.other ? ' on' : ''}`;
        other.innerHTML = `<span class="tick">${answered?.other ? icon('check', 14) : ''}</span><input type="text" placeholder="Other…" value="${esc(answered?.other || '')}" ${disabled ? 'disabled' : ''} enterkeyhint="done" />`;
        el.append(other);
        const inp = other.querySelector('input');
        const save = debounce(() => {
          const v = inp.value;
          const patch = multi ? { picked: [...(ctx.answer(q.id)?.status === 'answered' ? ctx.answer(q.id).picked || [] : [])], other: v } : { picked: [], other: v };
          if (!v.trim() && !(patch.picked || []).length) ctx.clear(q.id);
          else saveWith(q, ctx, card(), patch, true);
        }, 700);
        inp.addEventListener('input', () => {
          other.classList.toggle('on', !!inp.value.trim());
          if (!multi) for (const x of list.querySelectorAll('.opt.on')) x.classList.remove('on');
          flag(card(), 'Saving…');
          save();
        });
      }
      list.addEventListener('click', (e) => {
        const b = e.target.closest('.opt[data-o]');
        if (!b || b.disabled) return;
        const id = b.dataset.o;
        const cur = ctx.answer(q.id);
        const now = new Set(cur?.status === 'answered' ? cur.picked || [] : []);
        if (multi) {
          if (now.has(id)) now.delete(id);
          else now.add(id);
          const otherText = cur?.status === 'answered' ? cur.other || '' : '';
          if (!now.size && !otherText.trim() && !cur?.note) return ctx.clear(q.id);
          saveWith(q, ctx, card(), { picked: [...now], other: otherText });
        } else {
          if (now.has(id) && now.size === 1) {
            // a second tap takes it back
            if (cur?.note) saveWith(q, ctx, card(), { picked: [], other: '' });
            else ctx.clear(q.id);
            return;
          }
          saveWith(q, ctx, card(), { picked: [id], other: '' }).then(() => ctx.picked?.(q.id));
        }
      });
      return;
    }
    case 'text': {
      const ta = document.createElement(q.multiline ? 'textarea' : 'input');
      ta.className = 'text-in';
      if (!q.multiline) ta.type = 'text';
      ta.placeholder = q.placeholder || (typeof q.recommended === 'string' && q.recommended ? `Suggested: ${q.recommended}` : 'Your answer');
      ta.value = answered?.text || '';
      ta.disabled = disabled;
      if (q.multiline) {
        ta.rows = 3;
        requestAnimationFrame(() => autosize(ta));
      }
      el.append(ta);
      const save = debounce(() => (ta.value.trim() || ctx.answer(q.id)?.note ? saveWith(q, ctx, card(), { text: ta.value }, true) : ctx.clear(q.id)), 800);
      ta.addEventListener('input', () => {
        if (q.multiline) autosize(ta);
        flag(card(), 'Saving…');
        save();
      });
      if (typeof q.recommended === 'string' && q.recommended && !answered) {
        const use = document.createElement('button');
        use.className = 'btn small';
        use.type = 'button';
        use.disabled = disabled;
        use.textContent = 'Use the suggestion';
        use.onclick = () => saveWith(q, ctx, card(), { text: q.recommended });
        el.append(use);
      }
      return;
    }
    case 'number': {
      const row = document.createElement('div');
      row.className = 'num-row';
      const n = answered?.number;
      const hasRange = q.min !== undefined && q.max !== undefined;
      row.innerHTML = `${hasRange ? `<input type="range" min="${q.min}" max="${q.max}" step="${q.step ?? 'any'}" value="${n ?? q.recommended ?? q.min}" ${disabled ? 'disabled' : ''} />` : ''}<input type="number" inputmode="decimal" ${q.min !== undefined ? `min="${q.min}"` : ''} ${q.max !== undefined ? `max="${q.max}"` : ''} step="${q.step ?? 'any'}" value="${n ?? ''}" placeholder="${q.recommended !== undefined ? 'Suggested: ' + esc(q.recommended) : ''}" ${disabled ? 'disabled' : ''} />${q.unit ? `<span class="unit">${esc(q.unit)}</span>` : ''}`;
      el.append(row);
      const [range, box] = [row.querySelector('input[type=range]'), row.querySelector('input[type=number]')];
      const save = debounce(() => {
        const v = Number(box.value);
        if (box.value === '' || !Number.isFinite(v)) return;
        saveWith(q, ctx, card(), { number: v }, true);
      }, 600);
      range?.addEventListener('input', () => {
        box.value = range.value;
        flag(card(), 'Saving…');
        save();
      });
      box.addEventListener('input', () => {
        if (range && box.value !== '') range.value = box.value;
        flag(card(), 'Saving…');
        save();
      });
      if (q.minLabel || q.maxLabel) el.insertAdjacentHTML('beforeend', `<div class="scale-labels"><span>${esc(q.minLabel)}</span><span>${esc(q.maxLabel)}</span></div>`);
      return;
    }
    case 'scale': {
      const min = q.min ?? 1,
        max = q.max ?? 5,
        step = q.step || 1;
      const row = document.createElement('div');
      row.className = 'scale';
      const val = answered?.number ?? (delegated ? q.recommended : undefined);
      for (let v = min; v <= max + 1e-9; v += step) {
        const x = Math.round(v * 1000) / 1000;
        row.insertAdjacentHTML('beforeend', `<button type="button" class="scale-btn${val === x ? ' on' : ''}${q.recommended === x ? ' rec' : ''}" data-v="${x}" ${disabled ? 'disabled' : ''}>${x}</button>`);
      }
      el.append(row);
      el.insertAdjacentHTML('beforeend', `<div class="scale-labels"><span>${esc(q.minLabel)}</span>${q.recommended !== undefined ? `<span class="rec-note">Recommended: ${esc(q.recommended)}</span>` : ''}<span>${esc(q.maxLabel)}</span></div>`);
      row.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (!b || b.disabled) return;
        const v = Number(b.dataset.v);
        if (answered?.number === v && ctx.answer(q.id)?.number === v) return ctx.clear(q.id);
        saveWith(q, ctx, card(), { number: v }).then(() => ctx.picked?.(q.id));
      });
      return;
    }
    case 'rank': {
      const order = answered?.order?.length === q.options.length ? answered.order : Array.isArray(q.recommended) && q.recommended.length === q.options.length ? q.recommended : q.options.map((o) => o.id);
      const ol = document.createElement('ol');
      ol.className = `rank${answered ? ' on' : ''}`;
      const byId = new Map(q.options.map((o) => [o.id, o]));
      const paint = (ids) => {
        ol.innerHTML = ids
          .map((id, i) => {
            const o = byId.get(id);
            return `<li data-o="${esc(id)}"><span class="rank-n">${i + 1}</span><span class="rank-label">${esc(o?.label ?? id)}${o?.description ? `<small>${esc(o.description)}</small>` : ''}</span><span class="rank-btns"><button class="icon-btn" data-move="-1" aria-label="Move up" ${i === 0 || disabled ? 'disabled' : ''}>${icon('arrow-up', 16)}</button><button class="icon-btn" data-move="1" aria-label="Move down" ${i === ids.length - 1 || disabled ? 'disabled' : ''}>${icon('arrow-down', 16)}</button></span></li>`;
          })
          .join('');
      };
      let ids = [...order];
      paint(ids);
      el.append(ol);
      const save = debounce(() => saveWith(q, ctx, card(), { order: ids }, true), 500);
      ol.addEventListener('click', (e) => {
        const b = e.target.closest('[data-move]');
        if (!b || b.disabled) return;
        const id = b.closest('li').dataset.o;
        const i = ids.indexOf(id);
        const j = i + Number(b.dataset.move);
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        paint(ids);
        ol.classList.add('on');
        flag(card(), 'Saving…');
        save();
      });
      if (!answered && !disabled) {
        const ok = document.createElement('button');
        ok.className = 'btn small';
        ok.type = 'button';
        ok.textContent = 'This order is right';
        ok.onclick = () => saveWith(q, ctx, card(), { order: ids });
        el.append(ok);
      }
      return;
    }
  }
}

// ── the thread ──

function drawThread(th, q, ctx) {
  const msgs = ctx.thread(q.id);
  th.innerHTML = `<div class="msgs">${
    msgs.length
      ? msgs.map((m) => `<div class="msg ${m.from}"><div class="msg-who">${m.from === 'owner' ? 'You' : 'Agent'} · ${esc(ago(Date.parse(m.at)))}</div></div>`).join('')
      : '<p class="muted small">Ask why, push back, or explain. The agent reads it and can answer here.</p>'
  }</div>${ctx.readOnly ? '' : `<form class="msg-form"><textarea rows="2" placeholder="Write to the agent…"></textarea><button class="btn primary small" type="submit">Send</button></form>`}`;
  th.querySelectorAll('.msg').forEach((el, i) => el.append(md(msgs[i].body, '', 'msg-body')));
  const form = th.querySelector('form');
  if (!form) return;
  const ta = form.querySelector('textarea');
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    ta.disabled = true;
    ctx.message(q.id, body).then(
      () => {
        ta.value = '';
        ta.disabled = false;
      },
      (err) => {
        ta.disabled = false;
        flag(th.closest('.q-card'), err.message, true);
      },
    );
  };
}
