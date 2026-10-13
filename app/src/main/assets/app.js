// PDF viewer: all pages stacked at full width, pdf.js canvas + text layer per page.
// Double tap toggles mark mode, triple tap opens the menu; in mark mode, dragging over text marks it like a highlighter.
// Markings are rects in fractions of the page box, saved per document (keyed by a hash of the PDF bytes).
import * as pdfjs from './pdfjs/pdf.min.mjs';

const lib = new URL('pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = lib + 'pdf.worker.min.mjs';

// The app provides the Android bridge (storage; the mark-mode line is a native view pinned to the screen's top edge).
// In a desktop browser (for testing) localStorage and #mode stand in.
const app = window.Android ?? {
  load: (k) => localStorage.getItem(k) ?? '[]',
  save: (k, v) => localStorage.setItem(k, v),
  setMarking: (on) => { document.getElementById('mode').hidden = !on; },
};

const $ = (id) => document.getElementById(id);
const pagesEl = $('pages');
const menuEl = $('menu');
const msgEl = $('msg');

const MAX_CANVAS_PIXELS = 10e6;
const pages = []; // { i, el, page, w, marksEl, canvas, task, want, tl, tlDiv, textReady, near }
let docKey = '';
let marks = []; // [{ p: page index, r: [[x, y, w, h], ...] }]
let marking = false;

// Called by the app with the camera cutout's safe insets (CSS px).
window.setInsets = (t, r, b, l) => {
  const s = document.documentElement.style;
  s.setProperty('--cut-top', `${t}px`);
  s.setProperty('--cut-right', `${r}px`);
  s.setProperty('--cut-bottom', `${b}px`);
  s.setProperty('--cut-left', `${l}px`);
};

// ---- Loading ----

async function main() {
  const src = new URLSearchParams(location.search).get('src') ?? '/doc';
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  docKey = 'pdf:' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  marks = parseMarks(app.load(docKey));
  const resumeAt = parsePosition(app.load(docKey + ':pos'));

  const task = pdfjs.getDocument({
    data, // transferred to the worker: hash first
    cMapUrl: lib + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: lib + 'standard_fonts/',
    wasmUrl: lib + 'wasm/',
    iccUrl: lib + 'iccs/',
    isEvalSupported: false, // hardening: a crafted PDF can't get code compiled through font rendering
  });
  task.onPassword = (update, reason) => {
    const pw = prompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'Wrong password, try again:' : 'Password:');
    if (pw === null) task.destroy();
    else update(pw);
  };
  const pdf = await task.promise;
  for (let n = 1; n <= pdf.numPages; n++) {
    addPage(await pdf.getPage(n));
    // Back to where reading stopped, re-applied while pages load until the spot is reachable (unless the user moved).
    if (resumeAt && !touched && pages.length > resumeAt.i) scrollToAnchor(resumeAt);
  }
  positionLoaded = true;
}

function parsePosition(json) {
  try {
    const v = JSON.parse(json);
    return Number.isInteger(v?.i) && v.i >= 0 && v.f >= 0 && v.f <= 1 ? v : null;
  } catch {
    return null;
  }
}

function parseMarks(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const undoStack = []; // earlier states of `marks`, for undo (this session only)

function setMarks(next) {
  undoStack.push(marks);
  marks = next;
  app.save(docKey, JSON.stringify(marks));
  pages.forEach((p) => drawMarks(p));
}

// ---- Pages ----

const nearObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const p = pages[e.target.dataset.i];
      p.near = e.isIntersecting;
      if (p.near) showPage(p);
      else hidePage(p);
    }
  },
  { rootMargin: '150% 0px' },
);

function addPage(page) {
  const vp = page.getViewport({ scale: 1 });
  const el = document.createElement('div');
  el.className = 'page';
  el.style.aspectRatio = `${vp.width} / ${vp.height}`;
  el.dataset.i = String(pages.length);
  const marksEl = document.createElement('div');
  marksEl.className = 'marks';
  el.append(marksEl);
  const p = { i: pages.length, el, page, w: vp.width, vertical: vp.rotation % 180 !== 0, marksEl, canvas: null, task: null, want: null, tl: null, tlDiv: null, textReady: false, near: false };
  pages.push(p);
  pagesEl.append(el);
  drawMarks(p);
  nearObserver.observe(el);
}

const cssScale = (p) => p.el.clientWidth / p.w;

function showPage(p) {
  renderCanvas(p);
  buildText(p);
}

function hidePage(p) {
  p.task?.cancel();
  p.task = null;
  p.want = null;
  p.canvas?.remove();
  p.canvas = null;
  p.tl?.cancel();
  p.tl = null;
  p.tlDiv?.remove();
  p.tlDiv = null;
  p.textReady = false;
}

// Device pixels per CSS px, raised while pinch-zoomed so text stays sharp; capped per page.
function outputScale(p) {
  const zoom = Math.min(Math.max(window.visualViewport?.scale ?? 1, 1), 4);
  let s = devicePixelRatio * zoom;
  const px = p.el.clientWidth * p.el.clientHeight * s * s;
  if (px > MAX_CANVAS_PIXELS) s *= Math.sqrt(MAX_CANVAS_PIXELS / px);
  return s;
}

async function renderCanvas(p) {
  const out = outputScale(p);
  const w = p.el.clientWidth;
  if (p.want && p.want.w === w && Math.abs(p.want.out - out) < 0.05) return;
  p.task?.cancel();
  p.want = { w, out };
  const viewport = p.page.getViewport({ scale: cssScale(p) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * out);
  canvas.height = Math.floor(viewport.height * out);
  const task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [out, 0, 0, out, 0, 0] });
  p.task = task;
  try {
    await task.promise;
  } catch (e) {
    if (!(e instanceof pdfjs.RenderingCancelledException)) console.error(e);
    return;
  }
  if (p.task !== task) return;
  p.task = null;
  p.canvas?.remove();
  p.canvas = canvas;
  p.el.prepend(canvas); // new canvas replaces the old one only when done: no blank flash
}

function buildText(p) {
  const scale = cssScale(p);
  p.el.style.setProperty('--total-scale-factor', String(scale));
  const viewport = p.page.getViewport({ scale });
  if (p.tl) {
    p.tl.update({ viewport });
    sizeText(p, viewport);
    return;
  }
  const div = document.createElement('div');
  div.className = 'textLayer';
  p.el.append(div);
  const tl = new pdfjs.TextLayer({ textContentSource: p.page.streamTextContent(), container: div, viewport });
  p.tl = tl;
  p.tlDiv = div;
  p.textReady = false;
  sizeText(p, viewport);
  tl.render().then(
    () => { if (p.tl === tl) p.textReady = true; },
    () => {},
  );
}

// The text layer is laid out in unrotated page space and turned by CSS ([data-main-rotation]).
// Plain px sizes instead of pdf.js's CSS round(), which older WebViews lack.
function sizeText(p, viewport) {
  const { pageWidth, pageHeight } = viewport.rawDims;
  p.tlDiv.style.width = `${pageWidth * viewport.scale}px`;
  p.tlDiv.style.height = `${pageHeight * viewport.scale}px`;
}

// ---- Markings ----

function rectDiv([x, y, w, h]) {
  const d = document.createElement('div');
  d.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`;
  return d;
}

function drawMarks(p, preview = []) {
  const rects = marks.filter((m) => m.p === p.i).flatMap((m) => m.r).concat(preview);
  p.marksEl.replaceChildren(...rects.map(rectDiv));
}

// Text spans of a page with their screen boxes (valid until the page scrolls or zooms).
function spanBoxes(p) {
  if (!p.textReady) return [];
  const out = [];
  p.tl.textDivs.forEach((span, i) => {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.length || !node.data.trim()) return;
    const r = span.getBoundingClientRect();
    if (r.width && r.height) out.push({ i, node, r });
  });
  return out;
}

const range = document.createRange();

// Distance from (x, y) to a box: along and across the line (lines run down the screen on pages turned 90°).
function distance(r, x, y, vertical) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return vertical ? { along: dy, across: dx } : { along: dx, across: dy };
}

// The character under (x, y): { i: span index, c: char index }. strict: the finger must be on text.
function charAt(boxes, x, y, strict, vertical) {
  let best = null;
  let bestD = Infinity;
  for (const b of boxes) {
    const { along, across } = distance(b.r, x, y, vertical);
    const d = across * 3 + along; // prefer the finger's own line
    if (d < bestD) {
      bestD = d;
      best = { b, along, across };
    }
  }
  if (!best || (strict && (best.along > 8 || best.across > 4))) return null;
  const { node, i } = best.b;
  let c = 0;
  bestD = Infinity;
  for (let k = 0; k < node.length; k++) {
    range.setStart(node, k);
    range.setEnd(node, k + 1);
    const { along, across } = distance(range.getBoundingClientRect(), x, y, vertical);
    if (along + across < bestD) {
      bestD = along + across;
      c = k;
    }
  }
  return { i, c };
}

// Rects covering the text from a to b (inclusive), in fractions of the page box.
function markRects(p, a, b) {
  if (a.i > b.i || (a.i === b.i && a.c > b.c)) [a, b] = [b, a];
  const box = p.el.getBoundingClientRect();
  const divs = p.tl.textDivs;
  const rects = [];
  for (let i = a.i; i <= b.i; i++) {
    const node = divs[i].firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const s = i === a.i ? a.c : 0;
    const e = i === b.i ? Math.min(b.c + 1, node.length) : node.length;
    if (e <= s) continue;
    range.setStart(node, s);
    range.setEnd(node, e);
    for (const r of range.getClientRects()) {
      if (r.width > 0.5 && r.height > 0.5) rects.push({ l: r.left - box.left, t: r.top - box.top, r: r.right - box.left, b: r.bottom - box.top });
    }
  }
  const round = (v) => Math.round(v * 1e4) / 1e4;
  const flip = (q) => ({ l: q.t, t: q.l, r: q.b, b: q.r });
  const merged = p.vertical ? mergeLines(rects.map(flip)).map(flip) : mergeLines(rects);
  return merged.map((q) => [q.l / box.width, q.t / box.height, (q.r - q.l) / box.width, (q.b - q.t) / box.height].map(round));
}

// Joins rects on the same horizontal line that touch or nearly touch (fills the gaps between words).
function mergeLines(rects) {
  rects.sort((m, n) => m.t - n.t || m.l - n.l);
  const out = [];
  for (const r of rects) {
    const h = r.b - r.t;
    const line = out.find((o) => {
      const overlap = Math.min(o.b, r.b) - Math.max(o.t, r.t);
      return overlap > 0.5 * Math.min(h, o.b - o.t) && r.l - o.r < h && o.l - r.r < h;
    });
    if (line) {
      line.l = Math.min(line.l, r.l);
      line.t = Math.min(line.t, r.t);
      line.r = Math.max(line.r, r.r);
      line.b = Math.max(line.b, r.b);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

// ---- Menu (triple tap) ----

// Each returns true to keep the menu open.
const menuActions = {
  undo() {
    if (!undoStack.length) return false;
    marks = undoStack.pop();
    app.save(docKey, JSON.stringify(marks));
    pages.forEach((p) => drawMarks(p));
    updateMenu();
    return true; // stays open for undoing several steps
  },
  reset() {
    if (marks.length && confirm('Remove all markings in this document?')) setMarks([]);
    return false;
  },
};

function openMenu() {
  updateMenu();
  menuEl.hidden = false;
}

function updateMenu() {
  menuEl.querySelector('[data-action=undo]').disabled = !undoStack.length;
}

menuEl.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const keepOpen = action ? menuActions[action]() : e.target !== menuEl; // a tap beside the menu closes it
  if (!keepOpen) menuEl.hidden = true;
});

// ---- Touch: double tap toggles mark mode, triple tap opens the menu; in mark mode a drag that starts on text marks it ----

function setMarking(on) {
  marking = on;
  app.setMarking(on);
  document.body.classList.toggle('marking', on);
  getSelection()?.removeAllRanges();
}

let touch = null; // current single-finger touch
let taps = null; // { n, x, y, time } of the last tap in a series
let tapTimer = 0;
let drag = null; // { p, boxes, a, b, started }

document.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) {
    touch = null;
    endDrag(false);
    return;
  }
  const t = e.touches[0];
  if (!menuEl.hidden) {
    touch = null; // the menu handles its own taps
    return;
  }
  touch = { x: t.clientX, y: t.clientY, time: e.timeStamp, moved: false };
  if (!marking) return;
  const el = document.elementFromPoint(t.clientX, t.clientY)?.closest('.page');
  const p = el && pages[el.dataset.i];
  if (!p) return;
  const boxes = spanBoxes(p);
  const a = charAt(boxes, t.clientX, t.clientY, true, p.vertical);
  if (!a) return; // not on text: scroll as usual
  e.preventDefault(); // no scrolling, no native selection
  drag = { p, boxes, a, b: a, started: false };
}, { passive: false });

document.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (touch && Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 10) touch.moved = true;
  if (!drag) return;
  e.preventDefault();
  if (!touch?.moved && !drag.started) return;
  drag.started = true;
  drag.b = charAt(drag.boxes, t.clientX, t.clientY, false, drag.p.vertical) ?? drag.b;
  drawMarks(drag.p, markRects(drag.p, drag.a, drag.b));
}, { passive: false });

document.addEventListener('touchend', (e) => {
  endDrag(true);
  if (e.touches.length || !touch) {
    touch = null;
    return;
  }
  const isTap = !touch.moved && e.timeStamp - touch.time < 300;
  clearTimeout(tapTimer);
  if (!isTap) {
    taps = null;
  } else {
    const series = taps && e.timeStamp - taps.time < 350 && Math.hypot(touch.x - taps.x, touch.y - taps.y) < 40;
    taps = { n: series ? taps.n + 1 : 1, x: touch.x, y: touch.y, time: e.timeStamp };
    if (taps.n >= 3) {
      taps = null;
      openMenu();
      e.preventDefault(); // else this tap's click lands on the menu backdrop and closes it
    } else if (taps.n === 2) {
      // Wait whether a third tap follows.
      tapTimer = setTimeout(() => {
        taps = null;
        setMarking(!marking);
      }, 350);
    }
  }
  touch = null;
}, { passive: false });

document.addEventListener('touchcancel', () => {
  endDrag(false);
  touch = null;
  taps = null;
  clearTimeout(tapTimer);
});

function endDrag(commit) {
  if (!drag) return;
  const { p, a, b, started } = drag;
  drag = null;
  if (commit && started) {
    const r = markRects(p, a, b);
    if (r.length) {
      setMarks([...marks, { p: p.i, r }]);
    }
  }
  drawMarks(p);
}

// ---- Resize (rotation) and pinch zoom ----

let anchor = null; // { i, f }: page at the top of the screen and how far into it
let touched = false; // the user has touched the screen since the document opened
let positionLoaded = false; // all pages added: the reading position may be saved
let saveTimer = 0;
addEventListener('touchstart', () => { touched = true; }, { passive: true, capture: true });
addEventListener('scroll', () => {
  anchor = topAnchor();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 400);
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });

// Remembers the reading position per document.
function savePosition() {
  if (!docKey || !anchor || (!positionLoaded && !touched)) return; // don't overwrite it while restoring
  app.save(docKey + ':pos', JSON.stringify({ i: anchor.i, f: Math.round(anchor.f * 1e4) / 1e4 }));
}

function scrollToAnchor(a) {
  const r = pages[a.i].el.getBoundingClientRect();
  scrollTo(0, scrollY + r.top + a.f * r.height);
}

function topAnchor() {
  for (const p of pages) {
    const r = p.el.getBoundingClientRect();
    if (r.bottom > 0) return { i: p.i, f: Math.max(0, -r.top) / r.height };
  }
  return null;
}

let lastWidth = innerWidth;
addEventListener('resize', () => {
  if (innerWidth === lastWidth) return;
  lastWidth = innerWidth;
  if (anchor) scrollToAnchor(anchor);
  pages.filter((p) => p.near).forEach(showPage);
});

let zoomTimer = 0;
window.visualViewport?.addEventListener('resize', () => {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => pages.filter((p) => p.near).forEach(renderCanvas), 250);
});

main().catch((e) => {
  console.error(e);
  msgEl.textContent = `Could not open this PDF (${e?.message ?? e}).`;
});
