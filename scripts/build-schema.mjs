// Writes schema/set.schema.json from src/schema.ts (via dist/), so the published schema matches the code.
import fs from 'node:fs';
import path from 'node:path';
import { setSchema } from '../dist/schema.js';

const out = path.resolve(import.meta.dirname, '..', 'schema', 'set.schema.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(setSchema, null, 2) + '\n');
console.log('schema: ' + path.relative(process.cwd(), out));
