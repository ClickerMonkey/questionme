#!/usr/bin/env node
// questionme: questions from an agent, answered on your phone, saved in the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DIR, Project, StoreError } from './store.js';
import { start, version } from './server.js';
import { describeSet, parseDuration, readAnswers, summaryLine, waitFor, FILTERS, type Filter, type WaitFor } from './agent.js';
import {
  clearHubState,
  configDir,
  ensureHub,
  forget,
  hubToken,
  keyed,
  links,
  projects,
  projectsPath,
  register,
  runningHub,
  userConfig,
  userConfigPath,
  updateUserConfig,
  writeHubState,
} from './registry.js';
import { setSchema } from './schema.js';
import { serveMcp } from './mcp.js';
import { normalise } from './model.js';
import { Notifier, linkBase, notifyConfig, notifyEnabled, send } from './notify.js';

const HELP = `questionme ${version}: questions from an agent, answered on your phone, saved in the project

Serve the page:
  questionme [options]                 one server for every project (the hub); adds this folder
  questionme --solo [folder]           just this folder, on its own server
      -p, --port <n>       port to try first (default 4195)
      -H, --host <addr>    address to listen on (default 0.0.0.0: your phone can reach it, with a token)
          --local          only this computer (127.0.0.1, no token)
          --token <t>      use this token (default: one made once, kept in ${tildeOf(configDir())})
          --no-token       no token (anyone on your network can answer)
          --allow-host <h> accept this host name too (repeatable; * for any)
      -o, --open           open it in your browser
          --read-only      look, don't answer

For agents (and you), in a project folder (or -C <folder>):
  questionme init [--hook] [--no-mcp] [--no-claude-md]   set up the folder, the MCP server and CLAUDE.md
  questionme list [--json]                             sets, with counts
  questionme show <set> [--full] [--section <id>]      the questions, one line each
  questionme answers <set> [--new|--all|--unacked|--changed|--blocking|--open]
                     [--ids a,b] [--section <id>] [--limit n] [--offset n] [--peek] [--json]
                                                       answers, compactly (--new marks them read unless --peek)
  questionme wait <set> [--any|--blocking|--all|--count n|--ids a,b] [--timeout 30m] [--settle 30s]
                                                       exit when the owner has answered, then print the new answers
  questionme ack <set> <id…> --note "…"                mark answers as applied (the owner sees the note)
  questionme reply <set> <id> <message…>               write on a question's thread
  questionme validate [set|file…]                      check sets against the format
  questionme schema                                    the set format, as JSON Schema
  questionme url [set]                                 links to the page (starts the hub if needed)
  questionme stop                                      stop the hub
  questionme projects [--forget <folder>]              the folders the hub serves
  questionme notify [ntfy [url]|webhook <url>|link <url>|test|off]
                                                       push notifications when agents ask (the ntfy app, or a webhook)
  questionme hook                                      one line per set with news (for a Claude Code hook)
  questionme mcp                                       the MCP server, on stdio

Sets live in <project>/${DIR}/sets/<set>.json; answers in ${DIR}/answers/.`;

function tildeOf(p: string): string {
  return p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p;
}

function fail(msg: string, code = 1): never {
  console.error(`questionme: ${msg}`);
  process.exit(code);
}

// ── arguments ──

interface Args {
  cmd: string;
  pos: string[];
  flags: Map<string, string | true>;
}

const VALUED = new Set(['-p', '--port', '-H', '--host', '--token', '--allow-host', '-C', '--folder', '--timeout', '--settle', '--count', '--ids', '--section', '--limit', '--offset', '--note', '--forget', '--questions']);
const COMMANDS = new Set(['notify', 'serve', 'init', 'list', 'show', 'answers', 'wait', 'ack', 'reply', 'validate', 'schema', 'url', 'stop', 'projects', 'hook', 'mcp', 'help']);

function parse(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  let cmd = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (VALUED.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) fail(`${name} needs a value`);
        const prev = flags.get(name);
        flags.set(name, typeof prev === 'string' && (name === '--allow-host' || name === '--ids') ? `${prev},${v}` : v);
      } else flags.set(name, true);
      continue;
    }
    if (!cmd && !pos.length && COMMANDS.has(a)) cmd = a;
    else pos.push(a);
  }
  return { cmd: cmd || 'serve', pos, flags };
}

const args = parse(process.argv.slice(2));
const flag = (...names: string[]) => names.some((n) => args.flags.has(n));
const value = (...names: string[]) => {
  for (const n of names) {
    const v = args.flags.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
};
const folder = () => path.resolve(value('-C', '--folder') ?? process.cwd());
const project = () => new Project(folder());
const need = (v: string | undefined, what: string) => v || fail(`which ${what}? (see questionme --help)`);

if (flag('-h', '--help') || args.cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}
if (flag('-v', '--version')) {
  console.log(version);
  process.exit(0);
}


async function run(): Promise<void> {
  switch (args.cmd) {
    case 'serve':
      return serve();
    case 'mcp':
      return serveMcp();
    case 'init':
      return init();
    case 'list': {
      const p = args.pos[0] ? new Project(path.resolve(args.pos[0])) : project();
      const sets = p.summaries();
      if (flag('--json')) return void console.log(JSON.stringify({ folder: p.root, sets }, null, 2));
      if (!sets.length) return void console.log(`No question sets in ${p.root}.`);
      for (const s of sets) console.log('- ' + summaryLine(s));
      return;
    }
    case 'show':
      return void console.log(
        describeSet(project(), need(args.pos[0], 'set'), {
          full: flag('--full'),
          section: value('--section'),
          limit: num(value('--limit')),
          offset: num(value('--offset')),
          ids: list(value('--ids')),
        }),
      );
    case 'answers': {
      const filter = (FILTERS.find((f) => flag('--' + f)) ?? 'new') as Filter;
      const r = readAnswers(project(), need(args.pos[0], 'set'), {
        filter,
        ids: list(value('--ids')),
        section: value('--section'),
        limit: num(value('--limit')),
        offset: num(value('--offset')),
        peek: flag('--peek'),
        questions: (['none', 'short', 'full'].includes(value('--questions') ?? '') ? value('--questions') : undefined) as 'none' | undefined,
      });
      return void console.log(flag('--json') ? JSON.stringify(r.data, null, 2) : r.text);
    }
    case 'wait':
      return wait();
    case 'ack': {
      const [set, ...ids] = args.pos;
      const done = project().ack(need(set, 'set'), ids, value('--note') ?? '');
      return void console.log(done.length ? `Marked ${done.length} applied: ${done.join(', ')}` : 'None of those questions have answers.');
    }
    case 'reply': {
      const [set, id, ...words] = args.pos;
      project().message(need(set, 'set'), need(id, 'question'), 'agent', words.join(' '));
      return void console.log(`Replied on ${id}.`);
    }
    case 'validate':
      return validate();
    case 'schema':
      return void console.log(JSON.stringify(setSchema, null, 2));
    case 'url': {
      const p = project();
      if (p.exists) register(p.root);
      const hub = await ensureHub();
      const key = keyed(projects()).find((k) => same(k.root, p.root))?.key;
      const set = args.pos[0];
      const hash = key && p.exists ? `#/p/${encodeURIComponent(key)}${set ? `/s/${encodeURIComponent(set)}` : ''}` : '';
      for (const l of links(hub.port, hub.host, hub.token, hash)) console.log(l);
      return;
    }
    case 'stop': {
      const hub = await runningHub();
      if (!hub) return void console.log('The questionme hub is not running.');
      try {
        process.kill(hub.pid);
        console.log(`Stopped the questionme hub (pid ${hub.pid}, port ${hub.port}).`);
      } catch (e) {
        fail(`couldn't stop pid ${hub.pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    case 'projects': {
      const f = value('--forget');
      if (f) return void console.log(forget(path.resolve(f)) ? `Forgot ${path.resolve(f)}.` : `${path.resolve(f)} wasn't in the list.`);
      const all = keyed(projects());
      if (!all.length) return void console.log(`No projects yet (${tildeOf(projectsPath())}).`);
      for (const p of all) {
        const n = new Project(p.root).summaries();
        console.log(`${p.key.padEnd(20)} ${tildeOf(p.root)}  ${fs.existsSync(p.root) ? `${n.length} set${n.length === 1 ? '' : 's'}` : '(missing)'}`);
      }
      return;
    }
    case 'hook':
      return hook();
    case 'notify':
      return notify();
  }
}

// ── serve ──

async function serve(): Promise<void> {
  const cfg = userConfig();
  const solo = flag('--solo');
  const background = flag('--background');
  const local = flag('--local');
  const port = num(value('-p', '--port') ?? process.env['QUESTIONME_PORT']) ?? cfg.port ?? 4195;
  const host = value('-H', '--host') ?? process.env['QUESTIONME_HOST'] ?? (local ? '127.0.0.1' : (cfg.host ?? '0.0.0.0'));
  const token = flag('--no-token') || (local && !value('--token')) ? '' : (value('--token') ?? process.env['QUESTIONME_TOKEN'] ?? (cfg.token === false ? '' : (cfg.token ?? hubToken())));
  const allowHosts = [...(cfg.allowHosts ?? []), ...list(value('--allow-host'))];
  const root = path.resolve(args.pos[0] ?? value('-C', '--folder') ?? process.cwd());

  if (!solo) {
    if (args.pos[0] || !isHome(root)) register(root);
    const running = await runningHub();
    if (running) {
      if (background) return;
      const key = keyed(projects()).find((k) => same(k.root, root))?.key;
      console.log(`questionme is already running (pid ${running.pid}):`);
      for (const l of links(running.port, running.host, running.token, key ? `#/p/${encodeURIComponent(key)}` : '')) console.log('  ' + l);
      console.log('  (questionme stop to stop it)');
      return;
    }
  }

  const time = () => new Date().toLocaleTimeString();
  const served = solo ? () => [{ key: keyFor(root), root }] : () => keyed(projects()).filter((p) => fs.existsSync(p.root));
  // push notifications: what's there now is seen; what agents add from here on is news
  let listening = port;
  const projectOf = (key: string) => {
    const p = served().find((x) => x.key === key);
    return p ? new Project(p.root) : undefined;
  };
  const notifier = new Notifier(projectOf, () => listening, token, (line) => console.log(`[${time()}] ${line}`));
  for (const p of served()) for (const id of new Project(p.root).ids()) notifier.baseline(p.key, id);
  const running = await start({
    mode: solo ? 'solo' : 'hub',
    projects: served,
    ...(solo ? {} : { watchList: projectsPath() }),
    port,
    host,
    token,
    allowHosts,
    readOnly: flag('--read-only'),
    onAnswers: (key, set, s) => {
      console.log(`[${time()}] ${key}/${summaryLine(s)}  → npx questionme answers ${set} --new`);
      notifier.observe(key, set);
    },
    onSet: (key, set, s) => {
      console.log(`[${time()}] ${key}/${set}: questions ${s ? `changed (${s.visible} showing, ${s.errors} errors)` : 'removed'}`);
      notifier.observe(key, set);
    },
    onProject: (key, sets) => sets.forEach((set) => notifier.observe(key, set)),
  });
  listening = running.port;
  if (!solo) writeHubState({ pid: process.pid, port: running.port, host, token, version, started: new Date().toISOString() });

  const key = solo ? keyFor(root) : keyed(projects()).find((k) => same(k.root, root))?.key;
  const hash = key && new Project(root).exists ? `#/p/${encodeURIComponent(key)}` : '';
  console.log(`questionme ${version} — ${solo ? root : `${projects().length} project${projects().length === 1 ? '' : 's'} (${tildeOf(projectsPath())})`}`);
  for (const l of links(running.port, host, token, hash)) console.log('  ' + l);
  if (host === '127.0.0.1') console.log('  (only this computer: drop --local to answer from your phone)');
  if (!token && host !== '127.0.0.1') console.log('  (no token: anyone on your network can open it)');
  if (!background) {
    const p = new Project(root);
    for (const s of p.summaries()) console.log(`  ${summaryLine(s)}`);
  }
  const n = notifyConfig(cfg);
  console.log(
    notifyEnabled(n)
      ? `  notifications: ${[n.ntfy ? 'ntfy' : '', n.webhook ? 'webhook' : ''].filter(Boolean).join(' + ')} (questionme notify test)`
      : '  notifications: off (questionme notify ntfy puts them on your phone)',
  );
  if (flag('-o', '--open')) openBrowser(links(running.port, host, token, hash)[0] ?? '');

  const stop = () => {
    if (!solo) clearHubState(process.pid);
    void running.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => !solo && clearHubState(process.pid));
}

function keyFor(root: string): string {
  return (
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

const isHome = (p: string) => same(p, os.homedir());

function same(a: string, b: string): boolean {
  const n = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url.replace(/&/g, '^&')] : [url];
  spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
}

// ── wait ──

async function wait(): Promise<void> {
  const set = need(args.pos[0], 'set');
  const p = project();
  const until: WaitFor = flag('--blocking') ? 'blocking' : flag('--all') ? 'all' : value('--count') ? 'count' : value('--ids') ? 'ids' : 'any';
  const timeoutMs = parseDuration(value('--timeout'), 0);
  const settleMs = parseDuration(value('--settle'), until === 'any' || until === 'count' ? 30_000 : 0);
  const ctl = new AbortController();
  process.on('SIGINT', () => ctl.abort());
  process.on('SIGTERM', () => ctl.abort());
  if (!flag('--quiet')) {
    const s = p.summary(set);
    if (!s) throw new StoreError(`No set "${set}"`);
    console.log(`Waiting for ${until === 'any' ? 'new answers' : until === 'count' ? `${value('--count')} new answers` : until === 'ids' ? `answers to ${value('--ids')}` : `${until} questions to be answered`} in ${summaryLine(s)}`);
  }
  const ok = await waitFor(p, set, { until, ids: list(value('--ids')), count: num(value('--count')), timeoutMs, settleMs, signal: ctl.signal });
  if (!ok) {
    console.log(ctl.signal.aborted ? 'Stopped waiting.' : `Still waiting after ${value('--timeout')}.`);
    console.log(readAnswers(p, set, { filter: 'new', peek: true }).text);
    process.exit(2);
  }
  console.log('Answered. New since you last read:');
  console.log(readAnswers(p, set, { filter: 'new', peek: flag('--peek'), limit: num(value('--limit')) ?? 200 }).text);
}

// ── validate ──

function validate(): void {
  const p = project();
  const targets = args.pos.length ? args.pos : p.ids();
  if (!targets.length) return void console.log(`No sets in ${p.setsDir}.`);
  let bad = 0;
  for (const t of targets) {
    const isFile = t.endsWith('.json') && fs.existsSync(t);
    const id = isFile ? path.basename(t, '.json') : t;
    let n;
    if (isFile) {
      try {
        n = normalise(id, JSON.parse(fs.readFileSync(t, 'utf8')));
      } catch (e) {
        n = { errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`], warnings: [], set: { sections: [] } };
      }
    } else {
      const l = p.load(id);
      if (!l) {
        console.log(`✗ ${id}: no such set`);
        bad++;
        continue;
      }
      n = l;
    }
    const count = n.set.sections.reduce((s: number, x: { questions: unknown[] }) => s + x.questions.length, 0);
    console.log(`${n.errors.length ? '✗' : '✓'} ${id}: ${count} questions, ${n.errors.length} errors, ${n.warnings.length} warnings`);
    for (const e of n.errors) console.log('  error: ' + e);
    for (const w of n.warnings) console.log('  warning: ' + w);
    if (n.errors.length) bad++;
  }
  if (bad) process.exit(1);
}

// ── notify: push notifications to your phone ──

async function notify(): Promise<void> {
  const [what, arg] = args.pos;
  const show = () => {
    const n = notifyConfig();
    console.log(`Notifications (${tildeOf(userConfigPath())}):`);
    console.log(`  ntfy:    ${n.ntfy ?? '(off)'}`);
    console.log(`  webhook: ${n.webhook ?? '(off)'}`);
    console.log(`  links:   ${linkBase(n, readHub()?.port ?? 4195, '')}  (questionme notify link <url> to change)`);
    console.log(`  batched: sent once agents have been quiet for ${n.quietSeconds ?? 20} s`);
    if (!notifyEnabled(n)) console.log('\nTurn them on: questionme notify ntfy   (then subscribe in the ntfy app)');
  };
  const test = async () => {
    const n = notifyConfig();
    if (!notifyEnabled(n)) fail('notifications are off: questionme notify ntfy (or webhook <url>) first');
    await send(n, {
      title: 'questionme: notifications work',
      message: "You'll get one when an agent has new questions for you.",
      url: linkBase(n, readHub()?.port ?? 4195, ''),
      project: '',
      set: '',
      newQuestions: 0,
      blocking: 0,
      replies: 0,
    });
    console.log('Sent a test notification.');
  };
  switch (what) {
    case undefined:
      return show();
    case 'ntfy': {
      const url = arg ?? `https://ntfy.sh/questionme-${crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (!/^https?:\/\/[^/]+\/[^/]+/.test(url)) fail('an ntfy topic URL looks like https://ntfy.sh/your-topic');
      updateUserConfig((c) => (c.notify = { ...c.notify, ntfy: url }));
      console.log(`✓ ntfy topic: ${url}`);
      console.log('  On your phone: install the ntfy app (Android or iOS), tap +, and subscribe to');
      console.log(`  the topic "${new URL(url).pathname.slice(1)}"${new URL(url).host === 'ntfy.sh' ? '' : ` on the server ${new URL(url).origin}`}.`);
      console.log('  Anyone who knows the topic can read it: notifications say which set has questions, never the answers.');
      return test();
    }
    case 'webhook':
      if (!arg || !/^https?:\/\//.test(arg)) fail('questionme notify webhook <https://…>');
      updateUserConfig((c) => (c.notify = { ...c.notify, webhook: arg }));
      console.log(`✓ webhook: ${arg}`);
      return test();
    case 'link':
      if (!arg || !/^https?:\/\//.test(arg)) fail('questionme notify link <http://host:port> (where your phone opens questionme)');
      updateUserConfig((c) => (c.notify = { ...c.notify, link: arg }));
      return show();
    case 'test':
      return test();
    case 'off':
      updateUserConfig((c) => {
        if (c.notify) {
          delete c.notify.ntfy;
          delete c.notify.webhook;
        }
      });
      return void console.log('Notifications are off.');
  }
  fail(`questionme notify [ntfy [url]|webhook <url>|link <url>|test|off]`);
}

function readHub() {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), 'hub.json'), 'utf8')) as { port: number };
  } catch {
    return undefined;
  }
}

// ── hook: news for Claude Code, one line per set (nothing when there's nothing) ──

function hook(): void {
  const p = project();
  if (!p.exists) return;
  const news = p.summaries().filter((s) => s.unread || s.unreadMessages);
  for (const s of news)
    console.log(`questionme: ${summaryLine(s)}. Read them with get_answers (set "${s.id}", filter "new") or \`npx questionme answers ${s.id} --new\`.`);
}

// ── init ──

const MARK_START = '<!-- questionme -->';
const MARK_END = '<!-- /questionme -->';
const SNIPPET = `${MARK_START}
## Questions for the owner: questionme

When you have more than about 4 questions, or questions that need thought or pictures, don't ask them in chat. Put
them in a question set with the questionme MCP tools (\`add_questions\`; without MCP, write
\`.questionme/sets/<set>.json\`, format from \`npx questionme schema\`) and send the links from \`get_link\`
(\`npx questionme url <set>\`).

- Each question: a stable id, a short question, options with descriptions, one marked recommended, and \`why\` it
  matters. Mark what you can't go on without as \`blocking\`. Show files, proposed code, diffs, diagrams and mockups as
  content blocks. Follow-up questions start \`hidden\` and an option \`shows\` them.
- Keep working on what doesn't depend on the answers. To wait, run \`npx questionme wait <set> --blocking\` in the
  background: it exits, with the new answers, once they're answered.
- Read only what's new: \`get_answers\` (filter "new") or \`npx questionme answers <set> --new\`. After applying
  answers, \`ack_answers\` with a short note. Put the owner's notes into docs word for word.
${MARK_END}`;

/** How Claude Code should start questionme: through npx once it's published, else this copy. */
function launcher(): { command: string; args: string[]; line: string } {
  const cli = fileURLToPath(import.meta.url);
  if (/[\\/]_npx[\\/]|[\\/]node_modules[\\/]questionme[\\/]/.test(cli)) {
    return process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '-y', 'questionme@latest'], line: 'cmd /c npx -y questionme@latest' }
      : { command: 'npx', args: ['-y', 'questionme@latest'], line: 'npx -y questionme@latest' };
  }
  return { command: process.execPath, args: [cli], line: `"${process.execPath}" "${cli}"` };
}

function init(): void {
  const p = new Project(path.resolve(args.pos[0] ?? value('-C', '--folder') ?? process.cwd()));
  p.ensure();
  register(p.root);
  console.log(`✓ ${tildeOf(p.dir)}: sets/ and answers/ (the hub serves this folder now)`);

  if (!flag('--no-claude-md')) {
    const candidates = ['CLAUDE.md', 'AGENTS.md'].map((f) => path.join(p.root, f));
    const file = candidates.find((f) => fs.existsSync(f)) ?? candidates[0] ?? path.join(p.root, 'CLAUDE.md');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
    const next = re.test(text) ? text.replace(re, SNIPPET) : (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + SNIPPET + '\n';
    if (next !== text) {
      fs.writeFileSync(file, next);
      console.log(`✓ ${path.basename(file)}: how to use questionme ${re.test(text) ? 'updated' : 'added'}`);
    } else console.log(`✓ ${path.basename(file)}: already says how to use questionme`);
  }

  const l = launcher();
  if (!flag('--no-mcp')) {
    const shell = process.platform === 'win32';
    const has = spawnSync('claude', ['mcp', 'get', 'questionme'], { stdio: 'pipe', shell, timeout: 30_000 });
    if (has.error || has.status === null) console.log(`- Claude Code not found. Add the MCP server yourself: claude mcp add --scope user questionme -- ${l.line} mcp`);
    else if (has.status === 0) console.log('✓ MCP server: questionme is already set up in Claude Code');
    else {
      const add = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'questionme', '--', ...[l.command, ...l.args, 'mcp'].map((a) => (shell && /\s/.test(a) ? `"${a}"` : a))], { stdio: 'pipe', shell, timeout: 30_000 });
      if (add.status === 0) console.log('✓ MCP server: added to Claude Code for all your projects (restart Claude Code to load it)');
      else console.log(`✗ MCP server: claude mcp add failed (${String(add.stderr || add.stdout).trim()}). Run: claude mcp add --scope user questionme -- ${l.line} mcp`);
    }
  }

  if (flag('--hook')) {
    const file = path.join(p.root, '.claude', 'settings.json');
    let settings: { hooks?: Record<string, { hooks: { type: string; command: string }[] }[]> } = {};
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof settings;
    } catch {
      settings = {};
    }
    const command = `${l.line} hook`;
    settings.hooks ??= {};
    const list = (settings.hooks['UserPromptSubmit'] ??= []);
    if (list.some((h) => h.hooks?.some((x) => x.command.includes('questionme') && x.command.endsWith(' hook')))) console.log('✓ Hook: already in .claude/settings.json');
    else {
      list.push({ hooks: [{ type: 'command', command }] });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
      console.log('✓ Hook: .claude/settings.json tells Claude about new answers whenever you send a message');
    }
  }
  console.log('\nAnswer on your phone: npx questionme  (or: questionme url)');
}

// ── small helpers ──

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`not a number: ${v}`);
  return n;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// run last, once every helper above is defined
try {
  await run();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
