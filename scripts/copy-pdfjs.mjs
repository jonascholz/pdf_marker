// Copies the pdf.js files the viewer needs into app/src/main/assets/pdfjs.
// Legacy build: runs on older Android System WebViews too.
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const src = 'node_modules/pdfjs-dist';
const out = 'app/src/main/assets/pdfjs';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) cpSync(`${src}/legacy/build/${f}`, `${out}/${f}`);
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(`${src}/${d}`, `${out}/${d}`, { recursive: true });
cpSync(`${src}/LICENSE`, `${out}/LICENSE`);
console.log(`pdf.js copied to ${out}`);
