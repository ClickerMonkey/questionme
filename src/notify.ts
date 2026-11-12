// Push notifications to your phone when an agent asks something new: through ntfy (a push app for Android and iOS; the
// hub posts to your private topic) or any webhook (Pushover, Discord, Home Assistant, …). Changes are batched: an agent
// adding 50 questions over a minute makes one notification, sent once it has been quiet for a while.
//
// Web Push isn't used: a phone only allows it on HTTPS pages, and questionme is opened over plain http on the LAN.
import os from 'node:os';
import { userConfig, lanAddresses, type UserConfig } from './registry.js';
import { allQuestions, visibility, isDone } from './model.js';
import type { Project } from './store.js';

export interface NotifyConfig {
  /** an ntfy topic URL, e.g. https://ntfy.sh/questionme-k3j2h4 */
  ntfy?: string;
  /** an ntfy access token, for a protected topic or server */
  ntfyToken?: string;
  /** POSTed JSON: { title, message, url, project, set, newQuestions, blocking, replies } */
  webhook?: string;
  /** send once no more changes came for this long (default 20) */
  quietSeconds?: number;
  /** the start of links in notifications, e.g. http://100.100.4.74:4195 (default: Tailscale, else the LAN address) */
  link?: string;
  /** put the token in links (they pass through the push service; off by default) */
  includeToken?: boolean;
  /** also notify when the agent replies on a thread (default true) */
  replies?: boolean;
}

export interface Notice {
  title: string;
  message: string;
  url: string;
  project: string;
  set: string;
  newQuestions: number;
  blocking: number;
  replies: number;
}

interface Seen {
  questions: Set<string>;
  agentMessages: number;
}

interface Pending {
  newQuestions: Set<string>;
  replies: number;
  first: number;
  timer?: NodeJS.Timeout;
}

export const notifyConfig = (cfg: UserConfig = userConfig()): NotifyConfig => (cfg.notify && typeof cfg.notify === 'object' ? cfg.notify : {});
export const notifyEnabled = (n: NotifyConfig) => !!(n.ntfy || n.webhook);

export class Notifier {
  private seen = new Map<string, Seen>();
  private pending = new Map<string, Pending>();
  private readonly started = Date.now();

  constructor(
    private readonly project: (key: string) => Project | undefined,
    private readonly port: () => number,
    private readonly token: string,
    private readonly base: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  private state(p: Project, set: string): Seen | undefined {
    const l = p.load(set);
    if (!l) return undefined;
    const af = p.answers(set);
    let agentMessages = 0;
    for (const list of Object.values(af.threads)) for (const m of list) if (m.from === 'agent') agentMessages++;
    return { questions: new Set(allQuestions(l.set).map((q) => q.id)), agentMessages };
  }

  /** What's there now counts as seen (on start). */
  baseline(key: string, set: string): void {
    const p = this.project(key);
    const s = p && this.state(p, set);
    if (s) this.seen.set(key + '/' + set, s);
  }

  /** Something changed in a set: queue what's new. */
  observe(key: string, set: string): void {
    const id = key + '/' + set;
    const p = this.project(key);
    if (!p) return;
    const now = this.state(p, set);
    if (!now) return;
    let was = this.seen.get(id);
    if (!was) {
      // a set the hub hasn't seen: new if it was made since the hub started, else take it as it is
      const created = Date.parse(p.load(set)?.set.created ?? '') || 0;
      was = created >= this.started - 5000 ? { questions: new Set(), agentMessages: 0 } : now;
    }
    const fresh = [...now.questions].filter((q) => !was.questions.has(q));
    const replies = Math.max(0, now.agentMessages - was.agentMessages);
    this.seen.set(id, now);
    if (!fresh.length && !replies) return;
    const cfg = notifyConfig();
    if (!notifyEnabled(cfg)) return;
    const pend = this.pending.get(id) ?? { newQuestions: new Set<string>(), replies: 0, first: Date.now() };
    for (const q of fresh) pend.newQuestions.add(q);
    pend.replies += cfg.replies === false ? 0 : replies;
    if (!pend.newQuestions.size && !pend.replies) return;
    this.pending.set(id, pend);
    clearTimeout(pend.timer);
    const quiet = Math.max(1, cfg.quietSeconds ?? 20) * 1000;
    // wait for a pause, but never more than two minutes after the first change
    const wait = Math.min(quiet, Math.max(0, pend.first + 120_000 - Date.now()));
    pend.timer = setTimeout(() => void this.flush(key, set), wait);
    pend.timer.unref?.();
  }

  private async flush(key: string, set: string): Promise<void> {
    const id = key + '/' + set;
    const pend = this.pending.get(id);
    this.pending.delete(id);
    const p = this.project(key);
    const l = p?.load(set);
    if (!pend || !p || !l) return;
    const af = p.answers(set);
    const vis = visibility(l.set, af.answers);
    const fresh = allQuestions(l.set).filter((q) => pend.newQuestions.has(q.id) && vis.question(q.id));
    const blocking = fresh.filter((q) => q.priority === 'blocking' && !isDone(af.answers[q.id])).length;
    if (!fresh.length && !pend.replies) return;
    const parts: string[] = [];
    if (fresh.length) parts.push(`${fresh.length} new question${fresh.length === 1 ? '' : 's'}`);
    if (pend.replies) parts.push(`${pend.replies} repl${pend.replies === 1 ? 'y' : 'ies'} from the agent`);
    const first = fresh[0];
    const notice: Notice = {
      title: `${l.set.title}: ${parts.join(', ')}`,
      message: [
        blocking ? `${blocking} blocking: the agent is waiting on ${blocking === 1 ? 'it' : 'them'}.` : '',
        first ? `“${first.question.replace(/\s+/g, ' ').slice(0, 120)}”${fresh.length > 1 ? ` and ${fresh.length - 1} more` : ''}` : 'Tap to read.',
        `${key} · ${set}`,
      ]
        .filter(Boolean)
        .join('\n'),
      url: this.link(key, set),
      project: key,
      set,
      newQuestions: fresh.length,
      blocking,
      replies: pend.replies,
    };
    try {
      await send(notifyConfig(), notice);
      this.log(`notified: ${notice.title}`);
    } catch (e) {
      this.log(`couldn't notify: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  link(key: string, set: string): string {
    return linkBase(notifyConfig(), this.port(), this.token, this.base) + `#/p/${encodeURIComponent(key)}/s/${encodeURIComponent(set)}`;
  }
}

/** Where links in notifications point: the configured base, else Tailscale (works anywhere), else the LAN. */
export function linkBase(cfg: NotifyConfig, port: number, token: string, hubBase = '/'): string {
  let base = cfg.link?.replace(/\/+$/, '');
  if (!base) {
    const ips = lanAddresses();
    const ts = ips.find((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip));
    base = `http://${ts ?? ips[0] ?? os.hostname()}:${port}${hubBase.replace(/\/$/, '')}`;
  }
  return `${base}/${cfg.includeToken && token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Send one notice to every configured channel. */
export async function send(cfg: NotifyConfig, n: Notice): Promise<void> {
  const errors: string[] = [];
  if (cfg.ntfy) {
    try {
      const u = new URL(cfg.ntfy);
      const topic = u.pathname.replace(/^\/+|\/+$/g, '');
      if (!topic) throw new Error(`no topic in ${cfg.ntfy}`);
      const res = await fetch(u.origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.ntfyToken ? { authorization: `Bearer ${cfg.ntfyToken}` } : {}) },
        body: JSON.stringify({ topic, title: n.title, message: n.message, click: n.url, tags: [n.blocking ? 'warning' : 'question'], priority: n.blocking ? 4 : 3 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`ntfy: ${res.status} ${await res.text().catch(() => '')}`.trim());
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (cfg.webhook) {
    try {
      const res = await fetch(cfg.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(n), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`webhook: ${res.status}`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}
