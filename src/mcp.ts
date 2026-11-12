// `questionme mcp`: an MCP server on stdio (JSON-RPC, one message per line) with tools to manage question sets and
// read answers a little at a time. No SDK: the protocol needed here is small, and npx starts it quickly.
import path from 'node:path';
import readline from 'node:readline';
import { Project, StoreError } from './store.js';
import { describeSet, readAnswers, summaryLine, waitFor, FILTERS, WAITS, type Filter, type WaitFor } from './agent.js';
import { ensureHub, links, register, keyed, projects, runningHub } from './registry.js';
import { questionSchema, sectionSchema, blockSchema, conditionSchema } from './schema.js';
import { version } from './server.js';
import type { QuestionInput, SectionInput, SetInput } from './model.js';

const INSTRUCTIONS = `questionme puts questions in front of the user on their phone, where they answer at their own pace; answers are saved in the project (.questionme/answers/).
Use it instead of asking in chat when you have more than about 4 questions, questions that need thought or pictures (designs, trade-offs, proposed code or diffs), or questions that can be answered while you work.
1. add_questions to a set (one set per topic or plan). Give each question a stable id, a short question, options with descriptions, mark one recommended, and say why it matters. Mark the ones you can't go on without as blocking. Use content blocks (files, code, diffs, mermaid, images, html mockups) instead of long prose. Use hidden + an option's "shows" (or showIf) for follow-up questions that only matter after a certain answer.
2. get_link and give the user the links (their phone uses the LAN or Tailscale address).
3. Keep working on what doesn't depend on the answers. To wait, prefer running \`npx questionme wait <set> --blocking\` (or --all / --any) in the background: it exits, and wakes you, when the condition holds. wait_for_answers blocks for at most a few minutes.
4. get_answers with filter "new" returns only what changed since you last read, compactly; page with limit/offset for big sets. Apply them, then ack_answers with a short note the user sees. Put the user's notes into docs word for word. Answer their messages with reply.
5. The questionme CLI does all of this too, plus serving and setup: run \`npx questionme --help\` for every command and option (e.g. --base to serve under a URL path, --solo, notify) instead of guessing.`;

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json, signal: AbortSignal) => Promise<string>;
}

const folderProp = { folder: { type: 'string', description: 'The project folder (default: the folder the MCP server started in)' } };
const setProp = { set: { type: 'string', description: 'The set id: letters, digits, . _ - (its file is .questionme/sets/<set>.json)' } };
const idsProp = { ids: { type: 'array', items: { type: 'string' } } };

const projectOf = (args: Json) => new Project(path.resolve(typeof args['folder'] === 'string' && args['folder'] ? args['folder'] : process.cwd()));
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
const setOf = (args: Json) => {
  const s = str(args['set']);
  if (!s) throw new StoreError('Which set? Pass "set".');
  return s;
};

/** The hub's link for a set (the hub is started if needed, and knows the project). */
async function linkFor(project: Project, set?: string, start = true): Promise<string> {
  register(project.root);
  const hub = start ? await ensureHub() : await runningHub();
  if (!hub) return 'The questionme server is not running (get_link starts it).';
  const key = keyed(projects()).find((p) => path.resolve(p.root).toLowerCase() === project.root.toLowerCase())?.key ?? '';
  const hash = key ? `#/p/${encodeURIComponent(key)}${set ? `/s/${encodeURIComponent(set)}` : ''}` : '';
  const all = links(hub.port, hub.host, hub.token, hash, hub.base);
  return ['Links (the first is this computer; the others work from a phone on the same network or Tailscale):', ...all.map((l) => '  ' + l)].join('\n');
}

function problems(n: { errors: string[]; warnings: string[] }): string {
  const out: string[] = [];
  if (n.errors.length) out.push('Errors:', ...n.errors.map((e) => '  ' + e));
  if (n.warnings.length) out.push('Warnings:', ...n.warnings.slice(0, 20).map((e) => '  ' + e));
  return out.join('\n');
}

const tools: Tool[] = [
  {
    name: 'list_sets',
    description: 'The question sets in this project, with counts (answered, blocking still open, new answers, new messages). Cheap: no answers are returned.',
    inputSchema: { type: 'object', properties: { ...folderProp } },
    run: async (a) => {
      const p = projectOf(a);
      const sets = p.summaries();
      const hub = await runningHub();
      const lines = [sets.length ? `Sets in ${p.root}:` : `No question sets in ${p.root} yet (add_questions makes one).`, ...sets.map((s) => '- ' + summaryLine(s))];
      if (hub) lines.push('', (await linkFor(p, undefined, false)).split('\n').slice(0, 3).join('\n'));
      return lines.join('\n');
    },
  },
  {
    name: 'add_questions',
    description:
      'Add questions to a set (the set and section are made if needed). Returns the ids, any problems, and the link to send the user. Questions are validated: a bad one is rejected with the reason.',
    inputSchema: {
      type: 'object',
      required: ['set', 'questions'],
      properties: {
        ...setProp,
        title: { type: 'string', description: "The set's title, when it's new" },
        section: { oneOf: [{ type: 'string', description: 'An existing section id' }, { ...sectionSchema, description: 'A section (made if new): id, title, intro, content, hidden, showIf' }] },
        before: { type: 'string', description: 'Insert before this question id (default: at the end of the section)' },
        questions: { type: 'array', items: questionSchema, minItems: 1 },
        ...folderProp,
      },
    },
    run: async (a) => {
      const p = projectOf(a);
      const set = setOf(a);
      const qs = Array.isArray(a['questions']) ? (a['questions'] as QuestionInput[]) : [];
      if (!qs.length) throw new StoreError('No questions given');
      const section = a['section'] && typeof a['section'] === 'object' ? (a['section'] as SectionInput) : str(a['section']) || undefined;
      const { ids, normalised } = p.addQuestions(set, qs, section, { title: str(a['title']) || undefined, before: str(a['before']) || undefined });
      return [`Added ${ids.length} question${ids.length === 1 ? '' : 's'} to "${set}": ${ids.join(', ')}`, problems(normalised), await linkFor(p, set)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'update_question',
    description:
      'Change a question: the fields in "changes" replace the question\'s own (null removes a field; options are replaced whole). If the question text, type or options change, an earlier answer is flagged "changed" for the user to look at again.',
    inputSchema: {
      type: 'object',
      required: ['set', 'id', 'changes'],
      properties: { ...setProp, id: { type: 'string' }, changes: { type: 'object', description: 'Question fields (see add_questions)' }, ...folderProp },
    },
    run: async (a) => {
      const p = projectOf(a);
      const n = p.updateQuestion(setOf(a), str(a['id']), (a['changes'] as Json) ?? {});
      return [`Updated ${str(a['id'])}.`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'remove_questions',
    description: 'Remove questions from a set. Their answers stay in the answers file, listed as answers to removed questions.',
    inputSchema: { type: 'object', required: ['set', 'ids'], properties: { ...setProp, ...idsProp, ...folderProp } },
    run: async (a) => {
      const removed = projectOf(a).removeQuestions(setOf(a), strList(a['ids']));
      return removed.length ? `Removed ${removed.join(', ')}.` : 'None of those ids are in the set.';
    },
  },
  {
    name: 'update_set',
    description: "Make a set, or change its title, intro, content or status (closed sets drop to the bottom of the user's list).",
    inputSchema: {
      type: 'object',
      required: ['set'],
      properties: {
        ...setProp,
        title: { type: 'string' },
        intro: { type: 'string', description: 'Markdown at the top of the set' },
        content: { oneOf: [blockSchema, { type: 'array', items: blockSchema }] },
        status: { enum: ['open', 'closed'] },
        ...folderProp,
      },
    },
    run: async (a) => {
      const p = projectOf(a);
      const set = setOf(a);
      const patch: Partial<SetInput> = {};
      if (typeof a['title'] === 'string') patch.title = a['title'];
      if (typeof a['intro'] === 'string') patch.intro = a['intro'];
      if (a['content'] !== undefined) patch.content = a['content'] as SetInput['content'];
      if (a['status'] === 'open' || a['status'] === 'closed') patch.status = a['status'];
      const n = p.updateSet(set, patch, true);
      return [`Saved set "${set}".`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'update_section',
    description: "Make a section, or change its title, intro, content, hidden or showIf (null removes a field). Its questions aren't touched.",
    inputSchema: {
      type: 'object',
      required: ['set', 'id'],
      properties: {
        ...setProp,
        id: { type: 'string' },
        title: { type: 'string' },
        intro: { type: 'string' },
        content: { oneOf: [blockSchema, { type: 'array', items: blockSchema }] },
        hidden: { type: 'boolean' },
        showIf: conditionSchema,
        ...folderProp,
      },
    },
    run: async (a) => {
      const p = projectOf(a);
      const patch: Json = {};
      for (const k of ['title', 'intro', 'content', 'hidden', 'showIf']) if (k in a) patch[k] = a[k];
      const n = p.updateSection(setOf(a), str(a['id']), patch);
      return [`Saved section "${str(a['id'])}".`, problems(n)].filter(Boolean).join('\n');
    },
  },
  {
    name: 'show_set',
    description: "A set's questions, one line each with their state (open, answered, later, hidden, changed). full: true adds options. Page with limit/offset.",
    inputSchema: {
      type: 'object',
      required: ['set'],
      properties: { ...setProp, section: { type: 'string' }, ...idsProp, full: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' }, ...folderProp },
    },
    run: async (a) =>
      describeSet(projectOf(a), setOf(a), {
        section: str(a['section']) || undefined,
        ids: strList(a['ids']),
        full: a['full'] === true,
        limit: typeof a['limit'] === 'number' ? a['limit'] : undefined,
        offset: typeof a['offset'] === 'number' ? a['offset'] : undefined,
      }),
  },
  {
    name: 'get_answers',
    description:
      'Read answers, compactly: "id (question): answer — note" per line. filter: new (the default: answers and user messages since you last read; reading marks them read unless peek), all, unacked (answered but not acked), changed (answered before the question changed), blocking, open (still to answer, with recommendations). Page with limit/offset; narrow with ids or section. format: "json" for the full records.',
    inputSchema: {
      type: 'object',
      required: ['set'],
      properties: {
        ...setProp,
        filter: { enum: [...FILTERS] },
        ...idsProp,
        section: { type: 'string' },
        limit: { type: 'integer', description: 'Default 100' },
        offset: { type: 'integer' },
        peek: { type: 'boolean', description: "Don't mark new answers read" },
        questions: { enum: ['none', 'short', 'full'], description: 'How much of each question to repeat (default short)' },
        format: { enum: ['text', 'json'] },
        ...folderProp,
      },
    },
    run: async (a) => {
      const r = readAnswers(projectOf(a), setOf(a), {
        filter: (FILTERS as readonly string[]).includes(str(a['filter'])) ? (str(a['filter']) as Filter) : 'new',
        ids: strList(a['ids']),
        section: str(a['section']) || undefined,
        limit: typeof a['limit'] === 'number' ? a['limit'] : undefined,
        offset: typeof a['offset'] === 'number' ? a['offset'] : undefined,
        peek: a['peek'] === true,
        questions: ['none', 'short', 'full'].includes(str(a['questions'])) ? (str(a['questions']) as 'none') : undefined,
      });
      return a['format'] === 'json' ? JSON.stringify(r.data, null, 1) : r.text;
    },
  },
  {
    name: 'wait_for_answers',
    description:
      'Block until the user has answered: until "any" (new answers or messages; the default), "blocking" (every visible blocking question done), "all", "ids" (these questions), or "count" (this many new answers). Waits at most timeout_seconds (default 240, max 900); settle_seconds waits for a pause in answering. For longer waits run `npx questionme wait <set> --blocking` in the background instead. Returns the new answers (marking them read) when it ends.',
    inputSchema: {
      type: 'object',
      required: ['set'],
      properties: {
        ...setProp,
        until: { enum: [...WAITS] },
        ...idsProp,
        count: { type: 'integer' },
        timeout_seconds: { type: 'number' },
        settle_seconds: { type: 'number' },
        ...folderProp,
      },
    },
    run: async (a, signal) => {
      const p = projectOf(a);
      const set = setOf(a);
      const until = (WAITS as readonly string[]).includes(str(a['until'])) ? (str(a['until']) as WaitFor) : 'any';
      const timeout = Math.min(900, Math.max(1, typeof a['timeout_seconds'] === 'number' ? a['timeout_seconds'] : 240)) * 1000;
      const settle = Math.max(0, typeof a['settle_seconds'] === 'number' ? a['settle_seconds'] : until === 'any' || until === 'count' ? 20 : 0) * 1000;
      const ok = await waitFor(p, set, { until, ids: strList(a['ids']), count: typeof a['count'] === 'number' ? a['count'] : undefined, timeoutMs: timeout, settleMs: settle, signal });
      const r = readAnswers(p, set, { filter: 'new' });
      return (ok ? 'Done waiting.\n' : `Still waiting after ${Math.round(timeout / 1000)} s.\n`) + r.text;
    },
  },
  {
    name: 'ack_answers',
    description: 'Mark answers as applied, with a short note the user sees under each (e.g. "updated plan §3"). Changing the answer afterwards clears it.',
    inputSchema: { type: 'object', required: ['set', 'ids', 'note'], properties: { ...setProp, ...idsProp, note: { type: 'string' }, ...folderProp } },
    run: async (a) => {
      const done = projectOf(a).ack(setOf(a), strList(a['ids']), str(a['note']));
      return done.length ? `Marked ${done.length} applied: ${done.join(', ')}` : 'None of those questions have answers.';
    },
  },
  {
    name: 'reply',
    description: "Write on a question's thread: answer the user's message, explain, or ask a follow-up. They see it under the question.",
    inputSchema: { type: 'object', required: ['set', 'id', 'message'], properties: { ...setProp, id: { type: 'string' }, message: { type: 'string', description: 'Markdown' }, ...folderProp } },
    run: async (a) => {
      projectOf(a).message(setOf(a), str(a['id']), 'agent', str(a['message']));
      return `Replied on ${str(a['id'])}.`;
    },
  },
  {
    name: 'get_link',
    description: 'Links to the set (or every set) on the shared questionme server, which this starts if needed. Give these to the user.',
    inputSchema: { type: 'object', properties: { set: { type: 'string' }, ...folderProp } },
    run: async (a) => linkFor(projectOf(a), str(a['set']) || undefined),
  },
];

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function serveMcp(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const send = (msg: Json) => output.write(JSON.stringify(msg) + '\n');
  const running = new Map<string | number, AbortController>();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const handle = async (msg: Json) => {
    const id = msg['id'] as string | number | undefined;
    const method = str(msg['method']);
    const params = (msg['params'] as Json) ?? {};
    const reply = (result: Json) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = str(params['protocolVersion']);
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'questionme', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params['name']);
        if (!tool) return fail(-32602, `Unknown tool ${str(params['name'])}`);
        const ctl = new AbortController();
        if (id !== undefined) running.set(id, ctl);
        try {
          const text = await tool.run((params['arguments'] as Json) ?? {}, ctl.signal);
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
        } finally {
          if (id !== undefined) running.delete(id);
        }
      }
      case 'notifications/cancelled': {
        const rid = params['requestId'] as string | number | undefined;
        if (rid !== undefined) running.get(rid)?.abort();
        return;
      }
      default:
        if (method.startsWith('notifications/')) return;
        return fail(-32601, `Method not found: ${method}`);
    }
  };

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) if (m && typeof m === 'object') void handle(m as Json);
    });
    rl.on('close', () => {
      for (const c of running.values()) c.abort();
      resolve();
    });
  });
}
