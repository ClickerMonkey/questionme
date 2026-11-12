// The README's screenshots: the demo project at phone size, light and dark. npm run screenshots (after npm run build)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeDemo } from './demo.mjs';
import { start } from '../dist/server.js';
import { Project } from '../dist/store.js';

const outDir = path.resolve(import.meta.dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'questionme-shots-')));
const root = makeDemo(path.join(tmp, 'weather-app'));
const p = new Project(root);
p.answer('weather-plan', 'offline', { picked: ['yes'] });
p.ack('weather-plan', ['offline'], 'Kept the last 24 hours offline (src/forecast.ts)');
p.message('weather-plan', 'cache', 'owner', 'What does the provider charge per call?');
p.message('weather-plan', 'cache', 'agent', 'About **$0.0004** a call: 30 minutes instead of 10 saves roughly two-thirds.');

const running = await start({ mode: 'solo', projects: () => [{ key: 'weather-app', root }], port: 0, host: '127.0.0.1' });
const base = `http://localhost:${running.port}/`;
const browser = await chromium.launch();
const shot = async (name, fn, { dark = false, full = false } = {}) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await fn(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, name + '.png'), fullPage: full });
  await page.close();
  console.log('shot', name);
};
const set = (q = '') => base + '#/p/weather-app/s/weather-plan' + (q ? '/q/' + q : '');
const to = async (page, id) => {
  await page.locator('#q-' + id).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 200));
};

try {
  await shot('home', (page) => page.goto(base));
  await shot('set', (page) => page.goto(set()));
  await shot('mockups', async (page) => {
    await page.goto(set());
    await page.waitForTimeout(600);
    await to(page, 'theme');
  });
  await shot('follow-up', async (page) => {
    await page.goto(set());
    await page.waitForTimeout(600);
    await page.click('#q-features .opt[data-o="hourly"]');
    await page.click('#q-features .opt[data-o="alerts"]');
    await page.waitForTimeout(500);
    await to(page, 'features');
  });
  await shot('diff', async (page) => {
    await page.goto(set());
    await page.waitForTimeout(600);
    await to(page, 'cache');
    await page.click('#q-cache [data-act="thread"]');
  }, { dark: true });
  await shot('cards', async (page) => {
    await page.goto(set('care'));
    await page.waitForTimeout(400);
    await page.click('[data-mode="cards"]');
  });
  await shot('applied', async (page) => {
    await page.goto(set());
    await page.waitForTimeout(400);
    await page.click('[data-filter="all"]');
    await to(page, 'offline');
  }, { dark: true });
  await shot('rank', async (page) => {
    await page.goto(set());
    await page.waitForTimeout(600);
    await to(page, 'refresh');
  });
} finally {
  await browser.close();
  await running.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
