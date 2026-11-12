// The HTTP server: the page, the sets and answers of every project it serves, the project files that questions show,
// and live events when anything changes on disk (an agent adding questions, an answer from another device).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Project, StoreError } from './store.js';
import { readText, scopeOf, serveRaw } from './files.js';
import type { AnswerInput, Summary } from './model.js';

export interface ServedProject {
  key: string;
  root: string;
}

export interface Options {
  /** the projects to serve; read again when `watchList` changes */
  projects: () => ServedProject[];
  /** a file whose changes mean the project list changed (the hub's projects.json) */
  watchList?: string;
  mode: 'hub' | 'solo';
  port: number;
  host: string;
  token?: string;
  allowHosts?: string[];
  readOnly?: boolean;
  dirName?: string;
  /** text files bigger than this aren't shown whole */
  maxFileMb?: number;
  showSecrets?: boolean;
  /** answers or messages changed in a set (from anywhere) */
  onAnswers?: (project: string, set: string, summary: Summary) => void;
  /** a set was added or its questions changed */
  onSet?: (project: string, set: string, summary: Summary | undefined) => void;
}

export interface Running {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, 'client');
export const version = readVersion();

const STATIC: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export async function start(opts: Options): Promise<Running> {
  const token = opts.token ?? '';
  const maxFile = (opts.maxFileMb ?? 2) * 1048576;
  const pool = new Map<string, { project: Project; root: string; stop?: () => void }>();
  const clients = new Set<http.ServerResponse>();
  const broadcast = (type: string, data: unknown) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  // what changed, per set, so the console and the page hear about each change once
  const last = new Map<string, { answersMtime: number; setMtime: number }>();
  const pending = new Map<string, NodeJS.Timeout>();
  const check = (key: string, setId: string) => {
    const id = key + '/' + setId;
    if (pending.has(id)) return;
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        const p = pool.get(key)?.project;
        if (!p) return;
        const mt = (f: string) => {
          try {
            return fs.statSync(f).mtimeMs;
          } catch {
            return 0;
          }
        };
        let setFile = '',
          answersFile = '';
        try {
          setFile = p.setPath(setId);
          answersFile = p.answersPath(setId);
        } catch {
          return;
        }
        const now = { setMtime: mt(setFile), answersMtime: mt(answersFile) };
        const was = last.get(id);
        last.set(id, now);
        if (was && was.setMtime === now.setMtime && was.answersMtime === now.answersMtime) return;
        const summary = p.summary(setId);
        broadcast('change', { project: key, set: setId, summary });
        if (!was || was.setMtime !== now.setMtime) opts.onSet?.(key, setId, summary);
        else if (summary) opts.onAnswers?.(key, setId, summary);
      }, 120),
    );
  };

  const watchProject = (key: string, entry: { project: Project; stop?: () => void }) => {
    if (entry.stop || !fs.existsSync(entry.project.dir)) return;
    try {
      const w = fs.watch(entry.project.dir, { recursive: true }, (_e, name) => {
        const rel = String(name ?? '').split(path.sep).join('/');
        const m = /^(sets|answers)\/([^/]+)\.(json|md)$/.exec(rel);
        if (m && m[3] === 'json' && m[2]) check(key, m[2]);
      });
      w.on('error', () => undefined);
      entry.stop = () => w.close();
    } catch {
      entry.stop = () => undefined;
    }
    // remember where each set starts, so the first change is told apart from the first look
    for (const id of entry.project.ids()) {
      const mt = (f: string) => {
        try {
          return fs.statSync(f).mtimeMs;
        } catch {
          return 0;
        }
      };
      last.set(key + '/' + id, { setMtime: mt(entry.project.setPath(id)), answersMtime: mt(entry.project.answersPath(id)) });
    }
  };

  const refresh = () => {
    const list = opts.projects();
    const keys = new Set(list.map((p) => p.key));
    let changed = false;
    for (const [k, e] of pool)
      if (!keys.has(k) || list.find((p) => p.key === k)?.root !== e.root) {
        e.stop?.();
        pool.delete(k);
        changed = true;
      }
    for (const p of list) {
      if (!pool.has(p.key)) {
        pool.set(p.key, { project: new Project(p.root, opts.dirName), root: p.root });
        changed = true;
      }
      const e = pool.get(p.key);
      if (e) watchProject(p.key, e);
    }
    if (changed) broadcast('projects', {});
  };
  refresh();
  // a project's .questionme folder may appear later, and the list may change: look again now and then
  const tick = setInterval(refresh, 2000);
  tick.unref();
  let listWatch: fs.FSWatcher | undefined;
  if (opts.watchList) {
    try {
      listWatch = fs.watch(path.dirname(opts.watchList), (_e, name) => {
        if (String(name) === path.basename(opts.watchList ?? '')) refresh();
      });
      listWatch.on('error', () => undefined);
    } catch {
      // the tick covers it
    }
  }
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);
  ping.unref();

  const allowed = allowedHosts(opts.host, opts.allowHosts ?? []);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const code = err instanceof StoreError ? 400 : 500;
      if (!res.headersSent) json(res, code, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!allowed(host)) return json(res, 403, { error: `Host "${host}" is not allowed. Start with --allow-host ${host} to allow it.` });
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/api/ping') return json(res, 200, { app: 'questionme', version, mode: opts.mode });
    if (token) {
      const given = url.searchParams.get('token') ?? bearer(req) ?? cookie(req, 'questionme_token') ?? '';
      if (!same(given, token)) {
        if (p === '/' || p === '/index.html') return void res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOCKED);
        return json(res, 401, { error: 'This questionme needs its token: open the link with ?token=… once.' });
      }
      if (url.searchParams.has('token')) {
        url.searchParams.delete('token');
        res.setHeader('set-cookie', `questionme_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
        if (p === '/' || p === '/index.html') return void res.writeHead(302, { location: '/' + (url.search || '') }).end();
      }
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin write refused' });
      if (opts.readOnly) return json(res, 403, { error: 'This questionme is read-only' });
    }
    const q = (k: string) => url.searchParams.get(k) ?? '';

    if (p === '/' || p === '/index.html') return sendStatic(res, path.join(clientDir, 'index.html'));
    if (p.startsWith('/assets/')) {
      const abs = path.resolve(clientDir, '.' + p);
      if (!abs.startsWith(clientDir + path.sep)) return json(res, 404, { error: 'not found' });
      return sendStatic(res, abs);
    }

    if (p === '/api/info') {
      return json(res, 200, {
        version,
        mode: opts.mode,
        hostname: os.hostname(),
        readOnly: !!opts.readOnly,
        projects: [...pool.entries()].map(([key, e]) => ({
          key,
          name: path.basename(e.root),
          root: tilde(e.root),
          sets: e.project.summaries(),
        })),
      });
    }

    const raw = /^\/raw\/([^/]+)\/(.+)$/.exec(p);
    if (raw) {
      const e = pool.get(decodeURIComponent(raw[1] ?? ''));
      if (!e) return json(res, 404, { error: 'No such project' });
      return serveRaw(scopeOf(e.root, opts.showSecrets), decodeURIComponent(raw[2] ?? ''), req, res, q('as') === 'page');
    }

    const pm = /^\/api\/p\/([^/]+)(\/.*)?$/.exec(p);
    if (!pm) {
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('event: hello\ndata: {}\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      return json(res, 404, { error: 'not found' });
    }
    const e = pool.get(decodeURIComponent(pm[1] ?? ''));
    if (!e) return json(res, 404, { error: 'No such project' });
    const project = e.project;
    const rest = pm[2] ?? '';

    if (rest === '/text') {
      const r = readText(scopeOf(e.root, opts.showSecrets), q('path'), q('lines'), maxFile);
      return 'error' in r ? json(res, r.status, { error: r.error }) : json(res, 200, r);
    }
    const sm = /^\/s\/([^/]+)(\/[a-z]+)?$/.exec(rest);
    if (!sm) return json(res, 404, { error: 'not found' });
    const setId = decodeURIComponent(sm[1] ?? '');
    const action = sm[2] ?? '';
    if (!project.has(setId)) return json(res, 404, { error: `No set "${setId}"` });

    if (!action && method === 'GET') {
      const l = project.load(setId);
      if (!l) return json(res, 404, { error: `No set "${setId}"` });
      return json(res, 200, { set: l.set, errors: l.errors, warnings: l.warnings, answers: project.answers(setId), summary: project.summary(setId) });
    }
    if (method !== 'POST') return json(res, 405, { error: 'POST' });
    const b = await body(req);
    const qid = typeof b['id'] === 'string' ? b['id'] : '';
    switch (action) {
      case '/answer': {
        if (b['clear'] === true) {
          project.clear(setId, qid);
          return json(res, 200, { answer: null, summary: project.summary(setId) });
        }
        const a = project.answer(setId, qid, answerInput(b));
        return json(res, 200, { answer: a, summary: project.summary(setId) });
      }
      case '/accept': {
        const ids = Array.isArray(b['ids']) ? b['ids'].map(String) : [];
        const taken = project.acceptRecommended(setId, ids);
        return json(res, 200, { taken, answers: project.answers(setId), summary: project.summary(setId) });
      }
      case '/message': {
        const m = project.message(setId, qid, 'owner', typeof b['body'] === 'string' ? b['body'] : '');
        return json(res, 200, { message: m });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  const port = await listen(server, opts.port, opts.host);
  return {
    server,
    port,
    close: async () => {
      clearInterval(tick);
      clearInterval(ping);
      listWatch?.close();
      for (const e of pool.values()) e.stop?.();
      for (const t of pending.values()) clearTimeout(t);
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function answerInput(b: Record<string, unknown>): AnswerInput {
  const out: AnswerInput = {};
  if (typeof b['status'] === 'string') out.status = b['status'] as AnswerInput['status'];
  if (Array.isArray(b['picked'])) out.picked = b['picked'].map(String);
  if (typeof b['other'] === 'string') out.other = b['other'];
  if (typeof b['text'] === 'string') out.text = b['text'];
  if (typeof b['number'] === 'number') out.number = b['number'];
  if (Array.isArray(b['order'])) out.order = b['order'].map(String);
  if (typeof b['note'] === 'string') out.note = b['note'];
  return out;
}

/** listen on the port, or the next free one */
function listen(server: http.Server, port: number, host: string, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && tries > 1 && port !== 0) resolve(listen(server, port + 1, host, tries - 1));
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const LOCKED =
  '<!doctype html><meta name="viewport" content="width=device-width"><title>questionme</title><body style="font:16px system-ui;padding:2em;max-width:36em;margin:auto"><h1>🔒 This questionme needs its token</h1><p>Open the link you were given (it ends in <code>?token=…</code>). It is kept as a cookie, so you only need it once on this device. <code>npx questionme url</code> prints the links.</p>';

const bearer = (req: http.IncomingMessage) => /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
const cookie = (req: http.IncomingMessage, name: string) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
};
function same(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function allowedHosts(bind: string, extra: string[]): (host: string) => boolean {
  const names = new Set(['localhost', os.hostname().toLowerCase(), ...extra.map((h) => h.toLowerCase())]);
  if (bind !== '0.0.0.0' && bind !== '::') names.add(bind.toLowerCase());
  return (h) =>
    names.has(h) ||
    h.endsWith('.localhost') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || // an IP address can't be rebound
    h.includes(':') ||
    extra.includes('*');
}

const tilde = (p: string) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

function sendStatic(res: http.ServerResponse, abs: string): void {
  fs.readFile(abs, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': STATIC[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(buf);
  });
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(data));
}

async function body(req: http.IncomingMessage, max = 1_000_000): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new StoreError('Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    size += b.length;
    if (size > max) throw new StoreError('Too large');
    chunks.push(b);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreError('Send a JSON object');
  return Object.fromEntries(Object.entries(data));
}

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' && 'version' in pkg ? String(pkg.version) : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
