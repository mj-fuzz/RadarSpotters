import './style.css';
import { Geography, RADAR_ID, compass, type Polyline } from './map/geography';
import { MODES, Scope, type Mode } from './radar/scope';
import { Fields, RANGE_KM } from './sim/fields';
import { NoiseTex } from './sim/noise';
import { Rng } from './sim/rng';
import { DAY_TYPES, Weather, cellShape, type DayKey } from './sim/weather';

// ---------------------------------------------------------------------------
// World setup
// ---------------------------------------------------------------------------
const SITE_SEED = 20240501; // fixed so the map (towns, counties) stays the same between days
const START_MINUTES = 14 * 60; // the "afternoon" starts at 14:00

const noise = new NoiseTex(new Rng(SITE_SEED));
const geo = new Geography(SITE_SEED);
const fields = new Fields(noise, SITE_SEED);
const scope = new Scope();
let dayKey: DayKey = 'active';
const weather = new Weather(randomSeed(), dayKey);

let mode: Mode = 'ref';
let speed = 60; // game seconds per real second
let paused = false;
let debug = false;
let smoothing = true;

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function newDay(): void {
  weather.reset(randomSeed(), dayKey);
  fields.compute(weather);
  scope.fullScan(fields, weather);
}

// ---------------------------------------------------------------------------
// Canvas + view
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scope') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let W = 0;
let H = 0;
let dpr = 1;
const view = { cx: 0, cy: 0, scale: 1 };

function fitScale(): number {
  return Math.min(W, H) / (2 * RANGE_KM * 1.04);
}

function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.floor(canvas.clientWidth * dpr);
  H = Math.floor(canvas.clientHeight * dpr);
  canvas.width = W;
  canvas.height = H;
  view.scale = Math.max(view.scale, fitScale() * 0.8);
}

function resetView(): void {
  view.cx = 0;
  view.cy = 0;
  view.scale = fitScale();
}

const sx = (x: number) => W / 2 + (x - view.cx) * view.scale;
const sy = (y: number) => H / 2 - (y - view.cy) * view.scale;
const wx = (px: number) => view.cx + (px - W / 2) / view.scale;
const wy = (py: number) => view.cy - (py - H / 2) / view.scale;

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function strokeLine(line: Polyline): void {
  if (line.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(sx(line[0][0]), sy(line[0][1]));
  for (let k = 1; k < line.length; k++) ctx.lineTo(sx(line[k][0]), sy(line[k][1]));
  ctx.stroke();
}

function draw(): void {
  ctx.fillStyle = '#0a0e13';
  ctx.fillRect(0, 0, W, H);

  const r = RANGE_KM * view.scale;
  // Radar coverage disc.
  ctx.fillStyle = '#10161d';
  ctx.beginPath();
  ctx.arc(sx(0), sy(0), r, 0, Math.PI * 2);
  ctx.fill();

  // Radar data.
  ctx.imageSmoothingEnabled = smoothing;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scope.canvas, sx(-RANGE_KM), sy(RANGE_KM), 2 * r, 2 * r);

  // Map layers on top, like a real radar display.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(160,170,185,0.22)';
  ctx.lineWidth = 1 * dpr;
  for (const c of geo.counties) strokeLine(c);
  ctx.strokeStyle = 'rgba(214,120,72,0.5)';
  ctx.lineWidth = 1.6 * dpr;
  for (const h of geo.highways) strokeLine(h);
  ctx.strokeStyle = 'rgba(230,232,240,0.65)';
  ctx.lineWidth = 2.2 * dpr;
  strokeLine(geo.stateLine);

  drawRings();
  drawSweep();
  drawTowns();
  if (debug) drawDebug();

  // Product label.
  ctx.font = `${12 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.fillStyle = 'rgba(140,220,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const label = `${RADAR_ID}  ${MODES[mode].product}`;
  ctx.fillText(label, 12 * dpr, H - 26 * dpr - legendHeight() * dpr);
}

function legendHeight(): number {
  return (document.getElementById('legend')?.offsetHeight ?? 0) + 14;
}

function drawRings(): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(90,200,255,0.22)';
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([4 * dpr, 6 * dpr]);
  ctx.font = `${10 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.fillStyle = 'rgba(120,210,255,0.55)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let km = 50; km < RANGE_KM; km += 50) {
    ctx.beginPath();
    ctx.arc(sx(0), sy(0), km * view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${km}`, sx(0), sy(km) - 2 * dpr);
  }
  for (let az = 0; az < 360; az += 30) {
    const a = (az * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(sx(Math.sin(a) * 15), sy(Math.cos(a) * 15));
    ctx.lineTo(sx(Math.sin(a) * RANGE_KM), sy(Math.cos(a) * RANGE_KM));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(90,200,255,0.5)';
  ctx.beginPath();
  ctx.arc(sx(0), sy(0), RANGE_KM * view.scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawSweep(): void {
  const cx = sx(0);
  const cy = sy(0);
  const len = RANGE_KM * view.scale;
  const a = ((scope.azimuth - 90) * Math.PI) / 180; // canvas angle: 0 = east, clockwise
  ctx.save();
  // Fading trail behind the beam.
  const trail = 0.5;
  const steps = 12;
  for (let k = 0; k < steps; k++) {
    const a0 = a - (trail * (k + 1)) / steps;
    const a1 = a - (trail * k) / steps;
    ctx.fillStyle = `rgba(120,255,170,${0.07 * (1 - k / steps)})`;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, len, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(150,255,190,0.55)';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
  ctx.stroke();

  // Radar site.
  ctx.fillStyle = '#7fe0ff';
  ctx.fillRect(cx - 3 * dpr, cy - 3 * dpr, 6 * dpr, 6 * dpr);
  ctx.restore();
}

function drawTowns(): void {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const zoom = view.scale / fitScale();
  for (const t of geo.towns) {
    const showLabel = t.size === 3 || (t.size === 2 && zoom > 1.2) || zoom > 2.2;
    const x = sx(t.x);
    const y = sy(t.y);
    if (x < -50 || y < -50 || x > W + 50 || y > H + 50) continue;
    const rad = (t.size === 3 ? 3.5 : t.size === 2 ? 2.5 : 1.8) * dpr;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    if (showLabel) {
      ctx.font = `${(t.size === 3 ? 12 : 11) * dpr}px system-ui, sans-serif`;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(t.name, x + rad + 3 * dpr, y);
      ctx.fillStyle = t.size === 3 ? '#ffffff' : 'rgba(225,230,240,0.85)';
      ctx.fillText(t.name, x + rad + 3 * dpr, y);
    }
  }
  ctx.restore();
}

function drawDebug(): void {
  ctx.save();
  ctx.font = `${10 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const c of weather.cells) {
    const s = cellShape(c);
    const x = sx(c.x);
    const y = sy(c.y);
    const stage = s.t < 0.28 ? 'growing' : s.t < 0.65 ? 'mature' : 'dying';
    ctx.strokeStyle = c.kind === 'super' ? '#ff6bd6' : c.kind === 'multi' ? '#ffd36b' : '#9be7ff';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.arc(x, y, s.b * view.scale, 0, Math.PI * 2);
    ctx.stroke();
    // 30-minute motion arrow.
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(sx(c.x + c.vx * 30), sy(c.y + c.vy * 30));
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`#${c.id} ${c.kind} ${stage} ${Math.round(s.peak)}dBZ ${Math.round(s.topNow)}k`, x + 4 * dpr, y + 4 * dpr);
    if (s.meso > 0) {
      ctx.strokeStyle = '#ffee00';
      ctx.beginPath();
      ctx.arc(sx(s.mesoX), sy(s.mesoY), 3.5 * view.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (c.tornado) {
      const tx = sx(s.mesoX + c.tornado.ox);
      const ty = sy(s.mesoY + c.tornado.oy);
      ctx.fillStyle = '#ff2a2a';
      ctx.beginPath();
      ctx.moveTo(tx, ty - 8 * dpr);
      ctx.lineTo(tx + 7 * dpr, ty + 5 * dpr);
      ctx.lineTo(tx - 7 * dpr, ty + 5 * dpr);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const clockEl = $('clock');
const infoEl = $('info');
const readoutEl = $('readout');
const legendCanvas = $<HTMLCanvasElement>('legend-bar');
const legendLabels = $('legend-labels');
const daySelect = $<HTMLSelectElement>('day');

for (const [key, d] of Object.entries(DAY_TYPES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = d.label;
  if (key === dayKey) opt.selected = true;
  daySelect.appendChild(opt);
}
daySelect.addEventListener('change', () => {
  dayKey = daySelect.value as DayKey;
  newDay();
  daySelect.blur();
});
$('newday').addEventListener('click', () => newDay());

function setMode(m: Mode): void {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  drawLegend();
}
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode as Mode)),
);

const SPEEDS = [30, 60, 120, 240];
function setSpeed(s: number): void {
  speed = s;
  paused = false;
  syncSpeedButtons();
}
function togglePause(): void {
  paused = !paused;
  syncSpeedButtons();
}
function syncSpeedButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
    const v = Number(b.dataset.speed);
    b.classList.toggle('on', v === 0 ? paused : !paused && v === speed);
  });
}
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
  b.addEventListener('click', () => {
    const v = Number(b.dataset.speed);
    if (v === 0) togglePause();
    else setSpeed(v);
  }),
);

function drawLegend(): void {
  const scale = MODES[mode].scale;
  const w = legendCanvas.clientWidth * dpr;
  const h = legendCanvas.clientHeight * dpr;
  legendCanvas.width = w;
  legendCanvas.height = h;
  const lctx = legendCanvas.getContext('2d')!;
  for (let x = 0; x < w; x++) {
    const val = scale.min + ((scale.max - scale.min) * x) / (w - 1);
    let s = 0;
    while (s < scale.stops.length - 2 && val >= scale.stops[s + 1][0]) s++;
    const [v0, c0] = scale.stops[s];
    const [v1, c1] = scale.stops[s + 1];
    const f = scale.smooth ? (val - v0) / (v1 - v0) : val >= v1 ? 1 : 0;
    lctx.fillStyle = mix(c0, c1, Math.max(0, Math.min(1, f)));
    lctx.fillRect(x, 0, 1, h);
  }
  legendLabels.innerHTML = '';
  const step = mode === 'vel' ? 25 : mode === 'ref' ? 10 : 10;
  for (let v = Math.ceil(scale.min / step) * step; v <= scale.max; v += step) {
    const span = document.createElement('span');
    span.textContent = String(v);
    span.style.left = `${((v - scale.min) / (scale.max - scale.min)) * 100}%`;
    legendLabels.appendChild(span);
  }
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = mode === 'vel' ? 'kt  (green = toward radar, red = away)' : scale.unit;
  legendLabels.appendChild(unit);
}

function mix(a: string, b: string, f: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(((pa >> sh) & 255) * (1 - f) + ((pb >> sh) & 255) * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

let lastClock = '';
function updateHud(): void {
  const total = START_MINUTES + Math.floor(weather.time);
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  const txt = `${hh}:${mm}`;
  if (txt !== lastClock) {
    lastClock = txt;
    clockEl.textContent = txt;
    const tor = weather.cells.filter((c) => c.tornado).length;
    infoEl.textContent =
      `Storms ${weather.cells.length} · Steering from ${Math.round(((weather.windFromDeg % 360) + 360) % 360)}° at ${Math.round(weather.windKmh)} km/h` +
      (debug ? ` · Tornadoes ${tor}` : '');
  }
}

// Cursor readout.
let pointerX = -1;
let pointerY = -1;
function updateReadout(): void {
  if (pointerX < 0) {
    readoutEl.textContent = '';
    return;
  }
  const x = wx(pointerX * dpr);
  const y = wy(pointerY * dpr);
  const rng = Math.hypot(x, y);
  if (rng > RANGE_KM) {
    readoutEl.textContent = 'Out of radar range';
    return;
  }
  const az = Math.round(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360);
  const val = scope.valueAt(mode, x, y);
  let vtxt = '—';
  if (val !== null) {
    if (mode === 'ref') vtxt = `${Math.round(val)} dBZ`;
    else if (mode === 'vel') vtxt = `${val >= 0 ? '+' : ''}${Math.round(val)} kt ${val >= 0 ? 'away' : 'toward'}`;
    else vtxt = `${Math.round(val)},000 ft`;
  }
  readoutEl.textContent = `${vtxt}  ·  ${az}° ${Math.round(rng)} km ${compass(x, y)} of radar  ·  ${geo.describe(x, y)}`;
}

// ---------------------------------------------------------------------------
// Input: pan, zoom, pinch, keys
// ---------------------------------------------------------------------------
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  pointerX = e.clientX - rect.left;
  pointerY = e.clientY - rect.top;
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    view.cx -= ((e.clientX - p.x) * dpr) / view.scale;
    view.cy += ((e.clientY - p.y) * dpr) / view.scale;
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomAt(((a.x + b.x) / 2 - rect.left) * dpr, ((a.y + b.y) / 2 - rect.top) * dpr, d / pinchDist);
    pinchDist = d;
  }
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  pinchDist = 0;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  pointerX = -1;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);
canvas.addEventListener('dblclick', resetView);

function zoomAt(px: number, py: number, factor: number): void {
  const x = wx(px);
  const y = wy(py);
  view.scale = Math.min(fitScale() * 12, Math.max(fitScale() * 0.7, view.scale * factor));
  view.cx = x - (px - W / 2) / view.scale;
  view.cy = y + (py - H / 2) / view.scale;
}

const help = $('help');
$('help-btn').addEventListener('click', () => help.classList.toggle('hidden'));
help.addEventListener('click', () => help.classList.add('hidden'));

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  switch (e.key) {
    case '1':
      setMode('ref');
      break;
    case '2':
      setMode('vel');
      break;
    case '3':
      setMode('et');
      break;
    case ' ':
      e.preventDefault();
      togglePause();
      break;
    case '+':
    case '=':
      setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]);
      break;
    case '-':
    case '_':
      setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]);
      break;
    case 'd':
    case 'D':
      debug = !debug;
      lastClock = '';
      break;
    case 's':
    case 'S':
      smoothing = !smoothing;
      break;
    case 'n':
    case 'N':
      newDay();
      break;
    case '0':
      resetView();
      break;
    case 'h':
    case 'H':
    case '?':
      help.classList.toggle('hidden');
      break;
  }
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
let dirty = true;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (!paused) {
    weather.update((dt * speed) / 60);
    dirty = true;
  }
  if (dirty) {
    fields.compute(weather);
    dirty = false;
  }
  // One full scan every ~4 game minutes, but never too fast or too slow to watch.
  const period = paused ? 4 : Math.min(6, Math.max(1.2, 240 / speed));
  scope.sweep((360 * dt) / period, fields, weather);
  scope.paint(mode);

  draw();
  updateHud();
  updateReadout();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  resize();
  drawLegend();
});
resize();
resetView();
setMode('ref');
syncSpeedButtons();
fields.compute(weather);
scope.fullScan(fields, weather);
requestAnimationFrame(frame);

// Offline / installable app support (production builds only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}

// Handy handle for poking at the sim from the browser console during development.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).rs = { weather, view, scope, fields, setMode, newDay };
}
