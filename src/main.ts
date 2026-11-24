import './style.css';
import { AlertSounds } from './audio/alerts';
import { KINDS, WarningGame, inside, reportText, type Warning, type WarningKind } from './game/warnings';
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

// The warning game.
const game = new WarningGame();
/** The selected tool: which warning/watch the player draws (null = cursor: pan and look). Stays until switched. */
let warnMode: WarningKind | null = null;
/** The shape being drawn right now, in km (plus the finger/mouse position in screen pixels). */
let drawing: { x0: number; y0: number; x1: number; y1: number; pointerId: number; cx: number; cy: number } | null = null;

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** A new radar volume scan every this many game minutes (real radars: about 4-5). */
const SCAN_MINUTES = 4;
let nextScan = 0;

/** Scan the atmosphere now; the beam then sweeps the new picture in. */
function takeScan(): void {
  fields.compute(weather);
  scope.startScan(fields, weather, weather.time);
  nextScan = (Math.floor(weather.time / SCAN_MINUTES) + 1) * SCAN_MINUTES;
}

function newDay(): void {
  weather.reset(randomSeed(), dayKey);
  game.reset();
  setWarnMode(null);
  tickerItems.length = 0;
  tickerItems.push(`NEW DAY: ${weather.day.label.toUpperCase()} · SPOTTERS ARE STANDING BY`);
  renderTicker();
  takeScan();
  scope.finishReveal();
}

function clockText(gameMinutes: number): string {
  const total = START_MINUTES + Math.floor(gameMinutes);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** "3:45 PM" style time, like a real warning. */
function ampm(gameMinutes: number): string {
  const total = START_MINUTES + Math.floor(gameMinutes);
  const h24 = Math.floor(total / 60) % 24;
  const h = h24 % 12 || 12;
  return `${h}:${String(total % 60).padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`;
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
  if (scope.revealing) drawSweep();
  drawWarnings();
  drawReports();
  drawTowns();
  if (debug) drawDebug();

  // Product label.
  ctx.font = `${12 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.fillStyle = 'rgba(140,220,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const label = `${RADAR_ID}  ${MODES[mode].product}  ·  scan ${clockText(scope.scanTime)}`;
  ctx.fillText(label, 12 * dpr, H - 62 * dpr - legendHeight() * dpr);
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

function polyPath(poly: Array<[number, number]>): void {
  ctx.beginPath();
  poly.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
  ctx.closePath();
}

function drawWarnings(): void {
  ctx.save();
  const now = weather.time;
  ctx.font = `700 ${11 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Watches underneath, then warnings, tornado products on top.
  const order: WarningKind[] = ['sva', 'toa', 'svr', 'svrd', 'tor', 'tore'];
  const list = [...game.warnings].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const w of list) {
    const info = KINDS[w.kind];
    const rgb = info.rgb;
    const label = w.number ? `${info.short} #${w.number}` : info.short;
    // Fade out over the last few minutes, and after expiry.
    const left = w.expires - now;
    const alpha = left > 5 ? 1 : left > 0 ? 0.45 + 0.55 * (left / 5) : Math.max(0, 0.45 * (1 + left / 3));
    polyPath(w.poly);
    ctx.fillStyle = `rgba(${rgb},${(info.watch ? 0.05 : 0.1) * alpha})`;
    ctx.fill();
    // Dark edge underneath so the outline stands out even on top of red/yellow echoes.
    const special = w.kind === 'svrd' || w.kind === 'tore';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (special ? 9 : 6) * dpr;
    ctx.strokeStyle = `rgba(0,0,0,${0.7 * alpha})`;
    ctx.stroke();
    if (info.watch) ctx.setLineDash([10 * dpr, 6 * dpr]);
    ctx.lineWidth = (special ? 5 : 3) * dpr;
    ctx.strokeStyle = `rgba(${rgb},${alpha})`;
    ctx.stroke();
    ctx.setLineDash([]);
    if (special) {
      // Special warnings get a white inner stripe so they look extra serious.
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = `rgba(255,255,255,${0.9 * alpha})`;
      ctx.stroke();
    }
    let cx = w.poly.reduce((a, p) => a + p[0], 0) / w.poly.length;
    let cy = w.poly.reduce((a, p) => a + p[1], 0) / w.poly.length;
    if (info.watch) {
      // Watch label sits just inside the top-left corner, out of the storms' way.
      cx = Math.min(...w.poly.map((p) => p[0])) + (60 * dpr) / view.scale;
      cy = Math.max(...w.poly.map((p) => p[1])) - (12 * dpr) / view.scale;
    }
    const mins = Math.max(0, Math.ceil(left));
    const text = left > 0 ? `${label} ${mins}m` : `${label} expired`;
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = `rgba(0,0,0,${0.8 * alpha})`;
    ctx.strokeText(text, sx(cx), sy(cy));
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    ctx.fillText(text, sx(cx), sy(cy));
  }
  if (drawing && warnMode) {
    const c = WarningGame.shape(warnMode, drawing.x0, drawing.y0, drawing.x1, drawing.y1);
    const rgb = KINDS[warnMode].rgb;
    if (c) {
      polyPath(c.poly);
      ctx.fillStyle = `rgba(${rgb},0.12)`;
      ctx.fill();
      ctx.lineWidth = 5 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.setLineDash([6 * dpr, 5 * dpr]);
      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeStyle = `rgba(${rgb},1)`;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = `rgba(${rgb},0.9)`;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(sx(drawing.x0), sy(drawing.y0));
    ctx.lineTo(sx(drawing.x1), sy(drawing.y1));
    ctx.stroke();
  }
  ctx.restore();
}

function drawReports(): void {
  ctx.save();
  const now = weather.time;
  const size = 6 * dpr;
  ctx.font = `700 ${10 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const r of game.reports) {
    const age = now - r.time;
    const alpha = age < 15 ? 1 : Math.max(0, 1 - (age - 15) / 10);
    const x = sx(r.x);
    const y = sy(r.y);
    // Fresh reports pulse so you notice them.
    if (age < 3) {
      ctx.strokeStyle = r.warned ? `rgba(80,255,140,${0.8 - age * 0.25})` : `rgba(255,80,80,${0.8 - age * 0.25})`;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, size * (1.5 + age * 2), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = r.kind === 'tornado' ? '#ff2a2a' : r.kind === 'hail' ? '#3ce06a' : '#4aa8ff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    if (r.kind === 'tornado') {
      ctx.moveTo(x - size, y - size * 0.8);
      ctx.lineTo(x + size, y - size * 0.8);
      ctx.lineTo(x, y + size);
    } else if (r.kind === 'hail') {
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
    } else {
      ctx.rect(x - size * 0.8, y - size * 0.8, size * 1.6, size * 1.6);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const zoom = view.scale / fitScale();
    if (zoom > 1.6) {
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      const label = reportText(r);
      ctx.strokeText(label, x + size + 3 * dpr, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + size + 3 * dpr, y);
    }
    ctx.globalAlpha = 1;
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
    ctx.strokeStyle =
      c.kind === 'super' ? '#ff6bd6' : c.kind === 'bow' ? '#ff9f43' : c.kind === 'multi' ? '#ffd36b' : '#9be7ff';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.arc(x, y, (c.kind === 'bow' ? s.bowL : s.b) * view.scale, 0, Math.PI * 2);
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

const scoreEl = $('score');
const toastsEl = $('toasts');
const hintEl = $('hint');

const TOOL_HINTS: Record<WarningKind, string> = {
  svr: 'SEVERE THUNDERSTORM warning: press on the storm and drag the way it is moving.',
  svrd: 'DESTRUCTIVE (PDS) severe warning: for 80+ mph wind or 2.75"+ hail. Double points if it verifies!',
  tor: 'TORNADO warning: press on the storm and drag the way it is moving.',
  tore: 'TORNADO EMERGENCY: only for a violent tornado (EF3+) on the ground. Triple points, big penalty if wrong!',
  sva: 'SEVERE THUNDERSTORM WATCH: drag a big box where storms may turn severe in the next 90 minutes.',
  toa: 'TORNADO WATCH: drag a big box where tornadoes are possible in the next 90 minutes.',
};
let hintTimer = 0;
function showHint(text: string): void {
  hintEl.textContent = text;
  hintEl.classList.remove('hidden');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hintEl.classList.add('hidden'), 4500);
}

/** Pick a tool. It stays selected until another one is picked (C / Esc = cursor). */
function setWarnMode(k: WarningKind | null): void {
  warnMode = k;
  drawing = null;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('on', (b.dataset.tool || null) === k));
  canvas.style.cursor = k ? 'cell' : 'crosshair';
  if (k) showHint(`${TOOL_HINTS[k]}  (${KINDS[k].minutes} min · right-drag or two fingers to pan · C for cursor)`);
  else hintEl.classList.add('hidden');
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
  b.addEventListener('click', () => {
    const k = (b.dataset.tool || null) as WarningKind | null;
    setWarnMode(warnMode === k ? null : k);
    b.blur();
  }),
);

// ---------------------------------------------------------------------------
// Alerts panel, ticker, EAS, sounds
// ---------------------------------------------------------------------------
const sounds = new AlertSounds();
const alertsEl = $('alerts');
const tickerEl = $('ticker');
const tickerLabel = $('ticker-label');
const tickerTrack = $('ticker-track');
const tickerText = $('ticker-text');
const easEl = $('eas');
const easSub = $('eas-sub');
const muteBtn = $<HTMLButtonElement>('mute');

// Browsers only allow sound after the first click / key press.
const unlockAudio = () => sounds.unlock();
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

function toggleMute(): void {
  sounds.setMuted(!sounds.muted);
  muteBtn.textContent = sounds.muted ? '🔇' : '🔊';
}
muteBtn.addEventListener('click', () => {
  toggleMute();
  muteBtn.blur();
});

/** Which towns a warning covers, e.g. "Hailstone, Gustfield and Redfield". */
function areaText(w: Warning): string {
  const names = geo.towns.filter((t) => inside(w.poly, t.x, t.y)).map((t) => t.name);
  if (names.length === 0) {
    const cx = w.poly.reduce((a, p) => a + p[0], 0) / w.poly.length;
    const cy = w.poly.reduce((a, p) => a + p[1], 0) / w.poly.length;
    return geo.describe(cx, cy);
  }
  if (names.length === 1) return names[0];
  if (names.length > 4) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more towns`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function announceWarning(w: Warning): void {
  w.areaText = areaText(w);
  const until = ampm(w.expires);
  const area = w.areaText;
  const intro = 'This is the Stormhaven Weather Service.';
  switch (w.kind) {
    case 'svr':
      pushTicker(`SEVERE THUNDERSTORM WARNING FOR ${area.toUpperCase()} UNTIL ${until}`);
      sounds.svrAlert();
      break;
    case 'svrd':
      pushTicker(`💥 DESTRUCTIVE SEVERE THUNDERSTORM WARNING FOR ${area.toUpperCase()} UNTIL ${until} · 80 MPH WINDS OR GIANT HAIL`);
      startEas(
        `DESTRUCTIVE SEVERE THUNDERSTORM WARNING for ${area} until ${until}`,
        `${intro} A destructive severe thunderstorm warning has been issued for ${area} until ${until}. ` +
          `Winds of 80 miles per hour or more, or hail larger than baseballs, are expected. Get indoors and away from windows now.`,
        'warning',
      );
      break;
    case 'tor':
      pushTicker(`⚠ TORNADO WARNING FOR ${area.toUpperCase()} UNTIL ${until} · TAKE SHELTER NOW`);
      startEas(
        `TORNADO WARNING for ${area} until ${until}`,
        `${intro} A tornado warning has been issued for ${area} until ${until}. ` +
          `Take shelter now in a basement, or an interior room on the lowest floor, away from windows.`,
        'warning',
      );
      break;
    case 'tore':
      pushTicker(`☠ TORNADO EMERGENCY FOR ${area.toUpperCase()} · A LARGE AND EXTREMELY DANGEROUS TORNADO IS ON THE GROUND · TAKE COVER NOW`);
      startEas(
        `TORNADO EMERGENCY for ${area} until ${until}`,
        `${intro} This is a tornado emergency for ${area}. A large and extremely dangerous tornado is on the ground. ` +
          `This is a particularly dangerous situation. Take cover now! Get underground if you can.`,
        'emergency',
      );
      break;
    case 'sva':
    case 'toa': {
      const name = w.kind === 'toa' ? 'TORNADO WATCH' : 'SEVERE THUNDERSTORM WATCH';
      pushTicker(`${name} #${w.number} IN EFFECT UNTIL ${until} FOR ${area.toUpperCase()}`);
      sounds.watchAlert();
      break;
    }
  }
}

let easText = '';
function startEas(headline: string, speech: string, level: 'warning' | 'emergency'): void {
  sounds.eas(speech, () => {
    easEl.classList.add('hidden');
    tickerEl.classList.remove('eas-on');
    tickerLabel.textContent = 'SPOTTER NETWORK';
    easText = '';
    renderTicker();
  });
  // Show it right away (if a second one is queued, it takes over the banner).
  easSub.textContent = headline.toUpperCase();
  easEl.classList.toggle('emergency', level === 'emergency');
  easEl.classList.remove('hidden');
  tickerEl.classList.add('eas-on');
  tickerLabel.textContent = 'EAS ALERT';
  easText = `EMERGENCY ALERT · ${headline.toUpperCase()} · TAKE SHELTER NOW IN A BASEMENT OR INTERIOR ROOM ON THE LOWEST FLOOR · `;
  tickerOffset = tickerTrack.clientWidth;
  renderTicker();
  window.setTimeout(() => easEl.classList.add('hidden'), 6000); // banner flashes, ticker keeps going
}

// The ticker: newest items scroll across the bottom of the screen.
const tickerItems: string[] = ['WELCOME TO THE RADAR SPOTTERS NETWORK · SPOTTER REPORTS WILL APPEAR HERE'];
let tickerOffset = 0;
function pushTicker(item: string): void {
  tickerItems.push(item);
  if (tickerItems.length > 6) tickerItems.shift();
  renderTicker();
}
function renderTicker(): void {
  tickerText.textContent = easText ? easText.repeat(3) : tickerItems.join('     ◆     ') + '     ◆     ';
}
function scrollTicker(dt: number): void {
  const w = tickerText.offsetWidth;
  tickerOffset -= (easText ? 120 : 85) * dt;
  if (tickerOffset < -w) tickerOffset = tickerTrack.clientWidth;
  tickerText.style.left = `${tickerOffset}px`;
}

game.onReport = (r, what, where) => {
  pushTicker(`SPOTTER REPORT ${ampm(r.time)}: ${what.toUpperCase()} ${where.toUpperCase()}`);
  sounds.chime();
};
game.onExpire = (w) => {
  const info = KINDS[w.kind];
  pushTicker(`${info.name.toUpperCase()}${w.number ? ` #${w.number}` : ''} FOR ${w.areaText.toUpperCase()} HAS EXPIRED`);
};

const ICONS: Record<WarningKind, string> = { svr: '⚠', svrd: '💥', tor: '🌪', tore: '☠', sva: '▭', toa: '▭' };
let lastAlerts = '';
function updateAlerts(): void {
  const now = weather.time;
  const rank: WarningKind[] = ['tore', 'tor', 'svrd', 'svr', 'toa', 'sva'];
  const active = game.warnings
    .filter((w) => now < w.expires)
    .sort((a, b) => (a.kind === b.kind ? a.expires - b.expires : rank.indexOf(a.kind) - rank.indexOf(b.kind)));
  let html = `<div class="alerts-head">ACTIVE ALERTS · ${active.length}</div>`;
  for (const w of active) {
    const left = Math.max(0, Math.ceil(w.expires - now));
    const info = KINDS[w.kind];
    const fresh = (w.kind === 'tor' || w.kind === 'tore') && now - w.issued < 3 ? ' fresh' : '';
    const title = `${ICONS[w.kind]} ${info.name.toUpperCase()}${w.number ? ` #${w.number}` : ''}`;
    html +=
      `<div class="alert ${w.kind}${fresh}" style="--c:${info.rgb}"><b>${title}</b>` +
      `${escapeHtml(w.areaText)}<div class="meta">until ${ampm(w.expires)} · ${left} min left · ${w.reports} report${w.reports === 1 ? '' : 's'}</div></div>`;
  }
  if (html !== lastAlerts) {
    lastAlerts = html;
    alertsEl.innerHTML = html;
  }
}

let lastScore = '';
let lastToasts = '';
function updateGameHud(): void {
  const sc = `Score <b>${game.score}</b><br><span class="dim">✔ ${game.hits} warned · ✘ ${game.misses} missed · ${game.falseAlarms} false</span>`;
  if (sc !== lastScore) {
    lastScore = sc;
    scoreEl.innerHTML = sc;
  }
  const html = game.toasts.map((t) => `<div class="toast${t.good ? '' : ' bad'}">${escapeHtml(t.text)}</div>`).join('');
  if (html !== lastToasts) {
    lastToasts = html;
    toastsEl.innerHTML = html;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

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
  const txt = clockText(weather.time);
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

canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag pans
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (warnMode && pointers.size === 0 && !drawing && e.button === 0) {
    // Start drawing a warning cone (or watch box) from the storm.
    const rect = canvas.getBoundingClientRect();
    const x = wx((e.clientX - rect.left) * dpr);
    const y = wy((e.clientY - rect.top) * dpr);
    drawing = { x0: x, y0: y, x1: x, y1: y, pointerId: e.pointerId, cx: e.clientX, cy: e.clientY };
    return;
  }
  if (drawing && e.pointerType === 'touch') {
    // A second finger: they want to pinch/pan, not draw.
    pointers.set(drawing.pointerId, { x: drawing.cx, y: drawing.cy });
    drawing = null;
  }
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
  if (drawing && drawing.pointerId === e.pointerId) {
    drawing.x1 = wx(pointerX * dpr);
    drawing.y1 = wy(pointerY * dpr);
    drawing.cx = e.clientX;
    drawing.cy = e.clientY;
    return;
  }
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
  if (drawing && drawing.pointerId === e.pointerId) {
    if (e.type === 'pointerup' && warnMode) {
      const w = game.issue(warnMode, drawing.x0, drawing.y0, drawing.x1, drawing.y1, weather.time);
      if (w) {
        announceWarning(w); // the tool stays selected for the next one
      } else {
        showHint(KINDS[warnMode].watch ? 'Drag a bigger box! Watches cover a big area.' : 'Drag further! Press on the storm and drag the way it is heading.');
      }
    }
    drawing = null;
    return;
  }
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
    // Tools (they stay selected until you pick another).
    case 'c':
    case 'C':
      setWarnMode(null);
      break;
    case 'w':
    case 'W':
      setWarnMode('svr');
      break;
    case 'e':
    case 'E':
      setWarnMode('svrd');
      break;
    case 't':
    case 'T':
      setWarnMode('tor');
      break;
    case 'y':
    case 'Y':
      setWarnMode('tore');
      break;
    case 'a':
    case 'A':
      setWarnMode('sva');
      break;
    case 's':
    case 'S':
      setWarnMode('toa');
      break;
    case 'm':
    case 'M':
      toggleMute();
      break;
    case 'Escape':
      setWarnMode(null);
      break;
    case 'd':
    case 'D':
      debug = !debug;
      lastClock = '';
      break;
    case 'b':
    case 'B':
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

function frame(now: number): void {
  // The first animation timestamp can be slightly earlier than `last`, so never let time run backwards.
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  if (!paused) weather.update((dt * speed) / 60);
  game.update(weather, (x, y) => geo.describe(x, y));
  if (weather.time >= nextScan) {
    scope.finishReveal(); // never leave a half-revealed scan behind
    takeScan();
  }
  // The beam sweeps each new scan in quickly, then the picture holds until the next one.
  const realSecondsPerScan = (SCAN_MINUTES * 60) / speed;
  const sweepSeconds = Math.min(1.6, Math.max(0.5, realSecondsPerScan * 0.7));
  scope.reveal((360 * dt) / sweepSeconds);
  scope.paint(mode);

  draw();
  updateHud();
  updateGameHud();
  updateAlerts();
  scrollTicker(dt);
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
takeScan();
scope.finishReveal();
game.reset();
renderTicker();
tickerOffset = tickerTrack.clientWidth;
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
  (window as unknown as Record<string, unknown>).rs = { weather, view, scope, fields, setMode, newDay, game };
}
