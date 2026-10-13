// Browser check of the viewer (app/src/main/assets) in headless mobile Chromium:
// renders a generated PDF, then double tap → mark mode, drag → marking saved, reload → marking shown,
// reading position, rotated page, triple-tap menu, reset, undo. Needs `npm run assets` first. Usage: node scripts/web-check.mjs [screenshotDir]
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const ROOT = 'app/src/main/assets';
const shots = process.argv[2] ?? join(tmpdir(), 'pdf-reader-check');
await mkdir(shots, { recursive: true });

// Test PDF: five A4 pages of text, the second one rotated 90°.
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let n = 0; n < 5; n++) {
  const page = doc.addPage([595, 842]);
  if (n === 1) page.setRotation(degrees(90));
  for (let l = 0; l < 30; l++) page.drawText(`Page ${n + 1} line ${l + 1}: the quick brown fox jumps over the lazy dog.`, { x: 60, y: 780 - l * 24, size: 14, font });
}
const pdfBytes = await doc.save();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/doc') return res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdfBytes);
  const file = join(ROOT, normalize(path).replace(/^([/\\])+/, ''));
  if (!existsSync(file)) {
    if (path !== '/favicon.ico') console.log('404', path);
    return res.writeHead(404).end();
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/index.html`;

// CHROMIUM=/path/to/chrome, else Playwright's own (npx playwright-core install chromium).
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !m.location().url.endsWith('/favicon.ico') && errors.push(m.text()));
page.on('dialog', (d) => d.accept());
const cdp = await context.newCDPSession(page);

const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tap(x, y) {
  await touch('touchStart', x, y);
  await sleep(40);
  await touch('touchEnd', x, y);
}
async function multiTap(n, x, y) {
  for (let k = 0; k < n; k++) {
    if (k) await sleep(80);
    await tap(x, y);
  }
  await sleep(450); // a double tap acts once no third tap came
}
const doubleTap = (x, y) => multiTap(2, x, y);
async function dragPath(x0, y0, x1, y1, steps = 8) {
  await touch('touchStart', x0, y0);
  for (let s = 1; s <= steps; s++) {
    await touch('touchMove', x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
    await sleep(16);
  }
  await touch('touchEnd', x1, y1);
  await sleep(50);
}
// Screen box of the text span containing `text` on page `n` (0-based).
const spanBox = (n, text) =>
  page.evaluate(([n, text]) => {
    const span = [...document.querySelectorAll('.page')[n].querySelectorAll('.textLayer span')].find((s) => s.textContent.includes(text));
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, [n, text]);
const stored = () => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('pdf:') && !k.endsWith(':pos')).map(([, v]) => JSON.parse(v)));
const markBoxes = (n) => page.evaluate((n) => [...document.querySelectorAll('.page')[n].querySelectorAll('.marks > div')].map((d) => {
  const r = d.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}), n);

let failed = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

await page.goto(url);
await page.waitForSelector('.page canvas');
await page.waitForFunction(() => document.querySelector('.page .textLayer span'));
await sleep(300);
await page.screenshot({ path: join(shots, '1-open.png') });

// Text layer sits on the drawn text: pdf-lib's x = 60pt at scale 390/595.
const line1 = await spanBox(0, 'line 1:');
check(line1 && near(line1.x, (60 * 390) / 595, 3), 'text layer aligned with the page', JSON.stringify(line1));

// Double tap on text toggles mark mode without marking anything.
await doubleTap(200, 400);
check(await page.isVisible('#mode'), 'double tap turns mark mode on');
const modeBox = await page.locator('#mode').boundingBox();
check(modeBox.y === 0 && modeBox.height === 3 && modeBox.width === 390, 'mark mode shows a 3px line along the top', JSON.stringify(modeBox));
await page.screenshot({ path: join(shots, '1b-mode-line.png'), clip: { x: 0, y: 0, width: 390, height: 40 } });
check((await stored()).length === 0, 'double tap marks nothing');

// Drag along line 1 from its start to the middle.
const scroll0 = await page.evaluate(() => scrollY);
const y1 = line1.y + line1.h / 2;
await dragPath(line1.x + 2, y1, line1.x + line1.w / 2, y1);
check((await page.evaluate(() => scrollY)) === scroll0, 'marking drag does not scroll');
let saved = await stored();
check(saved.length === 1 && saved[0].length === 1 && saved[0][0].p === 0, 'marking saved', JSON.stringify(saved));
let boxes = await markBoxes(0);
check(boxes.length === 1 && near(boxes[0].x, line1.x, 2) && near(boxes[0].w, line1.w / 2, 12) && near(boxes[0].y, line1.y, 3),
  'mark covers the dragged text', JSON.stringify({ boxes, line1 }));

// A drag over three lines gives one mark with a rect per line.
const l3 = await spanBox(0, 'line 3:');
const l5 = await spanBox(0, 'line 5:');
await dragPath(l3.x + 30, l3.y + l3.h / 2, l5.x + 60, l5.y + l5.h / 2, 12);
saved = await stored();
check(saved[0].length === 2 && saved[0][1].r.length === 3, 'multi-line mark has one rect per line', JSON.stringify(saved[0][1]));
await page.screenshot({ path: join(shots, '2-marked.png') });

// Mark mode off: drags scroll, nothing new is marked.
await doubleTap(200, 600);
check(!(await page.isVisible('#mode')), 'double tap turns mark mode off');
await dragPath(200, 600, 200, 300);
check((await stored())[0].length === 2, 'no marking outside mark mode');

// Reload: markings come back from storage.
await page.reload();
await page.waitForSelector('.page .marks > div');
check((await markBoxes(0)).length === 4, 'markings restored after reload');

// Reading position: scrolled into page 2 → reopened there.
await page.evaluate(() => { const r = document.querySelectorAll('.page')[1].getBoundingClientRect(); scrollTo(0, scrollY + r.top + 0.25 * r.height); });
await sleep(600);
await page.reload();
await page.waitForSelector('.page .marks > div');
await sleep(300);
const resumed = await page.evaluate(() => { const r = document.querySelectorAll('.page')[1].getBoundingClientRect(); return -r.top / r.height; });
check(Math.abs(resumed - 0.25) < 0.01, 'reopens at the last reading position', resumed.toFixed(3));

// Rotated page 2: its text layer and markings line up too.
await page.evaluate(() => document.querySelectorAll('.page')[1].scrollIntoView());
await page.waitForFunction(() => document.querySelectorAll('.page')[1].querySelector('.textLayer span'));
await sleep(300);
const r1 = await spanBox(1, 'line 1:');
check(r1 && r1.h > r1.w, 'rotated page text runs vertically', JSON.stringify(r1));
await doubleTap(200, 200);
// Rotated 90° clockwise: text reads top to bottom.
await dragPath(r1.x + r1.w / 2, r1.y + 2, r1.x + r1.w / 2, r1.y + r1.h / 3);
boxes = await markBoxes(1);
check(boxes.length === 1 && near(boxes[0].x, r1.x, 3) && near(boxes[0].w, r1.w, 3), 'mark on rotated page covers the text', JSON.stringify({ boxes, r1 }));
await page.screenshot({ path: join(shots, '3-rotated.png') });

// Triple tap opens the menu (and leaves mark mode as it was); tapping beside it closes it.
await doubleTap(200, 200);
check(!(await page.isVisible('#mode')), 'mark mode off again');
await multiTap(3, 200, 400);
check(await page.isVisible('#menu'), 'triple tap opens the menu');
check(!(await page.isVisible('#mode')), 'triple tap does not toggle mark mode');
await page.screenshot({ path: join(shots, '4-menu.png') });
await tap(20, 20);
await sleep(100);
check(!(await page.isVisible('#menu')), 'tap beside the menu closes it');

// Menu → Reset markings clears everything (dialog accepted).
await multiTap(3, 200, 400);
await page.click('#menu [data-action=reset]');
check(!(await page.isVisible('#menu')), 'menu closes after reset');
check((await stored()).every((m) => m.length === 0), 'reset clears saved markings');
check((await page.locator('.marks > div').count()) === 0, 'reset clears drawn markings');

// Undo reverts the reset, then the marking before it; the menu stays open and Undo greys out when nothing is left.
const markCount = async () => (await stored())[0].length;
await multiTap(3, 200, 400);
await page.click('#menu [data-action=undo]');
check((await markCount()) === 3 && (await page.locator('.marks > div').count()) === 5, 'undo restores the reset markings');
check(await page.isVisible('#menu'), 'menu stays open after undo');
await page.click('#menu [data-action=undo]');
check((await markCount()) === 2, 'second undo removes the last marking');
check(await page.isDisabled('#menu [data-action=undo]'), 'undo disabled when nothing is left');
await page.screenshot({ path: join(shots, '5-undo.png') });

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
server.close();
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
