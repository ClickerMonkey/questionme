// Files inside a project folder, for `file` blocks: what is hidden, and raw serving (with ranges). From folderview.
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export interface Scope {
  root: string;
  /** names never served, wherever they are */
  hidden: Set<string>;
  /** also hide the secret-looking files (.env, *.key, *.pem, id_rsa…) */
  hideSecrets: boolean;
}

export const scopeOf = (root: string, showSecrets = false): Scope => ({ root: path.resolve(root), hidden: new Set(['.git']), hideSecrets: !showSecrets });

export function isSecret(name: string): boolean {
  if (name.startsWith('.env') && name !== '.env.example' && name !== '.env.sample') return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(name)) return true;
  return /\.(key|pem|p12|pfx|keystore)$/i.test(name);
}

export function isHidden(scope: Scope, name: string): boolean {
  return scope.hidden.has(name) || (scope.hideSecrets && isSecret(name));
}

/** The absolute path for a root-relative one, or undefined when it leaves the root or touches something hidden. */
export function inside(scope: Scope, rel: string): string | undefined {
  const clean = rel.replace(/\\/g, '/');
  const abs = path.resolve(scope.root, '.' + path.sep + clean);
  if (abs !== scope.root && !abs.startsWith(scope.root + path.sep)) return undefined;
  const parts = path.relative(scope.root, abs).split(path.sep).filter(Boolean);
  if (parts.some((p) => isHidden(scope, p))) return undefined;
  // a link may point outside the root: follow it and check again
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(scope.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined;
  } catch {
    // missing: the caller checks
  }
  return abs;
}

export const RAW_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json; charset=utf-8',
};

/** Any file the page shows: never run as a page on this origin (except a sandboxed HTML preview). */
const RAW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; font-src 'self'";
/** An HTML preview: sandboxed (no scripts, its own origin), may load its own images and styles. */
const PREVIEW_CSP = "sandbox; default-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'";

export function serveRaw(scope: Scope, rel: string, req: http.IncomingMessage, res: http.ServerResponse, asPage: boolean): void {
  const abs = inside(scope, rel);
  let st: fs.Stats | undefined;
  try {
    st = abs === undefined ? undefined : fs.statSync(abs);
  } catch {
    st = undefined;
  }
  if (abs === undefined || st === undefined || !st.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  const type = asPage && /^html?$/.test(ext) ? 'text/html; charset=utf-8' : (RAW_TYPES[ext] ?? 'text/plain; charset=utf-8');
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': asPage ? PREVIEW_CSP : RAW_CSP,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
      return;
    }
    start = Math.max(0, start);
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': String(end - start + 1) });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': String(st.size) });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(abs).pipe(res);
}

/** A text file's contents for a `file` block, cut to a line range if asked. */
export function readText(scope: Scope, rel: string, lines: string, maxBytes: number): { text: string; size: number; first: number; total: number; truncated: boolean } | { error: string; status: number } {
  const abs = inside(scope, rel);
  if (!abs) return { error: 'Not available', status: 404 };
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: `No file ${rel}`, status: 404 };
  }
  if (!st.isFile()) return { error: `${rel} isn't a file`, status: 400 };
  const buf = fs.readFileSync(abs).subarray(0, lines ? Math.max(maxBytes, 50 * 1048576) : maxBytes);
  if (buf.subarray(0, 8000).includes(0)) return { error: `${rel} is a binary file`, status: 415 };
  let text = buf.toString('utf8');
  const all = text.split(/\r?\n/);
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
  let first = 1;
  if (m) {
    first = Math.max(1, Number(m[1]));
    const last = Math.min(all.length, m[2] ? Number(m[2]) : first);
    text = all.slice(first - 1, last).join('\n');
  }
  const truncated = !m && st.size > maxBytes;
  return { text, size: st.size, first, total: all.length, truncated };
}
