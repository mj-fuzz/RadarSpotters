import { GRID, KM_PER_PX, RANGE_KM, pxToX, pxToY, type Fields } from '../sim/fields';
import type { Weather } from '../sim/weather';
import { ECHO_TOPS, REFLECTIVITY, VELOCITY, buildLut, type ColorScale } from './colors';

export type Mode = 'ref' | 'vel' | 'et';

export const MODES: Record<Mode, { name: string; product: string; scale: ColorScale }> = {
  ref: { name: 'REF', product: 'Base Reflectivity 0.5°', scale: REFLECTIVITY },
  vel: { name: 'VEL', product: 'Base Velocity 0.5°', scale: VELOCITY },
  et: { name: 'ET', product: 'Echo Tops', scale: ECHO_TOPS },
};

const BUCKETS = 720; // half-degree azimuth bins
const NO_ECHO = -99;
const MS_TO_KT = 1.94384;

/**
 * What the player sees. Holds the last sampled value for every pixel and only
 * refreshes the pixels the rotating beam has just swept over, like a real radar.
 */
export class Scope {
  readonly dbz = new Float32Array(GRID * GRID).fill(NO_ECHO);
  /** Radial velocity, knots (NaN = no data). */
  readonly vel = new Float32Array(GRID * GRID).fill(NaN);
  /** Echo tops, kft (0 = none). */
  readonly tops = new Float32Array(GRID * GRID);

  /** Beam azimuth, degrees clockwise from north. */
  azimuth = 0;

  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private pixels: Uint32Array;
  private buckets: Int32Array[] = [];
  private inside: Int32Array;
  private ex = new Float32Array(GRID * GRID);
  private ey = new Float32Array(GRID * GRID);
  private range = new Float32Array(GRID * GRID);
  private luts: Record<Mode, Uint32Array>;
  private speckle = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID;
    this.canvas.height = GRID;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(GRID, GRID);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.luts = { ref: buildLut(REFLECTIVITY), vel: buildLut(VELOCITY), et: buildLut(ECHO_TOPS) };

    const lists: number[][] = Array.from({ length: BUCKETS }, () => []);
    const inside: number[] = [];
    for (let j = 0; j < GRID; j++) {
      const y = pxToY(j);
      for (let i = 0; i < GRID; i++) {
        const x = pxToX(i);
        const r = Math.hypot(x, y);
        if (r > RANGE_KM) continue;
        const idx = j * GRID + i;
        const az = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
        lists[Math.min(BUCKETS - 1, Math.floor((az / 360) * BUCKETS))].push(idx);
        inside.push(idx);
        this.range[idx] = r;
        this.ex[idx] = r > 0 ? x / r : 0;
        this.ey[idx] = r > 0 ? y / r : 0;
      }
    }
    this.buckets = lists.map((l) => Int32Array.from(l));
    this.inside = Int32Array.from(inside);
  }

  /** Sample the whole scan at once (used when starting a new day). */
  fullScan(f: Fields, w: Weather): void {
    for (const b of this.buckets) this.sampleBucket(b, f, w);
  }

  /** Rotate the beam by `deg` degrees, sampling everything it passes. */
  sweep(deg: number, f: Fields, w: Weather): void {
    if (!(deg > 0)) return; // ignore zero, negative or NaN steps
    const a0 = Math.floor((this.azimuth / 360) * BUCKETS);
    const a1 = Math.floor(((this.azimuth + deg) / 360) * BUCKETS);
    const count = Math.min(BUCKETS, a1 - a0);
    for (let n = 1; n <= count; n++) this.sampleBucket(this.buckets[(a0 + n) % BUCKETS], f, w);
    this.azimuth = (((this.azimuth + deg) % 360) + 360) % 360;
  }

  private sampleBucket(b: Int32Array, f: Fields, w: Weather): void {
    // Environmental wind in m/s; it gets stronger with height, and the beam climbs with range.
    const envU = w.windX * (1000 / 60);
    const envV = w.windY * (1000 / 60);
    for (let n = 0; n < b.length; n++) {
      const idx = b[n];
      const z = f.z[idx];
      const r = this.range[idx];
      let raw = z > 0 ? 10 * Math.log10(z) - r * 0.015 : NO_ECHO;
      // Overlapping cores add up; squash the very top end so 75+ dBZ stays rare (giant hail!).
      if (raw > 62) raw = 62 + (raw - 62) * 0.45;
      this.speckle = (this.speckle * 1103515245 + 12345) & 0x7fffffff;
      const jitter = (this.speckle / 0x7fffffff - 0.5) * 2;
      if (raw < 0) {
        this.dbz[idx] = NO_ECHO;
        this.vel[idx] = NaN;
        this.tops[idx] = 0;
        continue;
      }
      this.dbz[idx] = raw + jitter;
      const isClutter = f.clutter[idx] > 0 && f.clutter[idx] >= z * 0.5;
      if (isClutter) {
        this.vel[idx] = jitter * 2;
      } else {
        const k = 0.7 + r / 350;
        const vr = (envU * k + f.u[idx]) * this.ex[idx] + (envV * k + f.v[idx]) * this.ey[idx];
        this.vel[idx] = vr * MS_TO_KT + jitter * 2.5;
      }
      this.tops[idx] = raw >= 18 && !isClutter ? f.top[idx] : 0;
    }
  }

  /** Paint the current product into the scope's offscreen canvas. */
  paint(mode: Mode): void {
    const px = this.pixels;
    const lut = this.luts[mode];
    const scale = MODES[mode].scale;
    const ins = this.inside;
    const lo = scale.min;
    const k = 1023 / (scale.max - scale.min);
    for (let n = 0; n < ins.length; n++) {
      const idx = ins[n];
      let c = 0;
      if (mode === 'ref') {
        const d = this.dbz[idx];
        if (d >= REFLECTIVITY.floor) c = lut[clampIdx((d - lo) * k)];
      } else if (mode === 'vel') {
        const v = this.vel[idx];
        if (v === v) c = lut[clampIdx((v - lo) * k)];
      } else {
        const t = this.tops[idx];
        if (t >= ECHO_TOPS.floor) c = lut[clampIdx((t - lo) * k)];
      }
      px[idx] = c;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** Value under a world position (km), for the cursor readout. */
  valueAt(mode: Mode, x: number, y: number): number | null {
    const i = Math.floor((x + RANGE_KM) / KM_PER_PX);
    const j = Math.floor((RANGE_KM - y) / KM_PER_PX);
    if (i < 0 || j < 0 || i >= GRID || j >= GRID || Math.hypot(x, y) > RANGE_KM) return null;
    const idx = j * GRID + i;
    if (mode === 'ref') return this.dbz[idx] >= REFLECTIVITY.floor ? this.dbz[idx] : null;
    if (mode === 'vel') return this.vel[idx] === this.vel[idx] ? this.vel[idx] : null;
    return this.tops[idx] >= ECHO_TOPS.floor ? this.tops[idx] : null;
  }
}

function clampIdx(k: number): number {
  return k < 0 ? 0 : k > 1023 ? 1023 : k | 0;
}
