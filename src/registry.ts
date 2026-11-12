// The shared server ("the hub"): one questionme for every project, so a phone needs one bookmark.
//   ~/.config/questionme/projects.json  the folders it serves (added by `questionme`, `init` and the MCP server)
//   ~/.config/questionme/hub.json       where the running hub listens (written while it runs)
//   ~/.config/questionme/token          the hub's access token (made once)
//   ~/.config/questionme/config.json    your settings (port, host, token, …)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeAtomic, withLock } from './store.js';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['QUESTIONME_HOME']) return path.resolve(env['QUESTIONME_HOME']);
  return path.join(env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'questionme');
}

export interface ProjectEntry {
  root: string;
  added: string;
}

export interface Keyed extends ProjectEntry {
  /** the project's name in links: its folder name, made unique */
  key: string;
}

const projectsFile = () => path.join(configDir(), 'projects.json');

export function projects(): ProjectEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile(), 'utf8')) as { projects?: ProjectEntry[] };
    return Array.isArray(data.projects) ? data.projects.filter((p) => p && typeof p.root === 'string') : [];
  } catch {
    return [];
  }
}

/** Projects with their keys: the folder's name, with -2, -3 … when two share a name (oldest keeps the plain one). */
export function keyed(list: ProjectEntry[] = projects()): Keyed[] {
  const used = new Map<string, number>();
  return list.map((p) => {
    const base =
      path
        .basename(p.root)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'project';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { ...p, key: n === 1 ? base : `${base}-${n}` };
  });
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/** Add a folder to the hub's list (no-op if it's there). Returns true when added. */
export function register(root: string): boolean {
  fs.mkdirSync(configDir(), { recursive: true });
  return withLock(projectsFile(), () => {
    const list = projects();
    if (list.some((p) => norm(p.root) === norm(root))) return false;
    list.push({ root: path.resolve(root), added: new Date().toISOString() });
    writeAtomic(projectsFile(), JSON.stringify({ projects: list }, null, 2) + '\n');
    return true;
  });
}

export function forget(root: string): boolean {
  if (!fs.existsSync(projectsFile())) return false;
  return withLock(projectsFile(), () => {
    const list = projects();
    const kept = list.filter((p) => norm(p.root) !== norm(root));
    if (kept.length === list.length) return false;
    writeAtomic(projectsFile(), JSON.stringify({ projects: kept }, null, 2) + '\n');
    return true;
  });
}

export function projectsPath(): string {
  return projectsFile();
}

// ── user settings ──

export interface UserConfig {
  port?: number;
  host?: string;
  /** a fixed token, or false for none (default: one made once and kept in ~/.config/questionme/token) */
  token?: string | false;
  allowHosts?: string[];
  /** the name shown on answers and replies from the page */
  author?: string;
}

export function userConfig(): UserConfig {
  const file = process.env['QUESTIONME_CONFIG'] ? path.resolve(process.env['QUESTIONME_CONFIG']) : path.join(configDir(), 'config.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as UserConfig;
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

/** The hub's token: made once, kept in the config folder. */
export function hubToken(): string {
  const file = path.join(configDir(), 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {
    // make one
  }
  fs.mkdirSync(configDir(), { recursive: true });
  const t = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

// ── the running hub ──

export interface HubState {
  pid: number;
  port: number;
  host: string;
  token: string;
  version: string;
  started: string;
}

const hubFile = () => path.join(configDir(), 'hub.json');

export function writeHubState(s: HubState): void {
  fs.mkdirSync(configDir(), { recursive: true });
  writeAtomic(hubFile(), JSON.stringify(s, null, 2) + '\n');
}

export function clearHubState(pid: number): void {
  const s = readHubState();
  if (s && s.pid === pid) fs.rmSync(hubFile(), { force: true });
}

export function readHubState(): HubState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(hubFile(), 'utf8')) as HubState;
    return s && typeof s.port === 'number' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Is a questionme listening there? Resolves with its version, or undefined. */
export function ping(port: number, timeout = 1500): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => {
        try {
          const d = JSON.parse(body) as { app?: string; version?: string };
          resolve(d.app === 'questionme' ? (d.version ?? '?') : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}

/** The running hub, if there is one. */
export async function runningHub(): Promise<HubState | undefined> {
  const s = readHubState();
  if (!s) return undefined;
  return (await ping(s.port)) ? s : undefined;
}

const cliPath = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');

/** The hub, started in the background if it isn't running. */
export async function ensureHub(): Promise<HubState> {
  const running = await runningHub();
  if (running) return running;
  fs.mkdirSync(configDir(), { recursive: true });
  const log = fs.openSync(path.join(configDir(), 'hub.log'), 'a');
  const child = spawn(process.execPath, [cliPath(), 'serve', '--background'], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    const s = await runningHub();
    if (s) return s;
  }
  throw new Error(`The questionme server didn't start; see ${path.join(configDir(), 'hub.log')}`);
}

// ── links ──

/** virtual adapters (WSL, Hyper-V, Docker, VMs): a phone can't reach these */
const VIRTUAL = /vethernet|wsl|hyper-v|docker|vmnet|virtualbox|vbox|^br-|^veth|^virbr|loopback/i;

export function lanAddresses(): string[] {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((n) => n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

/** Links to a page: this computer first, then every address other devices can use. */
export function links(port: number, host: string, token: string, hash = ''): string[] {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const everywhere = host === '0.0.0.0' || host === '::';
  const local = everywhere || host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
  const out = [`http://${local}:${port}/${q}${hash}`];
  if (everywhere) for (const ip of lanAddresses()) out.push(`http://${ip}:${port}/${q}${hash}`);
  return out;
}
