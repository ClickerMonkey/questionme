// Makes a small demo project with a question set that uses every feature: node scripts/demo.mjs <folder>
// (the screenshots and the tests use it; try it with: node dist/cli.js --solo <folder> --local)
import fs from 'node:fs';
import path from 'node:path';

export function makeDemo(root) {
  const w = (p, t) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), t);
  };
  w(
    'src/forecast.ts',
    `// Fetches the forecast for a place and keeps it for ten minutes.
export interface Forecast {
  place: string;
  hours: { at: string; tempC: number; rainMm: number }[];
}

const cache = new Map<string, { at: number; forecast: Forecast }>();

export async function forecast(place: string): Promise<Forecast> {
  const hit = cache.get(place);
  if (hit && Date.now() - hit.at < 600_000) return hit.forecast;
  const res = await fetch(\`https://api.example.com/forecast?q=\${encodeURIComponent(place)}\`);
  if (!res.ok) throw new Error(\`forecast: \${res.status}\`);
  const data = (await res.json()) as Forecast;
  cache.set(place, { at: Date.now(), forecast: data });
  return data;
}
`,
  );
  w('docs/plan.md', '# Plan\n\n1. **Today** view: now, the next 12 hours, rain.\n2. **Week** view.\n3. Alerts.\n\n```mermaid\nflowchart LR\n  A[Open app] --> B{Location?}\n  B -->|yes| C[Today]\n  B -->|no| D[Pick a place]\n  D --> C\n```\n');
  w('docs/places.csv', 'place,lat,lon,people\nPittsburgh,40.44,-79.99,302971\nErie,42.13,-80.09,94831\nScranton,41.41,-75.66,76328\n');
  w(
    'art/sun.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="240" height="240"><rect width="120" height="120" rx="20" fill="#bfe3ff"/><circle cx="60" cy="60" r="24" fill="#ffc531"/><g stroke="#ffb000" stroke-width="6" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315]
      .map((a) => {
        const r = (a * Math.PI) / 180;
        return `<line x1="${60 + Math.cos(r) * 34}" y1="${60 + Math.sin(r) * 34}" x2="${60 + Math.cos(r) * 46}" y2="${60 + Math.sin(r) * 46}"/>`;
      })
      .join('')}</g></svg>`,
  );
  const mock = (bg, fg, title) =>
    `<div style="font:15px system-ui;background:${bg};color:${fg};padding:16px;height:100%;box-sizing:border-box"><div style="font-size:13px;opacity:.7">Pittsburgh</div><div style="font-size:56px;font-weight:700">18°</div><div>${title}</div><div style="display:flex;gap:10px;margin-top:14px">${['9a', '10a', '11a', '12p', '1p']
      .map((h, i) => `<div style="text-align:center"><div style="opacity:.7;font-size:12px">${h}</div><div>${17 + i}°</div></div>`)
      .join('')}</div></div>`;
  const set = {
    $schema: 'https://unpkg.com/questionme/schema/set.schema.json',
    title: 'Weather app: first plan',
    intro: 'I read `docs/plan.md` and `src/forecast.ts`. These are the choices that shape the first version. **Blocking** ones stop me; the rest I can work around.',
    content: [{ file: 'docs/plan.md', collapsed: true, title: 'The plan as it stands' }],
    sections: [
      {
        id: 'basics',
        title: 'The basics',
        intro: 'Where it runs and who it is for.',
        questions: [
          {
            id: 'platform',
            header: 'Platform',
            question: 'Where should the first version run?',
            why: 'Decides the toolkit, how location works, and whether alerts can be push notifications.',
            blocking: true,
            options: [
              { id: 'web', label: 'A web app that installs to the home screen', description: 'One codebase; push alerts work on Android and iOS 16.4+.', recommended: true },
              { id: 'native', label: 'Native iOS and Android apps', description: 'Best widgets and alerts; two stores to ship to.', shows: ['stores'] },
              { id: 'both', label: 'Web first, then native', description: 'Web now; native after the first month.', shows: ['stores'] },
            ],
          },
          {
            id: 'stores',
            question: 'Which store first?',
            hidden: true,
            options: [{ id: 'ios', label: 'App Store', recommended: true }, { id: 'android', label: 'Google Play' }],
          },
          { id: 'offline', type: 'yesno', question: 'Should the last forecast show when there is no connection?', recommended: 'yes' },
        ],
      },
      {
        id: 'look',
        title: 'The look',
        questions: [
          {
            id: 'theme',
            header: 'Look',
            question: 'Which direction for the Today screen?',
            options: [
              { id: 'sky', label: 'Sky', description: 'The background follows the sky outside.', recommended: true, content: { html: mock('linear-gradient(#5bb3ff,#bfe3ff)', '#06263f', 'Sunny, light wind'), height: 190 } },
              { id: 'paper', label: 'Paper', description: 'Calm and printed, like a newspaper weather box.', content: { html: mock('#f4efe4', '#222', 'Sunny, light wind'), height: 190 } },
              { id: 'night', label: 'Night', description: 'Dark, with bright numbers.', content: { html: mock('#0d1020', '#e8ecff', 'Clear, cool'), height: 190 } },
            ],
          },
          { id: 'icon', question: 'Is this sun right for the app icon?', type: 'yesno', content: [{ file: 'art/sun.svg' }] },
        ],
      },
      {
        id: 'data',
        title: 'Data',
        intro: 'The forecast comes from one provider today:',
        content: [{ file: 'src/forecast.ts', lines: '9-16' }],
        questions: [
          {
            id: 'features',
            type: 'multi',
            question: 'What goes in the first version?',
            options: [
              { id: 'hourly', label: 'Hourly forecast', recommended: true },
              { id: 'radar', label: 'Rain radar map', shows: ['radar-source'] },
              { id: 'alerts', label: 'Severe weather alerts', shows: ['alert-kinds'] },
              { id: 'pollen', label: 'Pollen and air quality' },
            ],
            recommended: ['hourly', 'alerts'],
          },
          {
            id: 'radar-source',
            question: 'Where should radar tiles come from?',
            hidden: true,
            options: ['RainViewer (free, attribution)', 'The forecast provider (paid tier)'],
          },
          {
            id: 'alert-kinds',
            question: 'Which alerts should buzz the phone?',
            type: 'multi',
            hidden: true,
            options: ['Warnings', 'Watches', 'Advisories'],
            recommended: ['Warnings'],
          },
          {
            id: 'cache',
            question: 'Keep forecasts for longer, as below?',
            why: 'Fewer calls to the provider (it bills per call).',
            content: [
              {
                title: 'Proposed: src/forecast.ts',
                diff: `--- a/src/forecast.ts\n+++ b/src/forecast.ts\n@@ -6,9 +6,11 @@\n-const cache = new Map<string, { at: number; forecast: Forecast }>();\n+const cache = new Map<string, { at: number; forecast: Forecast }>();\n+/** how long a forecast stays fresh */\n+const FRESH_MS = 30 * 60_000;\n \n export async function forecast(place: string): Promise<Forecast> {\n   const hit = cache.get(place);\n-  if (hit && Date.now() - hit.at < 600_000) return hit.forecast;\n+  if (hit && Date.now() - hit.at < FRESH_MS) return hit.forecast;`,
              },
            ],
            type: 'yesno',
            recommended: 'yes',
          },
          { id: 'places', question: 'Which places should be in the starter list?', content: [{ file: 'docs/places.csv' }], placeholder: 'One per line', type: 'text' },
        ],
      },
      {
        id: 'numbers',
        title: 'Numbers',
        questions: [
          { id: 'refresh', type: 'number', question: 'Refresh the forecast every how many minutes?', min: 5, max: 120, step: 5, unit: 'minutes', recommended: 30 },
          { id: 'care', type: 'scale', question: 'How much does battery life matter, compared with fresh data?', min: 1, max: 5, minLabel: 'Fresh data', maxLabel: 'Battery', recommended: 4 },
          { id: 'order', type: 'rank', question: 'Put these in the order to build them.', options: ['Today view', 'Week view', 'Alerts', 'Widgets'] },
          {
            id: 'flow',
            question: 'Does this first-run flow look right?',
            type: 'yesno',
            content: { mermaid: 'flowchart LR\n  A[Open] --> B{Allow location?}\n  B -->|yes| C[Today]\n  B -->|no| D[Search a place]\n  D --> C' },
          },
          { id: 'anything', type: 'text', question: 'Anything else I should know before I start?', priority: 'low' },
        ],
      },
    ],
  };
  w('.questionme/sets/weather-plan.json', JSON.stringify(set, null, 2) + '\n');
  return root;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('demo.mjs')) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/demo.mjs <folder>');
    process.exit(1);
  }
  makeDemo(path.resolve(dir));
  console.log(`demo project in ${path.resolve(dir)}`);
}
