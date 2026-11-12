// What an agent reads: compact digests of sets and answers (so hundreds of answers don't flood its context), and
// waiting until the owner has answered. Shared by the MCP tools and the CLI.
import { Project, StoreError } from './store.js';
import {
  allQuestions,
  compactLine,
  isDone,
  isStale,
  questionById,
  recommendationText,
  summarise,
  visibility,
  type Answer,
  type AnswerFile,
  type QSet,
  type Question,
  type Summary,
} from './model.js';

export const FILTERS = ['new', 'all', 'unacked', 'changed', 'blocking', 'open'] as const;
export type Filter = (typeof FILTERS)[number];

export interface AnswersQuery {
  filter?: Filter;
  ids?: string[];
  section?: string;
  limit?: number;
  offset?: number;
  /** don't mark what's shown as read */
  peek?: boolean;
  /** how much of each question to repeat: none, short (the default: its first 80 characters) or full */
  questions?: 'none' | 'short' | 'full';
}

export function summaryLine(s: Summary): string {
  const bits = [`${s.done} of ${s.visible} answered`];
  if (s.blocking) bits.push(`${s.blocking} blocking still open`);
  if (s.later) bits.push(`${s.later} for later`);
  if (s.changed) bits.push(`${s.changed} answered before the question changed`);
  if (s.unread) bits.push(`${s.unread} new answer${s.unread === 1 ? '' : 's'}`);
  if (s.unreadMessages) bits.push(`${s.unreadMessages} new message${s.unreadMessages === 1 ? '' : 's'} from the owner`);
  if (s.status === 'closed') bits.push('closed');
  if (s.errors) bits.push(`${s.errors} error${s.errors === 1 ? '' : 's'} in the file`);
  return `${s.id} ("${s.title}"): ${bits.join(', ')}`;
}

function loadOrThrow(project: Project, id: string) {
  const l = project.load(id);
  if (!l) throw new StoreError(`No set "${id}" in ${project.setsDir}${project.ids().length ? ` (there are: ${project.ids().join(', ')})` : ''}`);
  return l;
}

const short = (q: Question, mode: AnswersQuery['questions']) => {
  if (mode === 'none') return '';
  const t = q.question.replace(/\s+/g, ' ').trim();
  return mode === 'full' || t.length <= 80 ? t : t.slice(0, 77) + '…';
};

/** The owner's answers as text, and as data. Reading "new" ones marks them read unless peek. */
export function readAnswers(project: Project, id: string, query: AnswersQuery = {}): { text: string; data: unknown } {
  const l = loadOrThrow(project, id);
  const af = project.answers(id);
  const set = l.set;
  const vis = visibility(set, af.answers);
  const filter = query.filter ?? 'new';
  const qmode = query.questions ?? 'short';
  const matches = (qid: string, a: Answer | undefined, q: Question | undefined): boolean => {
    if (query.ids?.length && !query.ids.includes(qid)) return false;
    if (query.section && q?.section !== query.section) return false;
    switch (filter) {
      case 'new':
        return (!!a && a.seq > af.readSeq) || (af.threads[qid] ?? []).some((m) => m.from === 'owner' && m.seq > af.readSeq);
      case 'all':
        return !!a || !!af.threads[qid]?.length;
      case 'unacked':
        return !!a && isDone(a) && a.status !== 'skipped' && !a.ack;
      case 'changed':
        return !!q && !!a && isStale(q, a);
      case 'blocking':
        return !!q && q.priority === 'blocking' && !!a;
      case 'open':
        return !!q && vis.question(qid) && !isDone(a);
    }
  };
  const ordered: { qid: string; q: Question | undefined }[] = allQuestions(set).map((q) => ({ qid: q.id, q }));
  for (const qid of Object.keys(af.answers)) if (!questionById(set, qid)) ordered.push({ qid, q: undefined });
  const hits = ordered.filter(({ qid, q }) => matches(qid, af.answers[qid], q));
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(500, Math.max(1, query.limit ?? 100));
  const page = hits.slice(offset, offset + limit);

  const s = summarise(set, af, l.errors.length);
  const lines = [summaryLine(s)];
  if (!hits.length) lines.push(filter === 'new' ? 'Nothing new since you last read.' : `No ${filter} answers${query.section ? ` in section ${query.section}` : ''}.`);
  else lines.push(`${filter === 'open' ? 'Still to answer' : `Answers (${filter})`}: ${offset + 1}–${offset + page.length} of ${hits.length}${offset + page.length < hits.length ? ` (more: offset ${offset + page.length})` : ''}`);
  let lastSection = '';
  for (const { qid, q } of page) {
    const sec = q ? set.sections.find((x) => x.id === q.section) : undefined;
    if (sec && sec.id !== lastSection && sec.title) lines.push('', `## ${sec.title}`);
    lastSection = sec?.id ?? lastSection;
    const a = af.answers[qid];
    const label = q && qmode !== 'none' ? `${qid} (${short(q, qmode)})` : qid;
    if (filter === 'open' && q) {
      const rec = recommendationText(q);
      lines.push(`- ${label}${q.priority === 'blocking' ? ' [blocking]' : ''}${a?.status === 'later' ? ' [later]' : ''}${rec ? ` — recommended: ${rec}` : ''}`);
      continue;
    }
    if (a) lines.push(compactLine(q, label, a, !!q && !vis.question(qid)));
    else lines.push(`- ${label}: (not answered)`);
    if (a?.ack && filter !== 'new') lines.push(`  applied: ${a.ack.note || 'yes'}`);
    for (const m of af.threads[qid] ?? []) {
      if (filter === 'new' && m.seq <= af.readSeq) continue;
      lines.push(`  ${m.from === 'owner' ? 'owner says' : 'you said'}: ${JSON.stringify(m.body)}`);
    }
  }
  if (filter === 'new' && hits.length && !query.peek) {
    // what was shown is read; anything past this page stays new
    const shownSeq = Math.max(
      0,
      ...page.flatMap(({ qid }) => [af.answers[qid]?.seq ?? 0, ...(af.threads[qid] ?? []).map((m) => m.seq)]),
    );
    project.markRead(id, offset + page.length >= hits.length ? af.seq : shownSeq);
  }
  const data = {
    summary: s,
    filter,
    total: hits.length,
    offset,
    answers: page.map(({ qid, q }) => ({
      id: qid,
      question: q?.question,
      section: q?.section,
      answer: af.answers[qid] ?? null,
      hidden: q ? !vis.question(qid) : undefined,
      changed: q && af.answers[qid] ? isStale(q, af.answers[qid]) : undefined,
      removed: !q || undefined,
      thread: af.threads[qid] ?? [],
    })),
  };
  return { text: lines.join('\n'), data };
}

/** The questions in a set, short: for an agent to see what it asked (and what's left). */
export function describeSet(project: Project, id: string, opts: { section?: string; ids?: string[]; limit?: number; offset?: number; full?: boolean } = {}): string {
  const l = loadOrThrow(project, id);
  const af = project.answers(id);
  const vis = visibility(l.set, af.answers);
  const s = summarise(l.set, af, l.errors.length);
  const lines = [summaryLine(s)];
  if (l.errors.length) lines.push('Errors:', ...l.errors.map((e) => '  ' + e));
  if (l.warnings.length) lines.push('Warnings:', ...l.warnings.slice(0, 20).map((e) => '  ' + e));
  const qs = allQuestions(l.set).filter((q) => (!opts.section || q.section === opts.section) && (!opts.ids?.length || opts.ids.includes(q.id)));
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const page = qs.slice(offset, offset + limit);
  lines.push(`Questions ${offset + 1}–${offset + page.length} of ${qs.length}:`);
  let lastSection = '';
  for (const q of page) {
    if (q.section !== lastSection) {
      const sec = l.set.sections.find((x) => x.id === q.section);
      lines.push('', `## ${sec?.id === '_' ? '(no section)' : `${sec?.id}${sec?.title ? ': ' + sec.title : ''}`}${sec && !vis.section(sec.id) ? ' [hidden]' : ''}`);
      lastSection = q.section;
    }
    const a = af.answers[q.id];
    const state = !vis.question(q.id) ? 'hidden' : a ? (isStale(q, a) ? 'answered, then changed' : a.status) : 'open';
    const text = opts.full ? q.question : q.question.replace(/\s+/g, ' ').slice(0, 100);
    lines.push(`- ${q.id} [${q.type}${q.priority !== 'normal' ? ', ' + q.priority : ''}; ${state}]: ${text}`);
    if (opts.full && q.options.length) lines.push(...q.options.map((o) => `    · ${o.id}: ${o.label}${o.recommended ? ' (recommended)' : ''}${o.shows.length ? ` → shows ${o.shows.join(', ')}` : ''}${o.hides.length ? ` → hides ${o.hides.join(', ')}` : ''}`));
  }
  return lines.join('\n');
}

export const WAITS = ['any', 'blocking', 'all', 'ids', 'count'] as const;
export type WaitFor = (typeof WAITS)[number];

export interface WaitOptions {
  until?: WaitFor;
  ids?: string[];
  count?: number;
  /** give up after this long (0: never) */
  timeoutMs?: number;
  /** once it's true, wait until the owner pauses this long (so a burst of answers wakes you once) */
  settleMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

function condition(set: QSet, af: AnswerFile, w: WaitOptions): boolean {
  const s = summarise(set, af);
  switch (w.until ?? 'any') {
    case 'any':
      return s.unread + s.unreadMessages > 0;
    case 'count':
      return s.unread >= Math.max(1, w.count ?? 1);
    case 'blocking': {
      const vis = visibility(set, af.answers);
      return !allQuestions(set).some((q) => q.priority === 'blocking' && vis.question(q.id) && !isDone(af.answers[q.id]));
    }
    case 'all':
      return s.toAnswer === 0;
    case 'ids': {
      const vis = visibility(set, af.answers);
      return (w.ids ?? []).every((qid) => isDone(af.answers[qid]) || !vis.question(qid));
    }
  }
}

/** Wait until the condition holds (and the owner has paused). Resolves true, or false on timeout/abort. */
export async function waitFor(project: Project, id: string, w: WaitOptions): Promise<boolean> {
  loadOrThrow(project, id);
  const started = Date.now();
  const poll = w.pollMs ?? 1000;
  let metAt = 0;
  let metSeq = -1;
  for (;;) {
    if (w.signal?.aborted) return false;
    const l = project.load(id);
    const af = project.answers(id);
    if (l && condition(l.set, af, w)) {
      if (!w.settleMs) return true;
      if (af.seq !== metSeq) {
        metSeq = af.seq;
        metAt = Date.now();
      } else if (Date.now() - metAt >= w.settleMs) return true;
    } else metSeq = -1;
    if (w.timeoutMs && Date.now() - started >= w.timeoutMs) return false;
    await new Promise((r) => setTimeout(r, poll));
  }
}

export function parseDuration(s: string | undefined, fallback: number): number {
  if (s === undefined || s === '') return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new StoreError(`Not a duration: "${s}" (like 90s, 10m, 2h)`);
  const n = Number(m[1]);
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'] ?? 1000));
}
