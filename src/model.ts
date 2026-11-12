// The question-set format: what an LLM writes (lenient, with shorthands), the normalised form everything else reads,
// validation, which questions are visible given the answers so far, fingerprints, summaries and answer text.
// Pure: no Node APIs, so the page bundles it too.

// ── what is written (input) ──

/** Rich content: a markdown string, or one of these blocks. */
export type BlockInput =
  | string
  | ({ md: string } & BlockCommon)
  | ({ file: string; lines?: string | number } & BlockCommon)
  | ({ code: string; lang?: string } & BlockCommon)
  | ({ diff: string } & BlockCommon)
  | ({ mermaid: string } & BlockCommon)
  | ({ image: string; alt?: string } & BlockCommon)
  | ({ html: string; height?: number } & BlockCommon)
  | ({ link: string; label?: string } & BlockCommon);

export interface BlockCommon {
  title?: string;
  /** drawn closed, behind its title */
  collapsed?: boolean;
}

export type Condition = ConditionOne | ConditionOne[];
export interface ConditionOne {
  /** the question this depends on */
  question: string;
  /** shown when any of these options is picked */
  any?: string[] | string;
  /** shown when all of these options are picked */
  all?: string[] | string;
  /** shown when none of these options is picked (and the question is answered) */
  none?: string[] | string;
  /** shown once that question is answered (true) or while it isn't (false) */
  answered?: boolean;
  /** number answers: at least / at most */
  gte?: number;
  lte?: number;
}

/** a condition, normalised */
export interface Cond {
  question: string;
  any?: string[];
  all?: string[];
  none?: string[];
  answered?: boolean;
  gte?: number;
  lte?: number;
}

export interface OptionInput {
  id?: string;
  label?: string;
  /** shorthand for label */
  t?: string;
  description?: string;
  /** shorthand for description */
  d?: string;
  recommended?: boolean;
  /** shorthand for recommended */
  r?: boolean;
  content?: BlockInput | BlockInput[];
  /** picking this option shows these questions or sections (by id) */
  shows?: string[] | string;
  /** picking this option hides these questions or sections (by id) */
  hides?: string[] | string;
}

export const TYPES = ['single', 'multi', 'yesno', 'text', 'number', 'scale', 'rank'] as const;
export type QuestionType = (typeof TYPES)[number];
export const PRIORITIES = ['blocking', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface QuestionInput {
  id?: string;
  question?: string;
  /** shorthand for question */
  q?: string;
  type?: QuestionType;
  /** a short label shown above the question */
  header?: string;
  /** why it matters: what the answer changes */
  why?: string;
  content?: BlockInput | BlockInput[];
  options?: (string | OptionInput)[];
  /** the recommended option id(s), or a value for number/scale/text */
  recommended?: string | string[] | number;
  priority?: Priority;
  /** shorthand for priority: "blocking" */
  blocking?: boolean;
  /** hidden until an option's `shows` or the `showIf` condition reveals it */
  hidden?: boolean;
  showIf?: Condition;
  /** an "Other…" answer (single and multi; default true) */
  allowOther?: boolean;
  /** a free note on the answer (default true) */
  allowNote?: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  minLabel?: string;
  maxLabel?: string;
  placeholder?: string;
  multiline?: boolean;
  tags?: string[];
}

export interface SectionInput {
  id?: string;
  title?: string;
  intro?: string;
  content?: BlockInput | BlockInput[];
  hidden?: boolean;
  showIf?: Condition;
  questions?: QuestionInput[];
}

export interface SetInput {
  $schema?: string;
  title?: string;
  intro?: string;
  content?: BlockInput | BlockInput[];
  status?: 'open' | 'closed';
  created?: string;
  updated?: string;
  sections?: SectionInput[];
  /** questions outside any section */
  questions?: QuestionInput[];
}

// ── what everything reads (normalised) ──

export type Block =
  | { kind: 'md'; md: string; title?: string; collapsed?: boolean }
  | { kind: 'file'; file: string; lines?: string; title?: string; collapsed?: boolean }
  | { kind: 'code'; code: string; lang: string; title?: string; collapsed?: boolean }
  | { kind: 'diff'; diff: string; title?: string; collapsed?: boolean }
  | { kind: 'mermaid'; mermaid: string; title?: string; collapsed?: boolean }
  | { kind: 'image'; image: string; alt: string; title?: string; collapsed?: boolean }
  | { kind: 'html'; html: string; height: number; title?: string; collapsed?: boolean }
  | { kind: 'link'; link: string; label: string; title?: string; collapsed?: boolean };

export interface Option {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  content: Block[];
  shows: string[];
  hides: string[];
}

export interface Question {
  id: string;
  section: string;
  question: string;
  type: QuestionType;
  header: string;
  why: string;
  content: Block[];
  options: Option[];
  /** option ids for choices; a value for number/scale/text */
  recommended: string[] | number | string | undefined;
  priority: Priority;
  hidden: boolean;
  showIf: Cond[] | undefined;
  allowOther: boolean;
  allowNote: boolean;
  min: number | undefined;
  max: number | undefined;
  step: number | undefined;
  unit: string;
  minLabel: string;
  maxLabel: string;
  placeholder: string;
  multiline: boolean;
  tags: string[];
  /** a fingerprint of what was asked: an answer given to another fingerprint is "changed" */
  rev: string;
  /** position in the set (0-based) */
  index: number;
}

export interface Section {
  id: string;
  title: string;
  intro: string;
  content: Block[];
  hidden: boolean;
  showIf: Cond[] | undefined;
  questions: Question[];
}

export interface QSet {
  id: string;
  title: string;
  intro: string;
  content: Block[];
  status: 'open' | 'closed';
  created: string;
  updated: string;
  sections: Section[];
}

export interface Normalised {
  set: QSet;
  errors: string[];
  warnings: string[];
}

// ── answers ──

export const STATUSES = ['answered', 'delegated', 'skipped', 'later'] as const;
export type AnswerStatus = (typeof STATUSES)[number];

export interface Answer {
  /** answered; delegated ("you decide": take the recommendation); skipped; later (ask again) */
  status: AnswerStatus;
  /** picked option ids (single, multi, yesno) */
  picked?: string[];
  /** the picked options' labels, as they read when picked */
  labels?: string[];
  /** an "Other…" answer */
  other?: string;
  text?: string;
  number?: number;
  /** rank: option ids, first is most */
  order?: string[];
  note?: string;
  /** the question's fingerprint when it was answered */
  rev: string;
  at: string;
  seq: number;
  /** the agent applied it */
  ack?: { at: string; note: string };
}

export interface Message {
  from: 'owner' | 'agent';
  body: string;
  at: string;
  seq: number;
}

export interface AnswerFile {
  version: 1;
  /** bumped on every change */
  seq: number;
  /** the agent has read everything up to here */
  readSeq: number;
  answers: Record<string, Answer>;
  threads: Record<string, Message[]>;
}

export const emptyAnswers = (): AnswerFile => ({ version: 1, seq: 0, readSeq: 0, answers: {}, threads: {} });

// ── helpers ──

export const SET_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'x'
  );
}

/** A short, stable fingerprint (FNV-1a, 32-bit, base 36). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const arr = (v: string[] | string | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** an object, without narrowing what it is */
const plain = (v: unknown): boolean => isObj(v);

function blocks(input: unknown, where: string, errors: string[]): Block[] {
  if (input === undefined || input === null) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: Block[] = [];
  list.forEach((b, i) => {
    const at = `${where}.content[${i}]`;
    if (typeof b === 'string') return void out.push({ kind: 'md', md: b });
    if (!isObj(b)) return void errors.push(`${at}: a block is a markdown string or an object`);
    const common: { title?: string; collapsed?: boolean } = {};
    if (typeof b['title'] === 'string') common.title = b['title'];
    if (b['collapsed'] === true) common.collapsed = true;
    if (typeof b['md'] === 'string') out.push({ kind: 'md', md: b['md'], ...common });
    else if (typeof b['file'] === 'string') {
      const lines = b['lines'] === undefined ? undefined : str(b['lines']);
      if (lines !== undefined && !/^\d+(-\d+)?$/.test(lines)) errors.push(`${at}: lines is "12" or "10-40"`);
      if (/^([a-z]:|\/|\\)/i.test(b['file']) || b['file'].split(/[\\/]/).includes('..'))
        errors.push(`${at}: file is a path inside the project folder (no absolute paths or ..)`);
      out.push({ kind: 'file', file: b['file'].replace(/\\/g, '/'), ...(lines ? { lines } : {}), ...common });
    } else if (typeof b['code'] === 'string') out.push({ kind: 'code', code: b['code'], lang: str(b['lang']), ...common });
    else if (typeof b['diff'] === 'string') out.push({ kind: 'diff', diff: b['diff'], ...common });
    else if (typeof b['mermaid'] === 'string') out.push({ kind: 'mermaid', mermaid: b['mermaid'], ...common });
    else if (typeof b['image'] === 'string') out.push({ kind: 'image', image: b['image'], alt: str(b['alt']), ...common });
    else if (typeof b['html'] === 'string') out.push({ kind: 'html', html: b['html'], height: Math.min(2000, Math.max(80, num(b['height']) ?? 320)), ...common });
    else if (typeof b['link'] === 'string') {
      if (!/^https?:\/\//i.test(b['link'])) errors.push(`${at}: link must be an http(s) URL`);
      out.push({ kind: 'link', link: b['link'], label: str(b['label']) || b['link'], ...common });
    } else errors.push(`${at}: unknown block (use md, file, code, diff, mermaid, image, html or link)`);
  });
  return out;
}

function conditions(input: unknown, where: string, errors: string[]): Cond[] | undefined {
  if (input === undefined || input === null) return undefined;
  const list = Array.isArray(input) ? input : [input];
  const out: Cond[] = [];
  for (const c of list) {
    if (!isObj(c) || typeof c['question'] !== 'string') {
      errors.push(`${where}.showIf: each condition needs a "question" id`);
      continue;
    }
    const one: Cond = { question: c['question'] };
    for (const k of ['any', 'all', 'none'] as const) if (c[k] !== undefined) one[k] = arr(c[k] as string[] | string);
    if (typeof c['answered'] === 'boolean') one.answered = c['answered'];
    if (num(c['gte']) !== undefined) one.gte = num(c['gte']);
    if (num(c['lte']) !== undefined) one.lte = num(c['lte']);
    out.push(one);
  }
  return out;
}

/** Normalise a set as written; errors make it unusable in places, warnings don't. */
export function normalise(id: string, input: unknown): Normalised {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw: SetInput = isObj(input) ? (input as SetInput) : {};
  if (!isObj(input)) errors.push('A set is a JSON object');
  const set: QSet = {
    id,
    title: str(raw.title) || id,
    intro: str(raw.intro),
    content: blocks(raw.content, 'set', errors),
    status: raw.status === 'closed' ? 'closed' : 'open',
    created: str(raw.created),
    updated: str(raw.updated),
    sections: [],
  };
  const ids = new Map<string, string>(); // id → what it is
  const claim = (id: string, what: string, where: string) => {
    if (ids.has(id)) errors.push(`${where}: the id "${id}" is used twice (also ${ids.get(id)})`);
    ids.set(id, what);
  };
  const rawSections: SectionInput[] = Array.isArray(raw.sections) ? raw.sections : [];
  if (raw.sections !== undefined && !Array.isArray(raw.sections)) errors.push('sections must be a list');
  const all: SectionInput[] = [];
  if (Array.isArray(raw.questions) && raw.questions.length) all.push({ id: '_', title: '', questions: raw.questions });
  all.push(...rawSections);
  let index = 0;
  const autoIds = new Set<string>();
  all.forEach((s, si) => {
    const where = s.id === '_' ? 'questions' : `sections[${si - (all[0]?.id === '_' ? 1 : 0)}]`;
    if (!plain(s)) return void errors.push(`${where}: a section is an object`);
    const sid = str(s.id) || (s.title ? slug(s.title) : `section-${si + 1}`);
    if (sid !== '_' && !ID.test(sid)) errors.push(`${where}: bad id "${sid}" (letters, digits, . _ : -)`);
    if (sid !== '_') claim(sid, 'a section', where);
    const section: Section = {
      id: sid,
      title: str(s.title),
      intro: str(s.intro),
      content: blocks(s.content, where, errors),
      hidden: s.hidden === true,
      showIf: conditions(s.showIf, where, errors),
      questions: [],
    };
    const qs = Array.isArray(s.questions) ? s.questions : [];
    if (s.questions !== undefined && !Array.isArray(s.questions)) errors.push(`${where}.questions must be a list`);
    qs.forEach((qi, qn) => {
      const qwhere = `${where === 'questions' ? 'questions' : where + '.questions'}[${qn}]`;
      if (!plain(qi)) return void errors.push(`${qwhere}: a question is an object`);
      const text = str(qi.question ?? qi.q);
      if (!text.trim()) errors.push(`${qwhere}: "question" is missing`);
      let qid = str(qi.id);
      if (!qid) {
        qid = slug(text || `q${index + 1}`);
        let n = 2;
        while (ids.has(qid) || autoIds.has(qid)) qid = `${slug(text || 'q')}-${n++}`;
        autoIds.add(qid);
        warnings.push(`${qwhere}: no id, so it is "${qid}" (give each question an id so answers stay attached)`);
      }
      if (!ID.test(qid)) errors.push(`${qwhere}: bad id "${qid}" (letters, digits, . _ : -)`);
      claim(qid, 'a question', qwhere);
      const opts = Array.isArray(qi.options) ? qi.options : [];
      const type: QuestionType = qi.type && (TYPES as readonly string[]).includes(qi.type) ? qi.type : opts.length ? 'single' : 'text';
      if (qi.type && !(TYPES as readonly string[]).includes(qi.type)) errors.push(`${qwhere}: unknown type "${qi.type}" (${TYPES.join(', ')})`);
      const options: Option[] = [];
      const optIds = new Set<string>();
      const source: (string | OptionInput)[] = type === 'yesno' && !opts.length ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] : opts;
      source.forEach((o, on) => {
        const owhere = `${qwhere}.options[${on}]`;
        const oi: OptionInput = typeof o === 'string' ? { label: o } : plain(o) ? o : {};
        if (!plain(o) && typeof o !== 'string') errors.push(`${owhere}: an option is a string or an object`);
        const label = str(oi.label ?? oi.t);
        if (!label.trim()) errors.push(`${owhere}: "label" is missing`);
        let oid = str(oi.id) || slug(label, 32);
        let n = 2;
        if (!oi.id) while (optIds.has(oid)) oid = `${slug(label, 32)}-${n++}`;
        if (optIds.has(oid)) errors.push(`${owhere}: the option id "${oid}" is used twice`);
        optIds.add(oid);
        options.push({
          id: oid,
          label,
          description: str(oi.description ?? oi.d),
          recommended: oi.recommended === true || oi.r === true,
          content: blocks(oi.content, owhere, errors),
          shows: arr(oi.shows),
          hides: arr(oi.hides),
        });
      });
      if ((type === 'single' || type === 'multi' || type === 'rank') && !options.length) {
        errors.push(`${qwhere}: a ${type} question needs options`);
      }
      // the recommendation: on the question, or flagged on options
      let recommended: Question['recommended'];
      if (qi.recommended !== undefined) {
        if (typeof qi.recommended === 'number') recommended = qi.recommended;
        else if (type === 'text') recommended = arr(qi.recommended).join(', ');
        else if (type === 'number' || type === 'scale') {
          const n = Number(qi.recommended);
          if (Number.isFinite(n)) recommended = n;
          else errors.push(`${qwhere}: recommended must be a number`);
        } else {
          const r = arr(qi.recommended).map((x) => (optIds.has(x) ? x : (options.find((o) => o.label === x)?.id ?? x)));
          for (const x of r) if (!optIds.has(x)) errors.push(`${qwhere}: recommended "${x}" isn't one of the options`);
          recommended = r;
          for (const o of options) if (r.includes(o.id)) o.recommended = true;
        }
      } else if (options.some((o) => o.recommended)) recommended = options.filter((o) => o.recommended).map((o) => o.id);
      if (type === 'single' && Array.isArray(recommended) && recommended.length > 1) warnings.push(`${qwhere}: a single-choice question recommends ${recommended.length} options`);
      const priority: Priority = qi.blocking === true ? 'blocking' : qi.priority && (PRIORITIES as readonly string[]).includes(qi.priority) ? qi.priority : 'normal';
      if (qi.priority && !(PRIORITIES as readonly string[]).includes(qi.priority)) errors.push(`${qwhere}: unknown priority "${qi.priority}" (${PRIORITIES.join(', ')})`);
      const min = num(qi.min) ?? (type === 'scale' ? 1 : undefined);
      const max = num(qi.max) ?? (type === 'scale' ? 5 : undefined);
      if (min !== undefined && max !== undefined && min > max) errors.push(`${qwhere}: min is above max`);
      const q: Question = {
        id: qid,
        section: sid,
        question: text,
        type,
        header: str(qi.header),
        why: str(qi.why),
        content: blocks(qi.content, qwhere, errors),
        options,
        recommended,
        priority,
        hidden: qi.hidden === true,
        showIf: conditions(qi.showIf, qwhere, errors),
        allowOther: (type === 'single' || type === 'multi') && qi.allowOther !== false,
        allowNote: qi.allowNote !== false,
        min,
        max,
        step: num(qi.step),
        unit: str(qi.unit),
        minLabel: str(qi.minLabel),
        maxLabel: str(qi.maxLabel),
        placeholder: str(qi.placeholder),
        multiline: qi.multiline !== false,
        tags: Array.isArray(qi.tags) ? qi.tags.map(String) : [],
        rev: '',
        index: index++,
      };
      q.rev = fingerprint(q);
      section.questions.push(q);
    });
    set.sections.push(section);
  });
  // every reference must point somewhere
  const known = (ref: string) => ids.has(ref);
  const checkCond = (cs: Cond[] | undefined, where: string) => {
    for (const c of cs ?? []) {
      if (!known(c.question) || ids.get(c.question) !== 'a question') {
        errors.push(`${where}: showIf names "${c.question}", which isn't a question in this set`);
        continue;
      }
      const target = questionById(set, c.question);
      for (const k of ['any', 'all', 'none'] as const)
        for (const o of c[k] ?? [])
          if (target && target.options.length && !target.options.some((x) => x.id === o))
            errors.push(`${where}: showIf ${k} "${o}" isn't an option of "${c.question}"`);
    }
  };
  for (const s of set.sections) {
    checkCond(s.showIf, `section "${s.id}"`);
    for (const q of s.questions) {
      checkCond(q.showIf, `question "${q.id}"`);
      for (const o of q.options)
        for (const ref of [...o.shows, ...o.hides]) {
          if (!known(ref)) errors.push(`question "${q.id}" option "${o.id}": shows/hides "${ref}", which isn't a question or section here`);
          else if (ref === q.id || ref === q.section) warnings.push(`question "${q.id}" option "${o.id}": shows/hides itself`);
        }
      if (q.hidden && !q.showIf && !revealers(set).has(q.id) && !revealers(set).has(q.section))
        warnings.push(`question "${q.id}" is hidden and nothing shows it`);
    }
    if (s.hidden && !s.showIf && !revealers(set).has(s.id)) warnings.push(`section "${s.id}" is hidden and nothing shows it`);
  }
  return { set, errors, warnings };
}

const revealCache = new WeakMap<QSet, Set<string>>();
function revealers(set: QSet): Set<string> {
  let r = revealCache.get(set);
  if (!r) {
    r = new Set();
    for (const q of allQuestions(set)) for (const o of q.options) for (const id of o.shows) r.add(id);
    revealCache.set(set, r);
  }
  return r;
}

export function fingerprint(q: Pick<Question, 'question' | 'type' | 'options' | 'min' | 'max'>): string {
  return hash(JSON.stringify([q.question.trim(), q.type, q.options.map((o) => [o.id, o.label.trim()]), q.min ?? null, q.max ?? null]));
}

export function allQuestions(set: QSet): Question[] {
  return set.sections.flatMap((s) => s.questions);
}

export function questionById(set: QSet, id: string): Question | undefined {
  for (const s of set.sections) for (const q of s.questions) if (q.id === id) return q;
  return undefined;
}

// ── answers: what they say ──

/** Options in effect: picked ones, or the recommendation when the owner said "you decide". */
export function effectivePicks(q: Question, a: Answer | undefined): string[] {
  if (!a) return [];
  if (a.status === 'answered') return a.picked ?? [];
  if (a.status === 'delegated' && Array.isArray(q.recommended)) return q.recommended;
  return [];
}

/** An answer counts as done when answered, delegated or skipped ("later" is still to do). */
export const isDone = (a: Answer | undefined) => !!a && a.status !== 'later';

/** The answer was given to an earlier version of the question. */
export const isStale = (q: Question, a: Answer | undefined) => !!a && a.status !== 'skipped' && a.rev !== q.rev;

// ── visibility ──

export interface Visibility {
  question: (id: string) => boolean;
  section: (id: string) => boolean;
}

/**
 * Which questions and sections show, given the answers. Each starts from its default (shown, unless `hidden`), or from
 * its `showIf` when it has one. A picked option in a visible question then shows (`shows`) or hides (`hides`) the
 * questions and sections it names; hiding wins. A question in a hidden section is hidden. Picks in hidden questions
 * don't count, so whole branches fold away.
 */
export function visibility(set: QSet, answers: Record<string, Answer>): Visibility {
  const qs = new Map(allQuestions(set).map((q) => [q.id, q]));
  const sections = new Map(set.sections.map((s) => [s.id, s]));
  const showers = new Map<string, { q: string; o: string }[]>();
  const hiders = new Map<string, { q: string; o: string }[]>();
  for (const q of qs.values())
    for (const o of q.options) {
      for (const t of o.shows) (showers.get(t) ?? showers.set(t, []).get(t))?.push({ q: q.id, o: o.id });
      for (const t of o.hides) (hiders.get(t) ?? hiders.set(t, []).get(t))?.push({ q: q.id, o: o.id });
    }
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  const picked = (qid: string, oid: string) => {
    const q = qs.get(qid);
    return !!q && visibleQ(qid) && effectivePicks(q, answers[qid]).includes(oid);
  };
  const cond = (c: Cond): boolean => {
    const q = qs.get(c.question);
    if (!q || !visibleQ(c.question)) return false;
    const a = answers[c.question];
    const done = !!a && a.status !== 'later' && a.status !== 'skipped';
    if (c.answered !== undefined && c.answered !== done) return false;
    const picks = effectivePicks(q, a);
    if (c.any && !c.any.some((o) => picks.includes(o))) return false;
    if (c.all && !c.all.every((o) => picks.includes(o))) return false;
    if (c.none && (!done || c.none.some((o) => picks.includes(o)))) return false;
    if (c.gte !== undefined || c.lte !== undefined) {
      const n = a?.status === 'answered' ? (a.number ?? NaN) : a?.status === 'delegated' && typeof q.recommended === 'number' ? q.recommended : NaN;
      if (!Number.isFinite(n)) return false;
      if (c.gte !== undefined && n < c.gte) return false;
      if (c.lte !== undefined && n > c.lte) return false;
    }
    return true;
  };
  const decide = (key: string, base: () => boolean): boolean => {
    if (memo.has(key)) return memo.get(key) ?? false;
    if (visiting.has(key)) return false; // a loop: whatever closes it doesn't count
    visiting.add(key);
    const id = key.slice(2);
    let v: boolean;
    if ((hiders.get(id) ?? []).some((h) => picked(h.q, h.o))) v = false;
    else if ((showers.get(id) ?? []).some((h) => picked(h.q, h.o))) v = true;
    else v = base();
    visiting.delete(key);
    memo.set(key, v);
    return v;
  };
  function visibleS(id: string): boolean {
    const s = sections.get(id);
    if (!s) return false;
    return decide('s:' + id, () => (s.showIf ? s.showIf.every(cond) : !s.hidden));
  }
  function visibleQ(id: string): boolean {
    const q = qs.get(id);
    if (!q) return false;
    if (!visibleS(q.section)) return false;
    return decide('q:' + id, () => (q.showIf ? q.showIf.every(cond) : !q.hidden));
  }
  return { question: visibleQ, section: visibleS };
}

// ── summaries ──

export interface Summary {
  id: string;
  title: string;
  status: 'open' | 'closed';
  /** every question in the file */
  total: number;
  /** questions showing now */
  visible: number;
  done: number;
  toAnswer: number;
  blocking: number;
  later: number;
  changed: number;
  /** answers the agent hasn't read yet */
  unread: number;
  /** owner messages the agent hasn't read yet */
  unreadMessages: number;
  /** answered but not acknowledged by the agent */
  unacked: number;
  updated: string;
  errors: number;
}

export function summarise(set: QSet, af: AnswerFile, errors = 0): Summary {
  const vis = visibility(set, af.answers);
  let visible = 0,
    done = 0,
    blocking = 0,
    later = 0,
    changed = 0,
    unread = 0,
    unacked = 0;
  const qs = allQuestions(set);
  for (const q of qs) {
    const a = af.answers[q.id];
    if (a && a.seq > af.readSeq) unread++;
    if (!vis.question(q.id)) continue;
    visible++;
    if (isDone(a)) done++;
    else if (q.priority === 'blocking') blocking++;
    if (a?.status === 'later') later++;
    if (isStale(q, a)) changed++;
    if (isDone(a) && a?.status !== 'skipped' && !a?.ack) unacked++;
  }
  let unreadMessages = 0;
  for (const list of Object.values(af.threads)) for (const m of list) if (m.from === 'owner' && m.seq > af.readSeq) unreadMessages++;
  let updated = set.updated;
  for (const a of Object.values(af.answers)) if (a.at > updated) updated = a.at;
  return { id: set.id, title: set.title, status: set.status, total: qs.length, visible, done, toAnswer: visible - done, blocking, later, changed, unread, unreadMessages, unacked, updated, errors };
}

// ── answers as text ──

export function answerText(q: Question | undefined, a: Answer): string {
  const parts: string[] = [];
  switch (a.status) {
    case 'skipped':
      parts.push('(skipped)');
      break;
    case 'later':
      parts.push('(later)');
      break;
    case 'delegated': {
      const rec = q ? recommendationText(q) : '';
      parts.push(rec ? `(you decide; recommended: ${rec})` : '(you decide)');
      break;
    }
    default: {
      if (a.picked?.length) {
        const labels = a.picked.map((id, i) => q?.options.find((o) => o.id === id)?.label ?? a.labels?.[i] ?? id);
        parts.push(labels.join('; '));
      }
      if (a.other) parts.push(`Other: ${a.other}`);
      if (a.text !== undefined && a.text !== '') parts.push(a.text);
      if (a.number !== undefined) parts.push(`${a.number}${q?.type === 'scale' && q.max !== undefined ? ` (of ${q.min ?? 1}–${q.max})` : q?.unit ? ' ' + q.unit : ''}`);
      if (a.order?.length) parts.push(a.order.map((id, i) => `${i + 1}. ${q?.options.find((o) => o.id === id)?.label ?? id}`).join('  '));
      if (!parts.length) parts.push('(no answer)');
    }
  }
  return parts.join(' · ');
}

export function recommendationText(q: Question): string {
  if (q.recommended === undefined) return '';
  if (Array.isArray(q.recommended)) return q.recommended.map((id) => q.options.find((o) => o.id === id)?.label ?? id).join('; ');
  return String(q.recommended) + (q.unit ? ' ' + q.unit : '');
}

/** A short line for the agent: `id: answer — note: "…"` (with flags). */
export function compactLine(q: Question | undefined, id: string, a: Answer, hidden = false): string {
  const flags = [hidden ? 'now hidden' : '', q && isStale(q, a) ? 'question changed since' : '', !q ? 'question removed' : ''].filter(Boolean);
  const note = a.note?.trim() ? ` — note: ${JSON.stringify(a.note.trim())}` : '';
  return `- ${id}: ${answerText(q, a)}${note}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

/** The answers as a readable markdown file, grouped by section. */
export function answersMarkdown(set: QSet, af: AnswerFile): string {
  const vis = visibility(set, af.answers);
  const s = summarise(set, af);
  const out = [`# ${set.title}: answers`, '', `${s.done} of ${s.visible} answered${s.blocking ? `, ${s.blocking} blocking still open` : ''}. Written by questionme; the answers themselves are in the .json next to this file.`, ''];
  for (const sec of set.sections) {
    const rows = sec.questions.filter((q) => af.answers[q.id] || af.threads[q.id]?.length);
    if (!rows.length) continue;
    if (sec.title) out.push(`## ${sec.title}`, '');
    for (const q of rows) {
      const a = af.answers[q.id];
      out.push(`### ${q.id}: ${q.question.replace(/\n+/g, ' ')}`);
      if (a) {
        out.push('', answerText(q, a));
        if (a.note?.trim()) out.push('', '> ' + a.note.trim().replace(/\n/g, '\n> '));
        const flags = [!vis.question(q.id) ? 'now hidden' : '', isStale(q, a) ? 'the question changed after this answer' : ''].filter(Boolean);
        if (flags.length) out.push('', `_(${flags.join('; ')})_`);
        if (a.ack) out.push('', `Applied: ${a.ack.note || 'yes'}`);
      }
      for (const m of af.threads[q.id] ?? []) out.push('', `- **${m.from === 'owner' ? 'Owner' : 'Agent'}:** ${m.body.replace(/\n/g, ' ')}`);
      out.push('');
    }
  }
  const orphans = Object.keys(af.answers).filter((id) => !questionById(set, id));
  if (orphans.length) {
    out.push('## Answers to removed questions', '');
    for (const id of orphans) {
      const a = af.answers[id];
      if (a) out.push(compactLine(undefined, id, a));
    }
    out.push('');
  }
  return out.join('\n');
}

// ── checking an answer against its question ──

export interface AnswerInput {
  status?: AnswerStatus;
  picked?: string[];
  other?: string;
  text?: string;
  number?: number;
  order?: string[];
  note?: string;
}

/** A clean answer from what the page sent, or an error. */
export function checkAnswer(q: Question, input: AnswerInput): { ok: true; answer: Omit<Answer, 'at' | 'seq' | 'rev'> } | { ok: false; error: string } {
  const status: AnswerStatus = input.status && (STATUSES as readonly string[]).includes(input.status) ? input.status : 'answered';
  const out: Omit<Answer, 'at' | 'seq' | 'rev'> = { status };
  const note = typeof input.note === 'string' ? input.note.slice(0, 20000) : '';
  if (note.trim()) out.note = note;
  if (status !== 'answered') return { ok: true, answer: out };
  const ids = new Set(q.options.map((o) => o.id));
  if (q.type === 'single' || q.type === 'multi' || q.type === 'yesno') {
    const picked = Array.isArray(input.picked) ? [...new Set(input.picked.map(String))] : [];
    for (const p of picked) if (!ids.has(p)) return { ok: false, error: `"${p}" isn't an option` };
    if (q.type !== 'multi' && picked.length > 1) return { ok: false, error: 'Pick one' };
    const other = typeof input.other === 'string' ? input.other.slice(0, 20000) : '';
    if (other.trim() && !q.allowOther) return { ok: false, error: 'This question has no "Other" answer' };
    if (q.type === 'single' && picked.length && other.trim()) return { ok: false, error: 'Pick one, or write your own' };
    if (picked.length) {
      out.picked = picked;
      out.labels = picked.map((p) => q.options.find((o) => o.id === p)?.label ?? p);
    }
    if (other.trim()) out.other = other;
    if (!picked.length && !other.trim() && !note.trim()) return { ok: false, error: 'Nothing picked' };
  } else if (q.type === 'text') {
    const text = typeof input.text === 'string' ? input.text.slice(0, 100000) : '';
    if (!text.trim() && !note.trim()) return { ok: false, error: 'Nothing written' };
    out.text = text;
  } else if (q.type === 'number' || q.type === 'scale') {
    const n = typeof input.number === 'number' && Number.isFinite(input.number) ? input.number : undefined;
    if (n === undefined) return { ok: false, error: 'Give a number' };
    if (q.min !== undefined && n < q.min) return { ok: false, error: `At least ${q.min}` };
    if (q.max !== undefined && n > q.max) return { ok: false, error: `At most ${q.max}` };
    out.number = n;
  } else if (q.type === 'rank') {
    const order = Array.isArray(input.order) ? input.order.map(String) : [];
    if (order.length !== ids.size || new Set(order).size !== order.length || order.some((o) => !ids.has(o))) return { ok: false, error: 'Rank every option once' };
    out.order = order;
  }
  return { ok: true, answer: out };
}

/** The answer "accept the recommendation" gives, or undefined when there is none. */
export function recommendedAnswer(q: Question): AnswerInput | undefined {
  const r = q.recommended;
  if (r === undefined) return undefined;
  if (q.type === 'number' || q.type === 'scale') return typeof r === 'number' ? { status: 'answered', number: r } : undefined;
  if (q.type === 'text') return typeof r === 'string' && r ? { status: 'answered', text: r } : undefined;
  if (q.type === 'rank') return Array.isArray(r) && r.length === q.options.length ? { status: 'answered', order: r } : undefined;
  if (Array.isArray(r) && r.length) return { status: 'answered', picked: q.type === 'multi' ? r : r.slice(0, 1) };
  return undefined;
}
