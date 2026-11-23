import { Rng } from './rng';

const SIZE = 256;
const MASK = SIZE - 1;

/**
 * Tileable fractal value-noise texture. Storms sample it to get ragged,
 * natural-looking edges and texture instead of perfect blobs.
 */
export class NoiseTex {
  readonly data = new Float32Array(SIZE * SIZE);

  constructor(rng: Rng) {
    let amp = 1;
    let total = 0;
    for (let freq = 4; freq <= 128; freq *= 2) {
      const grid = new Float32Array(freq * freq);
      for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
      const cell = SIZE / freq;
      for (let y = 0; y < SIZE; y++) {
        const gy = y / cell;
        const y0 = Math.floor(gy);
        const fy = smooth(gy - y0);
        const y1 = (y0 + 1) % freq;
        for (let x = 0; x < SIZE; x++) {
          const gx = x / cell;
          const x0 = Math.floor(gx);
          const fx = smooth(gx - x0);
          const x1 = (x0 + 1) % freq;
          const a = grid[y0 * freq + x0];
          const b = grid[y0 * freq + x1];
          const c = grid[y1 * freq + x0];
          const d = grid[y1 * freq + x1];
          this.data[y * SIZE + x] += amp * (a + (b - a) * fx + (c - a + (a - b + d - c) * fx) * fy);
        }
      }
      total += amp;
      amp *= 0.55;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of this.data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    for (let i = 0; i < this.data.length; i++) this.data[i] = (this.data[i] - min) / (max - min);
    void total;
  }

  /** Bilinear sample, wrapping. Returns 0..1. Coordinates are in texels. */
  sample(x: number, y: number): number {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const x0 = xf & MASK;
    const y0 = yf & MASK;
    const x1 = (x0 + 1) & MASK;
    const y1 = (y0 + 1) & MASK;
    const d = this.data;
    const a = d[y0 * SIZE + x0];
    const b = d[y0 * SIZE + x1];
    const c = d[y1 * SIZE + x0];
    const e = d[y1 * SIZE + x1];
    const top = a + (b - a) * fx;
    const bot = c + (e - c) * fx;
    return top + (bot - top) * fy;
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
