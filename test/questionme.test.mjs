// Runs against the built dist/ (npm test builds first).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { normalise, visibility, summarise, isStale, checkAnswer, answerText } from '../dist/model.js';
import { Project } from '../dist/store.js';
import { readAnswers, waitFor, describeSet } from '../dist/agent.js';
import { start } from '../dist/server.js';
import { makeDemo } from '../scripts/demo.mjs';

const cli = path.resolve('dist/cli.js');
let tmp, demo, home;
const env = () => ({ ...process.env, QUESTIONME_HOME: home, QUESTIONME_PORT: '0' });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'questionme-')));
  home = path.join(tmp, 'home');
  demo = makeDemo(path.join(tmp, 'demo'));
  fs.writeFileSync(path.join(demo, '.env'), 'SECRET=1\n');
});
after(() => {
  try {
    execFileSync(process.execPath, [cli, 'stop'], { env: env(), stdio: 'pipe' });
  } catch {
    // not running
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const load = () => new Project(demo).load('weather-plan');

test('the demo set is valid and shows its default questions', () => {
  const l = load();
  assert.deepEqual(l.errors, []);
  assert.deepEqual(l.warnings, []);
  const vis = visibility(l.set, {});
  assert.equal(vis.question('platform'), true);
  assert.equal(vis.question('stores'), false);
  assert.equal(vis.question('radar-source'), false);
  const q = l.set.sections[0].questions[2];
  assert.equal(q.type, 'yesno');
  assert.deepEqual(q.options.map((o) => o.id), ['yes', 'no']);
  assert.deepEqual(q.recommended, ['yes']);
  // labels given as recommendations become option ids
  const kinds = l.set.sections[2].questions.find((x) => x.id === 'alert-kinds');
  assert.deepEqual(kinds.recommended, ['warnings']);
});

test('picks show and hide questions; hidden branches fold away; "you decide" counts as the recommendation', () => {
  const set = normalise('t', {
    questions: [
      { id: 'a', question: 'A?', options: [{ id: 'x', label: 'X', shows: ['b', 'sec'] }, { id: 'y', label: 'Y', hides: ['c'] }], recommended: 'x' },
      { id: 'b', question: 'B?', hidden: true, options: [{ id: 'deep', label: 'Deep', shows: ['d'] }, 'Shallow'] },
      { id: 'c', question: 'C?' },
      { id: 'd', question: 'D?', hidden: true },
      { id: 'e', question: 'E?', showIf: { question: 'a', any: ['y'] } },
      { id: 'n', question: 'N?', type: 'number' },
      { id: 'f', question: 'F?', showIf: { question: 'n', gte: 10 } },
    ],
    sections: [{ id: 'sec', title: 'Sec', hidden: true, questions: [{ id: 's1', question: 'S1?' }] }],
  });
  assert.deepEqual(set.errors, []);
  const ans = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { rev: '', at: '', seq: 1, ...v }]));
  let v = visibility(set.set, {});
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 's1'].map(v.question), [true, false, true, false, false, false]);
  v = visibility(set.set, ans({ a: { status: 'answered', picked: ['x'] }, b: { status: 'answered', picked: ['deep'] } }));
  assert.deepEqual(['b', 'd', 's1', 'e'].map(v.question), [true, true, true, false]);
  // b's pick no longer counts once b is hidden again
  v = visibility(set.set, ans({ a: { status: 'answered', picked: ['y'] }, b: { status: 'answered', picked: ['deep'] } }));
  assert.deepEqual(['b', 'd', 'c', 'e'].map(v.question), [false, false, false, true]);
  v = visibility(set.set, ans({ a: { status: 'delegated' } }));
  assert.equal(v.question('b'), true);
  v = visibility(set.set, ans({ n: { status: 'answered', number: 12 } }));
  assert.equal(v.question('f'), true);
});

test('loops of shows/hides do not hang', () => {
  const n = normalise('t', {
    questions: [
      { id: 'a', question: 'A', hidden: true, options: [{ label: 'go', shows: ['b'] }] },
      { id: 'b', question: 'B', hidden: true, options: [{ label: 'go', shows: ['a'] }] },
    ],
  });
  const v = visibility(n.set, { a: { status: 'answered', picked: ['go'], rev: '', at: '', seq: 1 }, b: { status: 'answered', picked: ['go'], rev: '', at: '', seq: 2 } });
  assert.equal(v.question('a'), false);
});

test('bad sets explain themselves', () => {
  const n = normalise('t', {
    sections: [
      {
        id: 'a',
        questions: [
          { id: 'q1', question: 'One', options: [{ label: 'X', shows: ['nope'] }] },
          { id: 'q1', question: 'Dup' },
          { id: 'q3', question: 'Typed', type: 'dropdown' },
          { id: 'q4', question: 'Rec', options: ['A'], recommended: 'B' },
          { id: 'q5', question: 'Cond', showIf: { question: 'q1', any: ['zzz'] } },
          { id: 'q6', question: 'File', content: { file: '../outside.txt' } },
        ],
      },
    ],
  });
  const all = n.errors.join('\n');
  for (const s of ['"nope"', 'used twice', 'unknown type "dropdown"', 'recommended "B"', '"zzz"', 'inside the project folder']) assert.ok(all.includes(s), `expected an error about ${s}:\n${all}`);
});

test('answers are checked against their question', () => {
  const l = load();
  const q = (id) => l.set.sections.flatMap((s) => s.questions).find((x) => x.id === id);
  assert.equal(checkAnswer(q('platform'), { picked: ['web', 'native'] }).ok, false);
  assert.equal(checkAnswer(q('platform'), { picked: ['nope'] }).ok, false);
  assert.equal(checkAnswer(q('platform'), { picked: ['web'] }).ok, true);
  assert.equal(checkAnswer(q('refresh'), { number: 500 }).ok, false);
  assert.equal(checkAnswer(q('order'), { order: ['today-view'] }).ok, false);
  assert.equal(checkAnswer(q('order'), { order: ['widgets', 'alerts', 'week-view', 'today-view'] }).ok, true);
  assert.equal(checkAnswer(q('platform'), { status: 'later' }).ok, true);
});

test('the store saves, reads new answers once, flags changed questions and keeps acks only while the answer holds', () => {
  const p = new Project(demo);
  p.answer('weather-plan', 'platform', { picked: ['native'], note: 'iOS first' });
  p.answer('weather-plan', 'offline', { picked: ['yes'] });
  const r1 = readAnswers(p, 'weather-plan', { filter: 'new' });
  assert.match(r1.text, /platform \(Where should the first version run\?\): Native iOS and Android apps — note: "iOS first"/);
  assert.match(r1.text, /offline .*: Yes/);
  assert.match(readAnswers(p, 'weather-plan', { filter: 'new' }).text, /Nothing new/);
  // the agent applies one
  p.ack('weather-plan', ['platform'], 'Planned native apps');
  assert.equal(p.answers('weather-plan').answers.platform.ack.note, 'Planned native apps');
  // the same answer again keeps the ack; a different one drops it
  p.answer('weather-plan', 'platform', { picked: ['native'], note: 'iOS first' });
  assert.ok(p.answers('weather-plan').answers.platform.ack);
  p.answer('weather-plan', 'platform', { picked: ['both'], note: 'iOS first' });
  assert.equal(p.answers('weather-plan').answers.platform.ack, undefined);
  // the agent rewords a question: the answer is flagged
  p.updateQuestion('weather-plan', 'offline', { question: 'Show the last forecast when offline?' });
  const l = load();
  const q = l.set.sections[0].questions.find((x) => x.id === 'offline');
  assert.ok(isStale(q, p.answers('weather-plan').answers.offline));
  assert.match(readAnswers(p, 'weather-plan', { filter: 'changed' }).text, /offline.*question changed since/);
  // readable copy
  const md = fs.readFileSync(p.markdownPath('weather-plan'), 'utf8');
  assert.match(md, /### platform: Where should the first version run\?/);
  assert.match(md, /> iOS first/);
});

test('adding questions: sections are made, ids are made, duplicates are refused, removed answers stay', () => {
  const p = new Project(demo);
  const { ids } = p.addQuestions('extra', [{ question: 'What colour?', options: ['Red', 'Blue'] }, { id: 'size', question: 'How big?', type: 'number' }], { id: 'look', title: 'Look' }, { title: 'Extra questions' });
  assert.deepEqual(ids, ['what-colour', 'size']);
  assert.throws(() => p.addQuestions('extra', [{ id: 'size', question: 'Again?' }]), /already in the set/);
  assert.throws(() => p.addQuestions('extra', [{ id: 'bad', question: 'Bad', type: 'nope' }]), /invalid/);
  const l = p.load('extra');
  assert.equal(l.set.title, 'Extra questions');
  assert.equal(l.set.sections[0].title, 'Look');
  p.answer('extra', 'size', { number: 3 });
  p.removeQuestions('extra', ['size']);
  assert.match(readAnswers(p, 'extra', { filter: 'all' }).text, /size: 3 \[question removed\]/);
  assert.match(describeSet(p, 'extra'), /what-colour \[single; open\]/);
});

test('accepting recommendations, messages and read marks', () => {
  const p = new Project(demo);
  const taken = p.acceptRecommended('weather-plan', ['refresh', 'care', 'order', 'anything']);
  assert.deepEqual(taken, ['refresh', 'care']); // order and anything have no recommendation
  assert.equal(p.answers('weather-plan').answers.refresh.number, 30);
  p.message('weather-plan', 'care', 'owner', 'Why does this matter?');
  const r = readAnswers(p, 'weather-plan', { filter: 'new' });
  assert.match(r.text, /owner says: "Why does this matter\?"/);
  p.message('weather-plan', 'care', 'agent', 'Fewer refreshes save battery.');
  const s = summarise(load().set, p.answers('weather-plan'));
  assert.equal(s.unreadMessages, 0);
});

test('two processes answering at once lose nothing', async () => {
  const root = path.join(tmp, 'race');
  const p = new Project(root);
  p.addQuestions('many', Array.from({ length: 40 }, (_, i) => ({ id: 'q' + i, question: 'Q' + i, type: 'number' })));
  const script = (from) => `import { Project } from ${JSON.stringify(new URL('../dist/store.js', import.meta.url).href)};
const p = new Project(${JSON.stringify(root)});
for (let i = ${from}; i < ${from + 20}; i++) p.answer('many', 'q' + i, { number: i });`;
  const run = (from) =>
    new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script(from)], { stdio: 'inherit' });
      c.on('exit', (code) => (code === 0 ? res() : rej(new Error('exit ' + code))));
    });
  await Promise.all([run(0), run(20)]);
  const af = p.answers('many');
  assert.equal(Object.keys(af.answers).length, 40);
  assert.equal(af.seq, 40);
});

test('waiting ends when the owner answers (after a pause)', async () => {
  const p = new Project(demo);
  p.markRead('weather-plan');
  setTimeout(() => p.answer('weather-plan', 'theme', { picked: ['sky'] }), 150);
  setTimeout(() => p.answer('weather-plan', 'icon', { picked: ['yes'] }), 350);
  const t0 = Date.now();
  const ok = await waitFor(p, 'weather-plan', { until: 'any', settleMs: 400, pollMs: 50, timeoutMs: 5000 });
  assert.equal(ok, true);
  assert.ok(Date.now() - t0 >= 700, 'waited for the pause');
  assert.match(readAnswers(p, 'weather-plan', { filter: 'new' }).text, /theme.*Sky[\s\S]*icon.*Yes/);
  assert.equal(await waitFor(p, 'weather-plan', { until: 'any', pollMs: 20, timeoutMs: 150 }), false);
  assert.equal(await waitFor(p, 'weather-plan', { until: 'ids', ids: ['theme'], pollMs: 20, timeoutMs: 150 }), true);
});

// ── the server ──

function request(port, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('the server: token, answers, files, secrets, cross-origin writes, live events', async () => {
  const running = await start({ mode: 'solo', projects: () => [{ key: 'demo', root: demo }], port: 0, host: '127.0.0.1', token: 'sekret' });
  const port = running.port;
  const auth = { authorization: 'Bearer sekret' };
  try {
    assert.equal((await request(port, '/api/ping')).json().app, 'questionme');
    assert.equal((await request(port, '/api/info')).status, 401);
    const info = (await request(port, '/api/info', { headers: auth })).json();
    assert.equal(info.projects[0].key, 'demo');
    assert.ok(info.projects[0].sets.some((s) => s.id === 'weather-plan'));
    const login = await request(port, '/?token=sekret');
    assert.equal(login.status, 302);
    assert.match(String(login.headers['set-cookie']), /questionme_token=sekret/);

    const set = (await request(port, '/api/p/demo/s/weather-plan', { headers: auth })).json();
    assert.equal(set.set.id, 'weather-plan');
    const saved = await request(port, '/api/p/demo/s/weather-plan/answer', { method: 'POST', headers: auth, body: { id: 'care', number: 2 } });
    assert.equal(saved.json().answer.number, 2);
    const bad = await request(port, '/api/p/demo/s/weather-plan/answer', { method: 'POST', headers: auth, body: { id: 'care', number: 99 } });
    assert.equal(bad.status, 400);
    const cross = await request(port, '/api/p/demo/s/weather-plan/answer', { method: 'POST', headers: { ...auth, origin: 'http://evil.example' }, body: { id: 'care', number: 3 } });
    assert.equal(cross.status, 403);

    const text = (await request(port, '/api/p/demo/text?path=src/forecast.ts&lines=9-10', { headers: auth })).json();
    assert.match(text.text, /^export async function forecast/);
    assert.equal(text.first, 9);
    assert.equal((await request(port, '/raw/demo/art/sun.svg', { headers: auth })).status, 200);
    assert.equal((await request(port, '/raw/demo/.env', { headers: auth })).status, 404);
    assert.equal((await request(port, '/raw/demo/..%2F..%2Fetc%2Fpasswd', { headers: auth })).status, 404);
    assert.equal((await request(port, '/api/p/demo/text?path=.env', { headers: auth })).status, 404);
    assert.equal((await request(port, '/api/info', { headers: { ...auth, host: 'evil.example' } })).status, 403);

    // live: a change on disk reaches the page
    const got = new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: auth }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes('event: change')) {
            req.destroy();
            resolve(buf);
          }
        });
      });
    });
    await new Promise((r) => setTimeout(r, 300));
    new Project(demo).answer('weather-plan', 'anything', { text: 'Make it fast' });
    const ev = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no live event')), 5000))]);
    assert.match(ev, /"set":"weather-plan"/);
  } finally {
    await running.close();
  }
});

// ── the CLI and the MCP server ──

const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: demo, env: env(), encoding: 'utf8' });

test('the CLI: list, answers, validate, hook, schema', () => {
  assert.match(run('list'), /weather-plan \("Weather app: first plan"\)/);
  new Project(demo).answer('weather-plan', 'places', { text: 'Pittsburgh\nErie' });
  assert.match(run('hook'), /questionme: weather-plan .*new answer/);
  assert.match(run('answers', 'weather-plan', '--new'), /places .*: Pittsburgh\nErie/);
  assert.equal(run('hook'), '');
  assert.match(run('answers', 'weather-plan', '--open', '--questions', 'none'), /- order/);
  assert.match(run('validate'), /✓ weather-plan/);
  fs.writeFileSync(path.join(demo, '.questionme/sets/broken.json'), '{"questions":[{"id":"x"}]}');
  assert.throws(() => run('validate', 'broken'), (e) => /question" is missing/.test(e.stdout));
  fs.rmSync(path.join(demo, '.questionme/sets/broken.json'));
  assert.equal(JSON.parse(run('schema')).title, 'questionme question set');
});

test('the MCP server: initialize, tools, add questions, read answers', async () => {
  const child = spawn(process.execPath, [cli, 'mcp'], { cwd: demo, env: env(), stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    return r.result;
  };
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'questionme');
    assert.match(init.result.instructions, /add_questions/);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const t of ['list_sets', 'add_questions', 'get_answers', 'wait_for_answers', 'ack_answers', 'reply', 'get_link', 'show_set', 'update_question']) assert.ok(names.includes(t), t);

    const added = await tool('add_questions', { set: 'mcp', title: 'From MCP', section: { id: 'one', title: 'One' }, questions: [{ id: 'colour', question: 'Colour?', options: [{ label: 'Red', recommended: true }, 'Blue'] }] });
    assert.ok(!added.isError, added.content[0].text);
    assert.match(added.content[0].text, /Added 1 question to "mcp": colour/);
    assert.match(added.content[0].text, /http:\/\/localhost:\d+\/.*#\/p\/demo\/s\/mcp/);
    const bad = await tool('add_questions', { set: 'mcp', questions: [{ id: 'colour', question: 'Again' }] });
    assert.equal(bad.isError, true);

    new Project(demo).answer('mcp', 'colour', { picked: ['blue'], note: 'Navy, really' });
    const ans = await tool('get_answers', { set: 'mcp' });
    assert.match(ans.content[0].text, /colour \(Colour\?\): Blue — note: "Navy, really"/);
    assert.match((await tool('get_answers', { set: 'mcp' })).content[0].text, /Nothing new/);
    assert.match((await tool('ack_answers', { set: 'mcp', ids: ['colour'], note: 'Painted it navy' })).content[0].text, /Marked 1/);
    assert.match((await tool('list_sets', {})).content[0].text, /mcp \("From MCP"\): 1 of 1 answered/);
    const waited = await tool('wait_for_answers', { set: 'mcp', until: 'all', timeout_seconds: 2 });
    assert.match(waited.content[0].text, /Done waiting/);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
  }
});

test('notifications: an agent adding questions and replying makes one batched webhook call', async () => {
  const got = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push(JSON.parse(b));
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const nhome = path.join(tmp, 'nhome');
  fs.mkdirSync(nhome, { recursive: true });
  fs.writeFileSync(path.join(nhome, 'config.json'), JSON.stringify({ notify: { webhook: `http://127.0.0.1:${hook.address().port}/`, quietSeconds: 1, link: 'http://phone.test:4195' } }));
  const root = path.join(tmp, 'notify');
  const p = new Project(root);
  p.addQuestions('plan', [{ id: 'old', question: 'Already here?' }]);
  const child = spawn(process.execPath, [cli, '--solo', root, '--local', '--port', '0'], { env: { ...process.env, QUESTIONME_HOME: nhome }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => child.stdout.once('data', r));
    await new Promise((r) => setTimeout(r, 400));
    p.addQuestions('plan', [{ id: 'a', question: 'First new one?', blocking: true }]);
    await new Promise((r) => setTimeout(r, 300));
    p.addQuestions('plan', [{ id: 'b', question: 'Second new one?' }]);
    p.message('plan', 'old', 'agent', 'A reply.');
    const until = Date.now() + 8000;
    while (!got.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.equal(got[0].newQuestions, 2);
    assert.equal(got[0].blocking, 1);
    assert.equal(got[0].replies, 1);
    assert.match(got[0].title, /plan: 2 new questions, 1 reply from the agent/);
    assert.equal(got[0].url, 'http://phone.test:4195/#/p/notify/s/plan');
    assert.match(got[0].message, /“First new one\?” and 1 more/);
  } finally {
    child.kill();
    hook.close();
  }
});

test('a nested base path: the page, assets, chunks, files, answers and live events live under it; links carry it', async () => {
  const { normaliseBase, links } = await import('../dist/registry.js');
  for (const b of ['test/path', '/test/path', '/test/path/', 'test//path/', 'https://example.com/test/path']) assert.equal(normaliseBase(b), '/test/path/');
  assert.equal(normaliseBase('/'), '/');
  assert.throws(() => normaliseBase('C:/Program Files/Git/test/path'), /Git Bash/);
  assert.throws(() => normaliseBase('a/../b'), /\.\./);
  assert.match(links(4195, '127.0.0.1', 't', '#/p/x', '/test/path/')[0], /^http:\/\/localhost:4195\/test\/path\/\?token=t#\/p\/x$/);

  const running = await start({ mode: 'solo', projects: () => [{ key: 'demo', root: demo }], port: 0, host: '127.0.0.1', base: '/test/path/', token: 'tok' });
  const at = `http://127.0.0.1:${running.port}`;
  const auth = { authorization: 'Bearer tok' };
  try {
    assert.equal((await request(running.port, '/api/info', { headers: auth })).status, 404, 'nothing outside the base');
    const bare = await request(running.port, '/test/path');
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, '/test/path/');
    assert.equal((await request(running.port, '/test/path/api/ping')).json().base, '/test/path/');
    const login = await request(running.port, '/test/path/?token=tok');
    assert.equal(login.headers.location, '/test/path/');
    assert.match(String(login.headers['set-cookie']), /Path=\/test\/path\//);
    const html = (await request(running.port, '/test/path/', { headers: auth })).body;
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) if (!/^(data:|https?:)/.test(m[1])) assert.ok(!m[1].startsWith('/'), `${m[1]} is relative`);
    const main = (await request(running.port, '/test/path/assets/main.js', { headers: auth })).body;
    const chunk = /["'](\.\/chunks\/[^"']+\.js)["']/.exec(main)?.[1];
    assert.ok(chunk, 'main.js loads its chunks by relative path');
    assert.equal((await request(running.port, '/test/path/assets/' + chunk.slice(2), { headers: auth })).status, 200);
    assert.equal((await request(running.port, '/test/path/api/p/demo/s/weather-plan', { headers: auth })).status, 200);
    assert.equal((await request(running.port, '/test/path/raw/demo/art/sun.svg', { headers: auth })).status, 200);
    assert.equal((await request(running.port, '/test/path/api/p/demo/text?path=src/forecast.ts&lines=1-2', { headers: auth })).status, 200);
    const saved = await request(running.port, '/test/path/api/p/demo/s/weather-plan/answer', { method: 'POST', headers: auth, body: { id: 'care', number: 5 } });
    assert.equal(saved.json().answer.number, 5);
    const ev = await fetch(at + '/test/path/api/events', { headers: auth });
    assert.equal(ev.headers.get('content-type'), 'text/event-stream');
    await ev.body.cancel();
  } finally {
    await running.close();
  }
});

test('the CLI refuses an option it does not know, and points at --help', () => {
  assert.throws(() => run('list', '--jsn'), (e) => /unknown option --jsn \(questionme --help/.test(e.stderr));
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /--base <path>/);
});
