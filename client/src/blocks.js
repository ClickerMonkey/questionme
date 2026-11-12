// Content blocks: markdown, project files (drawn by kind, the way folderview draws them), code, diffs, diagrams,
// pictures, sandboxed HTML mockups and links. Heavy blocks (files, diagrams, mockups) draw when they scroll into view.
import { api, baseOf, esc, extOf, parentOf, rawUrl } from './util.js';
import { state } from './state.js';
import { codeBlockHtml, renderMarkdown, upgradeCode } from './markdown.js';
import { drawInto } from './mermaid.js';
import { icon } from './icons.js';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']);

const later = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      later.unobserve(e.target);
      const draw = e.target.__draw;
      delete e.target.__draw;
      draw?.();
    }
  },
  { rootMargin: '600px 0px' },
);

function lazy(el, draw) {
  el.__draw = draw;
  later.observe(el);
}

/** Markdown into a new element. folder: where relative links and pictures are found. */
export function md(src, folder = '', cls = '') {
  const div = document.createElement('div');
  div.className = 'md' + (cls ? ' ' + cls : '');
  renderMarkdown(div, src || '', folder);
  return div;
}

/** Draw a list of blocks into a container. */
export function renderBlocks(container, blocks) {
  for (const b of blocks || []) container.append(block(b));
}

export function block(b) {
  const body = inner(b);
  if (b.collapsed) {
    const d = document.createElement('details');
    d.className = 'blk';
    d.innerHTML = `<summary>${icon('chevron-right', 16)}<span>${esc(b.title || label(b))}</span></summary>`;
    d.append(body);
    return d;
  }
  if (b.title && (b.kind === 'md' || b.kind === 'mermaid' || b.kind === 'html' || b.kind === 'image')) {
    const w = document.createElement('div');
    w.className = 'blk titled';
    w.innerHTML = `<div class="blk-title">${esc(b.title)}</div>`;
    w.append(body);
    return w;
  }
  return body;
}

function label(b) {
  switch (b.kind) {
    case 'file':
      return b.file + (b.lines ? `:${b.lines}` : '');
    case 'code':
      return b.lang ? `Code (${b.lang})` : 'Code';
    case 'diff':
      return 'Proposed changes';
    case 'mermaid':
      return 'Diagram';
    case 'image':
      return b.alt || 'Picture';
    case 'html':
      return 'Mockup';
    case 'link':
      return b.label;
    default:
      return 'More';
  }
}

function inner(b) {
  switch (b.kind) {
    case 'md':
      return md(b.md);
    case 'code': {
      const div = document.createElement('div');
      div.className = 'blk-code';
      div.innerHTML = codeBlockHtml(b.code, b.lang, b.title || b.lang || 'code');
      upgradeCode(div);
      return div;
    }
    case 'diff':
      return diffBlock(b.diff, b.title || 'Proposed changes');
    case 'mermaid': {
      const div = document.createElement('div');
      div.className = 'md-diagram';
      div.innerHTML = '<div class="skeleton" style="width:60%;height:120px"></div>';
      lazy(div, () => drawInto(div, b.mermaid));
      return div;
    }
    case 'image': {
      const fig = document.createElement('figure');
      fig.className = 'blk-image';
      const src = /^(https?:|data:image\/)/i.test(b.image) ? b.image : rawUrl(b.image.replace(/^\.?\//, ''));
      fig.innerHTML = `<img loading="lazy" alt="${esc(b.alt)}" src="${esc(src)}" />${b.alt ? `<figcaption>${esc(b.alt)}</figcaption>` : ''}`;
      fig.querySelector('img').onclick = () => openImage(src, b.alt);
      return fig;
    }
    case 'html': {
      const f = document.createElement('iframe');
      f.className = 'blk-html';
      f.setAttribute('sandbox', '');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.style.height = b.height + 'px';
      f.title = b.title || 'Mockup';
      lazy(f, () => (f.srcdoc = b.html));
      return f;
    }
    case 'link': {
      const a = document.createElement('a');
      a.className = 'blk-link';
      a.href = b.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = `${icon('external', 16)}<span>${esc(b.label)}</span><small>${esc(hostOf(b.link))}</small>`;
      return a;
    }
    case 'file':
      return fileBlock(b.file, b.lines, b.title);
  }
  const p = document.createElement('p');
  p.textContent = '(unknown block)';
  return p;
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};

/** A unified diff, coloured by line, with each file's name as a caption. */
export function diffBlock(text, title) {
  const wrap = document.createElement('figure');
  wrap.className = 'ui-code blk-diff';
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
  const html = lines
    .map((l) => {
      let cls = '';
      if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) cls = 'd-file';
      else if (l.startsWith('@@')) cls = 'd-hunk';
      else if (l.startsWith('+')) cls = 'd-add';
      else if (l.startsWith('-')) cls = 'd-del';
      return `<span class="d-line ${cls}">${esc(l) || ' '}</span>`;
    })
    .join('');
  const adds = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  wrap.innerHTML = `<figcaption class="cbar"><span class="caption">${esc(title)}</span><span class="d-stat"><b class="add">+${adds}</b> <b class="del">−${dels}</b></span></figcaption><pre class="code diff" tabindex="0"><code>${html}</code></pre>`;
  return wrap;
}

/** A project file, drawn by kind. */
export function fileBlock(path, lines, title) {
  const ext = extOf(path);
  const box = document.createElement('div');
  box.className = 'blk-file';
  const head = document.createElement('button');
  head.className = 'file-head';
  head.type = 'button';
  head.innerHTML = `${icon(IMAGE.has(ext) ? 'image' : 'file', 16)}<span class="fp">${esc(title || path)}${lines ? `<span class="fl">:${esc(lines)}</span>` : ''}</span>${icon('external', 14)}`;
  head.title = 'Open full size';
  head.onclick = () => openFile(path, lines);
  const body = document.createElement('div');
  body.className = 'file-body';
  body.innerHTML = '<div class="skeleton" style="height:64px"></div>';
  box.append(head, body);
  lazy(body, () => drawFile(body, path, lines));
  return box;
}

async function drawFile(body, path, lines) {
  const ext = extOf(path);
  const raw = rawUrl(path);
  try {
    if (IMAGE.has(ext)) {
      body.innerHTML = `<img class="file-img" loading="lazy" alt="${esc(baseOf(path))}" src="${esc(raw)}" />`;
      body.querySelector('img').onclick = () => openImage(raw, path);
      return;
    }
    if (VIDEO.has(ext)) return void (body.innerHTML = `<video controls preload="metadata" src="${esc(raw)}"></video>`);
    if (AUDIO.has(ext)) return void (body.innerHTML = `<audio controls preload="metadata" src="${esc(raw)}"></audio>`);
    if (ext === 'pdf') return void (body.innerHTML = `<a class="blk-link" href="${esc(raw)}" target="_blank" rel="noopener">${icon('file', 16)}<span>Open the PDF</span></a>`);
    if ((ext === 'html' || ext === 'htm') && !lines) {
      body.innerHTML = `<iframe class="blk-html" sandbox="" src="${esc(raw)}?as=page" style="height:360px" title="${esc(path)}"></iframe>`;
      return;
    }
    const r = await api(`api/p/${encodeURIComponent(state.project)}/text?path=${encodeURIComponent(path)}${lines ? '&lines=' + encodeURIComponent(lines) : ''}`);
    body.innerHTML = '';
    if ((ext === 'md' || ext === 'markdown' || ext === 'mdx') && !lines) body.append(md(r.text, parentOf(path), 'file-md'));
    else if ((ext === 'mmd' || ext === 'mermaid') && !lines) {
      const d = document.createElement('div');
      d.className = 'md-diagram';
      body.append(d);
      drawInto(d, r.text);
    } else if ((ext === 'csv' || ext === 'tsv') && !lines) body.append(table(r.text, ext === 'tsv' ? '\t' : ','));
    else {
      const div = document.createElement('div');
      const lang = ext === 'json' || ext === 'jsonc' ? 'json' : ext;
      const caption = lines ? `${path} · lines ${r.first}–${r.first + r.text.split('\n').length - 1} of ${r.total}` : path;
      div.innerHTML = codeBlockHtml(r.text, lang, caption);
      upgradeCode(div);
      body.append(div);
    }
    if (r.truncated) body.insertAdjacentHTML('beforeend', '<p class="muted small">Only the start of this file is shown (it is large).</p>');
  } catch (e) {
    body.innerHTML = `<p class="problem">${esc(path)}: ${esc(e.message)}</p>`;
  }
}

function table(text, sep) {
  const rows = parseCsv(text, sep).slice(0, 201);
  const div = document.createElement('div');
  div.className = 'md md-table-wrap';
  const [head = [], ...rest] = rows;
  div.innerHTML = `<div class="md-table"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > 200 ? '<p class="muted small">The first 200 rows.</p>' : ''}`;
  return div;
}

function parseCsv(text, sep) {
  const rows = [];
  let row = [],
    cell = '',
    q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

// ── full-size views ──

export function modal(titleHtml, content, cls = '') {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal viewer ' + cls;
  box.setAttribute('role', 'dialog');
  box.innerHTML = `<header class="viewer-head"><span class="viewer-title">${titleHtml}</span><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>`;
  const body = document.createElement('div');
  body.className = 'viewer-body';
  body.append(content);
  box.append(body);
  back.append(box);
  const close = () => {
    back.remove();
    removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  back.onclick = (e) => {
    if (e.target === back || e.target.closest('[data-close]')) close();
  };
  addEventListener('keydown', onKey);
  document.body.append(back);
  return close;
}

export function openFile(path, lines) {
  const ext = extOf(path);
  const holder = document.createElement('div');
  holder.className = 'file-body full';
  modal(`${icon('file', 16)} ${esc(path)}${lines ? `<span class="fl">:${esc(lines)}</span>` : ''} <a class="mini" href="${esc(rawUrl(path))}" download="${esc(baseOf(path))}" title="Download">${icon('download', 16)}</a>`, holder, IMAGE.has(ext) ? 'wide' : '');
  drawFile(holder, path, lines);
}

function openImage(src, alt) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || '';
  img.className = 'full-img';
  modal(esc(alt || 'Picture'), img, 'wide');
}

// links in markdown to project files open in the viewer
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-file]');
  if (!a) return;
  e.preventDefault();
  openFile(a.dataset.file, a.dataset.lines || '');
});
