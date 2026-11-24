import { buildLut, REFLECTIVITY } from '../radar/colors';
import { GRID, RANGE_KM } from '../sim/fields';
import { KINDS, type Report, type Warning, type WarningKind } from './warnings';

/**
 * The end of a shift: ranks, high scores, and a time-lapse replay of the whole
 * afternoon so the player can sit back and go "wow, that was nuts".
 */

/** A shift runs from 14:00 to 20:00 (game minutes after 14:00). */
export const SHIFT_MINUTES = 360;
/** Storms start winding down this long before the end of the shift. */
export const WIND_DOWN_MINUTES = 75;

export const RANKS: Array<{ min: number; title: string; icon: string }> = [
  { min: -Infinity, title: 'Weather Rock', icon: '🪨' },
  { min: 0, title: 'Rookie Spotter', icon: '🔭' },
  { min: 1000, title: 'Storm Spotter', icon: '📡' },
  { min: 3000, title: 'Storm Chaser', icon: '🚙' },
  { min: 6000, title: 'Warning Forecaster', icon: '⚠️' },
  { min: 10000, title: 'Lead Forecaster', icon: '🌪️' },
  { min: 15000, title: 'Chief Meteorologist', icon: '🏆' },
];

export function rankFor(score: number) {
  let r = RANKS[0];
  for (const k of RANKS) if (score >= k.min) r = k;
  return r;
}

/** High score per weather-day type, kept in this browser only. */
export function loadBest(day: string): number | null {
  try {
    const v = localStorage.getItem(`rs-best-${day}`);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
export function saveBest(day: string, score: number): void {
  try {
    localStorage.setItem(`rs-best-${day}`, String(score));
  } catch {
    /* storage blocked: no high score saved */
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const R = GRID / 2; // replay frames are stored at half resolution

interface Frame {
  time: number;
  /** Reflectivity, 0 = no echo, otherwise dBZ * 3. */
  ref: Uint8Array;
  warnings: Array<{ kind: WarningKind; poly: Array<[number, number]> }>;
  reports: Array<Pick<Report, 'kind' | 'x' | 'y' | 'warned'>>;
}

export class Replay {
  frames: Frame[] = [];
  private lut = buildLut(REFLECTIVITY, 255);
  private img: ImageData | null = null;
  private off: HTMLCanvasElement | null = null;

  clear(): void {
    this.frames = [];
  }

  /** Save one radar scan (the scope's current picture) plus what was active then. */
  record(time: number, dbz: Float32Array, warnings: Warning[], reports: Report[]): void {
    if (this.frames.length && this.frames[this.frames.length - 1].time >= time) return;
    const ref = new Uint8Array(R * R);
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        // Keep the strongest of each 2x2 block so the cores survive the shrink.
        const a = (j * 2) * GRID + i * 2;
        const d = Math.max(dbz[a], dbz[a + 1], dbz[a + GRID], dbz[a + GRID + 1]);
        ref[j * R + i] = d >= 5 ? Math.min(255, Math.round(d * 3)) : 0;
      }
    }
    this.frames.push({
      time,
      ref,
      warnings: warnings.filter((w) => time >= w.issued && time < w.expires).map((w) => ({ kind: w.kind, poly: w.poly })),
      reports: reports.filter((r) => time - r.time < 12).map((r) => ({ kind: r.kind, x: r.x, y: r.y, warned: r.warned })),
    });
  }

  /** Draw frame `k` into a square canvas. */
  draw(canvas: HTMLCanvasElement, k: number, label: string, towns: Array<{ x: number; y: number; size: number }>): void {
    const f = this.frames[k];
    const ctx = canvas.getContext('2d')!;
    const S = canvas.width;
    const toPx = (x: number, y: number): [number, number] => [((x + RANGE_KM) / (2 * RANGE_KM)) * S, ((RANGE_KM - y) / (2 * RANGE_KM)) * S];
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#10161d';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    ctx.fill();
    if (!f) return;

    if (!this.off) {
      this.off = document.createElement('canvas');
      this.off.width = R;
      this.off.height = R;
      this.img = this.off.getContext('2d')!.createImageData(R, R);
    }
    const px = new Uint32Array(this.img!.data.buffer);
    const k1 = 1023 / (REFLECTIVITY.max - REFLECTIVITY.min);
    for (let n = 0; n < f.ref.length; n++) {
      const v = f.ref[n];
      if (!v) {
        px[n] = 0;
        continue;
      }
      const idx = Math.max(0, Math.min(1023, ((v / 3 - REFLECTIVITY.min) * k1) | 0));
      px[n] = this.lut[idx];
    }
    this.off.getContext('2d')!.putImageData(this.img!, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, 0, 0, S, S);

    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    for (const t of towns) {
      const [x, y] = toPx(t.x, t.y);
      ctx.fillRect(x - 1, y - 1, t.size >= 3 ? 3 : 2, t.size >= 3 ? 3 : 2);
    }

    ctx.lineJoin = 'round';
    for (const w of f.warnings) {
      ctx.beginPath();
      w.poly.forEach(([x, y], i) => {
        const [a, b] = toPx(x, y);
        if (i) ctx.lineTo(a, b);
        else ctx.moveTo(a, b);
      });
      ctx.closePath();
      ctx.setLineDash(KINDS[w.kind].watch ? [5, 4] : []);
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgb(${KINDS[w.kind].rgb})`;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const r of f.reports) {
      const [x, y] = toPx(r.x, r.y);
      ctx.fillStyle = r.kind === 'tornado' ? '#ff2a2a' : r.kind === 'hail' ? '#3ce06a' : '#4aa8ff';
      ctx.strokeStyle = r.warned ? '#000' : '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r.kind === 'tornado' ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(90,200,255,0.5)';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '700 15px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#9dffb8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, 8, 8);
  }
}
