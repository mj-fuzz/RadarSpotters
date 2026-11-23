import { NoiseTex } from './noise';
import { Rng } from './rng';
import { cellShape, smoothstep, type Weather } from './weather';

/** Radar range, km. The grid covers a square of +/- RANGE_KM around the radar. */
export const RANGE_KM = 230;
/** Grid resolution (pixels per side). */
export const GRID = 512;
export const KM_PER_PX = (2 * RANGE_KM) / GRID;

const LN10_10 = Math.LN10 / 10;
/** dBZ -> linear reflectivity factor Z. */
const zOf = (dbz: number) => Math.exp(dbz * LN10_10);

export function pxToX(i: number): number {
  return -RANGE_KM + (i + 0.5) * KM_PER_PX;
}
export function pxToY(j: number): number {
  return RANGE_KM - (j + 0.5) * KM_PER_PX;
}

/**
 * The "true" atmosphere on a grid: what the radar would see if it looked
 * everywhere at once. The scope samples this as the beam sweeps around.
 */
export class Fields {
  /** Linear reflectivity factor Z (sum of every cell's contribution). */
  readonly z = new Float32Array(GRID * GRID);
  /** Storm-made wind (outflow, mesocyclones, tornadoes) on top of the environment, m/s. */
  readonly u = new Float32Array(GRID * GRID);
  readonly v = new Float32Array(GRID * GRID);
  /** Echo top, kft. */
  readonly top = new Float32Array(GRID * GRID);
  /** Ground clutter close to the radar (linear Z). Fixed for a given radar site. */
  readonly clutter = new Float32Array(GRID * GRID);

  constructor(
    readonly noise: NoiseTex,
    seed: number,
  ) {
    const r = new Rng(seed ^ 0x51ab);
    for (let n = 0; n < 140; n++) {
      const ang = r.range(0, Math.PI * 2);
      const dist = 2 + Math.pow(r.next(), 2) * 30;
      const i = Math.floor((Math.sin(ang) * dist + RANGE_KM) / KM_PER_PX);
      const j = Math.floor((RANGE_KM - Math.cos(ang) * dist) / KM_PER_PX);
      if (i >= 0 && j >= 0 && i < GRID && j < GRID) this.clutter[j * GRID + i] = zOf(r.range(12, 45));
    }
  }

  compute(w: Weather): void {
    this.z.set(this.clutter);
    this.u.fill(0);
    this.v.fill(0);
    this.top.fill(0);
    for (const c of w.cells) this.splat(c);
  }

  private splat(c: Weather['cells'][number]): void {
    const s = cellShape(c);
    const noise = this.noise;
    const { a, b, dirX, dirY, rightX, rightY, peak, strat, meso, mesoX, mesoY, topNow, t } = s;
    const ext = a * 4 + 8;
    const i0 = Math.max(0, Math.floor((c.x - ext + RANGE_KM) / KM_PER_PX));
    const i1 = Math.min(GRID - 1, Math.ceil((c.x + ext + RANGE_KM) / KM_PER_PX));
    const j0 = Math.max(0, Math.floor((RANGE_KM - (c.y + ext)) / KM_PER_PX));
    const j1 = Math.min(GRID - 1, Math.ceil((RANGE_KM - (c.y - ext)) / KM_PER_PX));
    if (i0 > i1 || j0 > j1) return;

    const evolve = c.age * 0.5;
    const stratPeak = 14 + 18 * strat;
    const stratA = a * 2.4;
    const stratB = b * 1.9;
    const stratTop = 20 + 9 * strat;

    // Outflow: inflow while growing, pushing out once the downdraft takes over.
    const outflow =
      (c.kind === 'single' ? 9 : 15) * smoothstep((t - 0.35) / 0.3) * (1 - 0.5 * smoothstep((t - 0.85) / 0.15)) -
      4 * (t < 0.35 ? s.strength : 0);
    const ro = b * 0.9;

    // Hook echo wraps cyclonically around the mesocyclone.
    const mesoFrac = c.rot > 0 ? meso / c.rot : 0;
    const hookStart = Math.atan2(c.y - mesoY, c.x - mesoX);
    const hookR = 0.45 * b + 1;
    const mesoRc = 3.5;

    const tor = c.tornado;
    let torX = 0;
    let torY = 0;
    let torV = 0;
    if (tor) {
      torX = mesoX + tor.ox;
      torY = mesoY + tor.oy;
      torV = tor.vmax * smoothstep(tor.age / 1.5) * (1 - smoothstep((tor.age - (tor.life - 2.5)) / 2.5));
    }

    for (let j = j0; j <= j1; j++) {
      const y = pxToY(j);
      const dy = y - c.y;
      for (let i = i0; i <= i1; i++) {
        const x = pxToX(i);
        const dx = x - c.x;
        const idx = j * GRID + i;
        const u = dx * dirX + dy * dirY;
        const v = dx * rightX + dy * rightY;

        const n1 = noise.sample(dx * 0.32 + c.seedX + evolve, dy * 0.32 + c.seedY);
        const n2 = noise.sample(dx * 0.85 + c.seedY - evolve * 1.3, dy * 0.85 + c.seedX);
        const n3 = noise.sample(dx * 2.2 + c.seedX * 1.7 + evolve * 2.2, dy * 2.2 - c.seedY);
        const warp = 1 + (n1 - 0.5) * 1.5 + (n3 - 0.5) * 0.45;

        let zAdd = 0;

        // Convective core: sharper on the leading edge, softer behind.
        const au = u > 0 ? a * 0.85 : a * 1.2;
        let d2 = ((u * u) / (au * au) + (v * v) / (b * b)) * warp * warp;
        // Supercells: the inflow notch on the rear-right side, where the hook wraps in.
        if (mesoFrac > 0 && u < 0.2 * a && v > 0) d2 *= 1 + 0.9 * mesoFrac * Math.min(1, v / b);
        const dbzCore = peak - 27 * d2 + (n2 - 0.5) * 12 + (n3 - 0.5) * 7;
        if (dbzCore > 0) zAdd += zOf(dbzCore);

        // Patchy light-rain halo so the edges are ragged instead of a neat ring.
        const d2h = d2 / 3.6;
        const dbzHalo = 6 + 13 * s.strength - 20 * d2h + (n1 - 0.5) * 26 + (n3 - 0.5) * 14;
        if (dbzHalo > 0) zAdd += zOf(dbzHalo);

        // Trailing stratiform rain.
        let d2s = 99;
        if (strat > 0.02) {
          const su = u + 1.4 * a;
          const sw = 1 + (n2 - 0.5) * 0.9;
          d2s = ((su * su) / (stratA * stratA) + (v * v) / (stratB * stratB)) * sw * sw;
          const dbzS = stratPeak - 20 * d2s + (n1 - 0.5) * 12;
          if (dbzS > 0) zAdd += zOf(dbzS);
        }

        // Supercell hook echo.
        let mdx = 0;
        let mdy = 0;
        let mr = 99;
        if (meso > 0) {
          mdx = x - mesoX;
          mdy = y - mesoY;
          mr = Math.hypot(mdx, mdy);
          if (mr < hookR * 2.5) {
            let dAng = Math.atan2(mdy, mdx) - hookStart;
            dAng = ((dAng % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const span = 3.7;
            if (dAng < span) {
              const along = dAng / span;
              const ringR = hookR * (1 - 0.35 * along);
              const wdt = 1.8 * (1 - 0.5 * along);
              const off = (mr - ringR) / wdt;
              const dbzH = peak - 8 - 22 * along - 14 * off * off - (1 - mesoFrac) * 35 + (n2 - 0.5) * 6;
              if (dbzH > 0) zAdd += zOf(dbzH);
            }
          }
        }

        // Tornado debris ball.
        let tr = 99;
        let tdx = 0;
        let tdy = 0;
        if (tor) {
          tdx = x - torX;
          tdy = y - torY;
          tr = Math.hypot(tdx, tdy);
          if (torV > 45 && tr < 2) zAdd += zOf(50 + (torV - 45) * 0.4 - tr * 6);
        }

        if (zAdd > 0) this.z[idx] += zAdd;

        // Echo tops.
        const dTop = Math.sqrt(d2) / 1.2;
        let topVal = dTop < 1 ? topNow * Math.sqrt(1 - dTop * dTop) * (0.94 + (n2 - 0.5) * 0.12) : 0;
        if (d2s < 1) topVal = Math.max(topVal, stratTop * (1 - 0.35 * d2s));
        if (topVal > this.top[idx]) this.top[idx] = topVal;

        // Winds: a bit of turbulence inside the storm, then the organised flows.
        const turb = 7 * s.strength * Math.max(0, 1 - d2 / 6);
        this.u[idx] += (n2 - 0.5) * turb;
        this.v[idx] += (n3 - 0.5) * turb;
        const r = Math.hypot(dx, dy) + 1e-3;
        const q = r / ro;
        if (q < 3.5) {
          const rad = outflow * q * Math.exp(0.5 * (1 - q * q));
          this.u[idx] += (rad * dx) / r;
          this.v[idx] += (rad * dy) / r;
        }
        if (meso > 0 && mr < mesoRc * 5) {
          const vt = rankine(mr, mesoRc, meso, 4);
          this.u[idx] += (-vt * mdy) / (mr + 1e-3);
          this.v[idx] += (vt * mdx) / (mr + 1e-3);
        }
        if (tor && tr < 4) {
          const vt = rankine(tr, 0.6, torV, 5);
          this.u[idx] += (-vt * tdy) / (tr + 1e-3);
          this.v[idx] += (vt * tdx) / (tr + 1e-3);
        }
      }
    }
  }
}

/** Rankine vortex tangential wind, tapered so it fades out far from the centre. */
function rankine(r: number, rc: number, vmax: number, taper: number): number {
  const inner = r < rc ? r / rc : rc / r;
  const k = r / (taper * rc);
  return vmax * inner * Math.exp(-k * k);
}
