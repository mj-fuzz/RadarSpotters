import { NoiseTex } from './noise';
import { Rng } from './rng';
import { cellShape, partEnvelope, smoothstep, type StormCell, type Weather } from './weather';

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

/** A cyclonic "twirl" applied to a storm's rain field (hook echoes, bookend vortices). */
interface Swirl {
  x: number;
  y: number;
  /** Strongest twist (radians) at the centre. */
  turn: number;
  /** Size of the twirl, km. */
  size: number;
}

/**
 * The "true" atmosphere on a grid: what the radar would see if it looked
 * everywhere at once. The scope samples this once per volume scan.
 */
export class Fields {
  /** Linear reflectivity factor Z (sum of every cell's contribution). */
  readonly z = new Float32Array(GRID * GRID);
  /** Storm-made wind (outflow, mesocyclones, tornadoes, bow jets) on top of the environment, m/s. */
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

  private splat(c: StormCell): void {
    const s = cellShape(c);
    const noise = this.noise;
    const { a, b, dirX, dirY, rightX, rightY, peak, strat, meso, mesoX, mesoY, topNow, t } = s;
    const isBow = c.kind === 'bow';
    const L = s.bowL;
    const A = s.bowAmt;

    const ext = isBow ? L * 1.3 + 60 : a * 5 + 12;
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

    // How developed the supercell's rotation is (ignores the strengthen/weaken cycle).
    const hookFrac = c.rot > 0 ? smoothstep((t - 0.12) / 0.2) * (1 - smoothstep((t - 0.82) / 0.15)) : 0;
    const cycle = hookFrac > 0 ? meso / (c.rot * hookFrac) : 0;
    const swirls: Swirl[] = [];
    if (hookFrac > 0) {
      // The rain behind the storm gets dragged around the mesocyclone into a hook.
      swirls.push({ x: mesoX, y: mesoY, turn: 2.7 * hookFrac * (0.55 + 0.45 * cycle), size: 0.6 * b });
    }
    if (isBow) {
      // Bookend vortex: the north (left) end of a bow curls up into a comma head.
      const fu = A * L * 0.9 * (1 - 0.95 * 0.95) - A * L * 0.45;
      swirls.push({
        x: c.x + dirX * fu - rightX * 0.95 * L,
        y: c.y + dirY * fu - rightY * 0.95 * L,
        turn: 2.8 * A,
        size: 0.35 * L,
      });
    }

    // Outflow: inflow while growing, pushing out once the downdraft takes over.
    const outflow = isBow
      ? 0
      : (c.kind === 'single' ? 9 : 15) * smoothstep((t - 0.35) / 0.3) * (1 - 0.5 * smoothstep((t - 0.85) / 0.15)) -
        4 * (t < 0.35 ? s.strength : 0);
    const ro = b * 0.9;
    const mesoRc = 3;

    // Gust front: a thin line of light echo racing out ahead of strong storms.
    const gustOn = isBow
      ? smoothstep((t - 0.2) / 0.15)
      : c.kind === 'single' || c.peakDbz < 50
        ? 0
        : smoothstep((t - 0.45) / 0.15);
    const gustR = isBow ? 5 + 10 * smoothstep((t - 0.25) / 0.5) : b * (1.4 + 1.8 * smoothstep((t - 0.4) / 0.5));

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
      for (let i = i0; i <= i1; i++) {
        const x = pxToX(i);
        const idx = j * GRID + i;

        // Raw storm-relative position (for winds and the gust front).
        const rdx = x - c.x;
        const rdy = y - c.y;
        const u0 = rdx * dirX + rdy * dirY;

        // Twirled position for the rain field.
        let px = x;
        let py = y;
        for (const sw of swirls) {
          const mx = px - sw.x;
          const my = py - sw.y;
          const q = (mx * mx + my * my) / (sw.size * sw.size);
          if (q < 9) {
            const th = sw.turn * Math.exp(-q);
            const cs = Math.cos(th);
            const sn = Math.sin(th);
            px = sw.x + mx * cs + my * sn;
            py = sw.y - mx * sn + my * cs;
          }
        }
        const dx = px - c.x;
        const dy = py - c.y;
        const u = dx * dirX + dy * dirY;
        const v = dx * rightX + dy * rightY;

        const n1 = noise.sample(dx * 0.32 + c.seedX + evolve, dy * 0.32 + c.seedY);
        const n2 = noise.sample(dx * 0.85 + c.seedY - evolve * 1.3, dy * 0.85 + c.seedX);
        const n3 = noise.sample(dx * 2.2 + c.seedX * 1.7 + evolve * 2.2, dy * 2.2 - c.seedY);
        const warp = Math.max(0.65, 1 + (n1 - 0.5) * 1.5 + (n3 - 0.5) * 0.45);

        let zAdd = 0;
        let minD2 = 99;
        let topVal = 0;
        let jetU = 0;

        if (isBow) {
          // ---- Bow echo -------------------------------------------------------
          const vn = v / L;
          // The line bulges forward in the middle; past the ends it just carries on straight.
          const vc = Math.max(-1, Math.min(1, vn));
          const front = A * L * 0.9 * (1 - vc * vc) - A * L * 0.45;
          const dl = u - front; // + ahead of the line, - behind it
          const endF = 1 - smoothstep((Math.abs(vn) - 0.8) / 0.35);
          // Lumpy along its length: a chain of cores rather than a smooth tube.
          const lumps = noise.sample(v * 1.1 + c.seedX, c.seedY + evolve * 0.4);
          const w = (dl > 0 ? 2.4 : 9) * (0.55 + lumps * 0.9) * (1 + (n2 - 0.5) * 0.7);
          const apex = 4 * Math.max(0, 1 - vn * vn);
          const dbzLine =
            peak - 8 + apex + (lumps - 0.5) * 40 - 24 * (dl / w) * (dl / w) + (n1 - 0.5) * 16 + (n2 - 0.5) * 12 + (n3 - 0.5) * 9 - (1 - endF) * 90;
          if (dbzLine > 0) zAdd += zOf(dbzLine);

          // Trailing rain shield, with a rear-inflow notch behind the apex.
          const sd = -dl;
          if (sd > 4) {
            const nv = vn / 0.28;
            const ns = (sd - 16) / 9;
            const notch = 24 * A * Math.exp(-nv * nv) * Math.exp(-ns * ns);
            const g = (sd - 26) / 22;
            const gS = g * g + vn * vn * 1.3;
            const dbzS = 20 + 14 * strat - 16 * gS - notch + (n1 - 0.5) * 22 + (n2 - 0.5) * 10 + (n3 - 0.5) * 8;
            if (dbzS > 0) zAdd += zOf(dbzS);
            if (sd < 55 && endF > 0.3) topVal = Math.max(topVal, 24 + 6 * strat);
          }
          const endD = Math.max(0, Math.abs(vn) - 0.85) * L;
          const hd = dl / (dl > 0 ? 7 : 16);
          minD2 = hd * hd + (endD / 10) * (endD / 10);
          const bw = dl / (w * 1.8);
          const band = 1 - bw * bw;
          if (band > 0) topVal = Math.max(topVal, topNow * band * endF);

          // Gust front ahead of the bow.
          if (gustOn > 0 && Math.abs(vn) < 1.15) {
            const gd = (dl - gustR * (1 + (n1 - 0.5) * 0.25)) / 1.1;
            const dbzG = 14 * gustOn - 9 * gd * gd + (n3 - 0.5) * 14 - Math.max(0, Math.abs(vn) - 0.85) * 150;
            if (dbzG > 0) zAdd += zOf(dbzG);
          }

          // Rear-inflow jet: the damaging wind that pushes the bow out.
          const jb = (dl + 8) / 10;
          const jv = vn / 0.65;
          const ja = dl / 4;
          jetU = 34 * s.strength * (0.3 + A) * Math.exp(-jb * jb) * Math.exp(-jv * jv) * (dl > 0 ? Math.exp(-ja * ja) : 1);
        } else {
          // ---- Cells built from parts -----------------------------------------
          for (let k = 0; k < c.parts.length; k++) {
            const p = c.parts[k];
            const pe = partEnvelope(p);
            if (pe < 0.02) continue;
            const main = k === 0 && !Number.isFinite(p.life) && c.kind !== 'multi';
            const pu = p.u * b;
            const pv = p.v * b;
            const rx = main ? a : p.r * b;
            const ry = main ? b : p.r * b;
            const du = u - pu;
            const dv = v - pv;
            const au = du > 0 ? rx * 0.85 : rx * 1.2;
            let d2 = ((du * du) / (au * au) + (dv * dv) / (ry * ry)) * warp * warp;
            // Supercells: the inflow notch on the right side, ahead of the hook.
            if (main && hookFrac > 0 && v > 0.3 * b && u > -0.5 * a) {
              d2 *= 1 + 1.3 * hookFrac * smoothstep((v - 0.3 * b) / (0.6 * b));
            }
            const dbzP = 12 + (peak - 12) * pe + p.amp - 27 * d2 + (n2 - 0.5) * 12 + (n3 - 0.5) * 7;
            if (dbzP > 0) zAdd += zOf(dbzP);
            const dd = d2 / Math.max(0.3, pe);
            if (dd < minD2) minD2 = dd;
          }

          if (hookFrac > 0) {
            // Rear-flank rain: trails back from the core past the meso; the twirl turns it into a hook.
            const ru = (u + 0.95 * a) / (0.9 * a);
            const rv = (v - 0.6 * b) / (0.33 * b);
            const d2r = (ru * ru + rv * rv) * warp;
            const dbzR = peak - 6 - 22 * d2r - (1 - hookFrac) * 25 + (n2 - 0.5) * 12 + (n3 - 0.5) * 8;
            if (dbzR > 0) zAdd += zOf(dbzR);
            // Forward flank: a broad shield of rain and hail spreading downstream and to the left.
            const fu = u - 1.3 * a;
            const fv = v + 0.35 * b;
            const d2f = ((fu * fu) / (4 * a * a) + (fv * fv) / (1.3 * b * b)) * warp * warp;
            const dbzF = peak - 14 - 22 * d2f + (n2 - 0.5) * 12 - (1 - hookFrac) * 20;
            if (dbzF > 0) zAdd += zOf(dbzF);
            minD2 = Math.min(minD2, d2f * 1.3, d2r);
          }

          // Trailing stratiform rain.
          if (strat > 0.02) {
            const su = u + 1.4 * a;
            const sw = Math.max(0.7, 1 + (n2 - 0.5) * 0.9);
            const d2s = ((su * su) / (stratA * stratA) + (v * v) / (stratB * stratB)) * sw * sw;
            const dbzS = stratPeak - 20 * d2s + (n1 - 0.5) * 12;
            if (dbzS > 0) zAdd += zOf(dbzS);
            if (d2s < 1) topVal = Math.max(topVal, stratTop * (1 - 0.35 * d2s));
          }

          // Echo tops: a dome over the cores.
          const dTop = Math.sqrt(minD2) / 1.2;
          if (dTop < 1) topVal = Math.max(topVal, topNow * Math.sqrt(1 - dTop * dTop) * (0.94 + (n2 - 0.5) * 0.12));

          // Gust front arc out ahead.
          if (gustOn > 0) {
            const r = Math.hypot(rdx, rdy) + 1e-3;
            const cosA = u0 / r;
            if (cosA > 0) {
              const gd = (r - gustR * (1 + (n1 - 0.5) * 0.25)) / 1.1;
              const dbzG = 13 * gustOn - 9 * gd * gd + (n3 - 0.5) * 14 - (1 - smoothstep((cosA - 0.35) / 0.4)) * 30;
              if (dbzG > 0) zAdd += zOf(dbzG);
            }
          }
        }

        // Patchy light-rain halo so the edges are ragged instead of a neat ring.
        const d2h = minD2 / 3.6;
        const dbzHalo = 6 + 13 * s.strength - 20 * d2h + (n1 - 0.5) * 26 + (n3 - 0.5) * 14;
        if (dbzHalo > 0) zAdd += zOf(dbzHalo);

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

        // Fade out softly before the edge of this cell's drawing box (no straight cut-off edges).
        const edge = 1 - Math.max(Math.abs(rdx), Math.abs(rdy)) / ext;
        const fade = edge < 0.2 ? smoothstep(edge / 0.2) : 1;
        if (zAdd > 0) this.z[idx] += zAdd * fade;
        if (topVal * fade > this.top[idx]) this.top[idx] = topVal * fade;

        // ---- Winds --------------------------------------------------------------
        const turb = 7 * s.strength * Math.max(0, 1 - minD2 / 6) * fade;
        let wu = (n2 - 0.5) * turb + jetU * dirX * fade;
        let wv = (n3 - 0.5) * turb + jetU * dirY * fade;
        const r = Math.hypot(rdx, rdy) + 1e-3;
        const q = r / ro;
        if (outflow !== 0 && q < 3.5) {
          const rad = outflow * q * Math.exp(0.5 * (1 - q * q)) * fade;
          wu += (rad * rdx) / r;
          wv += (rad * rdy) / r;
        }
        if (meso > 0) {
          const mdx = x - mesoX;
          const mdy = y - mesoY;
          const mr = Math.hypot(mdx, mdy);
          if (mr < mesoRc * 5) {
            const vt = rankine(mr, mesoRc, meso, 4);
            wu += (-vt * mdy) / (mr + 1e-3);
            wv += (vt * mdx) / (mr + 1e-3);
          }
        }
        if (tor && tr < 4) {
          const vt = rankine(tr, 0.6, torV, 5);
          wu += (-vt * tdy) / (tr + 1e-3);
          wv += (vt * tdx) / (tr + 1e-3);
        }
        this.u[idx] += wu;
        this.v[idx] += wv;
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
