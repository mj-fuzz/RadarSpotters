import { NoiseTex } from './noise';
import { Rng } from './rng';
import { cellShape, mesoCycle, partEnvelope, smoothstep, type StormCell, type Weather } from './weather';

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

    const ext = isBow ? L * 1.3 + 90 : a * 5 + 12;
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

    // The hook is the sign of a supercell at full strength: it only forms once the storm is
    // really cranking, fades whenever the mesocyclone weakens (recycles), and is gone well
    // before the storm itself dies. Rotation in velocity shows up earlier than the hook.
    const hookFrac =
      c.rot > 0
        ? smoothstep((t - 0.3) / 0.15) * (1 - smoothstep((t - 0.62) / 0.13)) * smoothstep((mesoCycle(c) - 0.45) / 0.35)
        : 0;
    const swirls: Swirl[] = [];
    if (hookFrac > 0.01) {
      // The rain behind the storm gets dragged around the mesocyclone into a hook.
      swirls.push({ x: mesoX, y: mesoY, turn: 2.7 * hookFrac, size: 0.6 * b });
    }
    if (isBow) {
      // Bookend vortex: the north (left) end of a bow curls up into a comma head.
      const fu = A * L * 1.2 * (1 - 0.95 * 0.95) - A * L * 0.6;
      swirls.push({
        x: c.x + dirX * fu - rightX * 0.95 * L,
        y: c.y + dirY * fu - rightY * 0.95 * L,
        turn: 2.8 * A,
        size: 0.35 * L,
      });
      // The south (right) end spins the other way and breaks into separate cells.
      swirls.push({
        x: c.x + dirX * fu + rightX * 0.95 * L,
        y: c.y + dirY * fu + rightY * 0.95 * L,
        turn: -1.3 * A,
        size: 0.25 * L,
      });
    }
    // Everything fades away over the last part of a storm's life (no vanishing in one scan).
    const deathDb = 45 * smoothstep((t - 0.78) / 0.22);
    const deathZ = Math.exp(-deathDb * LN10_10);
    const deathTop = 1 - smoothstep((t - 0.8) / 0.2);

    // Outflow: inflow while growing, pushing out once the downdraft takes over.
    const outflow = isBow
      ? 0
      : (c.kind === 'single' ? 6 : 10) * smoothstep((t - 0.35) / 0.3) * (1 - 0.5 * smoothstep((t - 0.85) / 0.15)) -
        4 * (t < 0.35 ? s.strength : 0);
    const ro = b * 0.9;
    const mesoRc = 3;

    // Gust front: a thin line of light echo racing out ahead of strong storms.
    const gustOn = isBow
      ? smoothstep((t - 0.2) / 0.15)
      : c.kind === 'single' || c.peakDbz < 50
        ? 0
        : smoothstep((t - 0.45) / 0.15);
    const gustR = isBow ? 2.5 + 3.5 * smoothstep((t - 0.25) / 0.5) : b * (1.4 + 1.8 * smoothstep((t - 0.4) / 0.5));
    // Bows: how far back the trailing rain shield reaches (it grows as the system matures).
    const shieldDepth = 25 + 45 * smoothstep((t - 0.1) / 0.5);
    const shieldStr = smoothstep((t - 0.05) / 0.35);

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
          // The leading edge wobbles: bulges where cores surge ahead, dents in between.
          const wobble = (noise.sample(v * 0.35 + c.seedY, c.seedX + evolve * 0.25) - 0.5) * 14 + (n1 - 0.5) * 4;
          const front = A * L * 1.2 * (1 - vc * vc) - A * L * 0.6 + wobble;
          const dl = u - front; // + ahead of the line, - behind it
          const endF = 1 - smoothstep((Math.abs(vn) - (vn < 0 ? 0.85 : 0.95)) / 0.3);
          // Big lumps and small cells along the line: a chain of storms, not a smooth tube.
          const lumps = noise.sample(v * 1.1 + c.seedX, c.seedY + evolve * 0.4);
          const cellsN = noise.sample(v * 2.8 + c.seedY, dl * 0.6 + c.seedX - evolve * 0.7);
          // The south end breaks up into separate cells as the bow matures.
          const broken = smoothstep((vn - 0.3) / 0.5) * Math.min(1, A * 2);
          const brk = broken * Math.max(0, 0.62 - cellsN) * 90;

          // Convective line: razor-sharp leading edge, ~10 km of heavy cores behind it.
          const w = dl > 0 ? 3 * (0.6 + lumps) : 13 * (0.45 + lumps) * (1 + (n2 - 0.5) * 0.6);
          const apex = 4 * Math.max(0, 1 - vn * vn);
          const lineBase = -22 * (dl / w) * (dl / w) + (n2 - 0.5) * 10 + (n3 - 0.5) * 8 - brk - (1 - endF) * 90;
          const dbzLine = peak - 8 + apex + (lumps - 0.5) * 16 + (cellsN - 0.5) * 10 + lineBase;
          if (dbzLine > 0) zAdd += zOf(dbzLine);
          // Individual storm cores strung along the line, each with its own strength.
          const k0 = Math.floor(v / CORE_SPACING);
          for (let k = k0 - 1; k <= k0 + 1; k++) {
            const h1 = hash(k, c.id);
            const h2 = hash(k + 7919, c.id);
            const h3 = hash(k - 104729, c.id);
            const cv = (k + h1) * CORE_SPACING;
            const cu = 1 - 7 * h2; // around the leading edge, some surging ahead
            const rr = 3.5 + 5 * h3;
            const ev = (v - cv) / (rr * 1.9);
            const eu = (dl - cu) / rr;
            // Cores slowly strengthen and weaken with time.
            const pulse = Math.sin(c.age * 0.12 + h2 * 6.283);
            const dbzC = peak - 4 + (h3 - 0.5) * 14 + pulse * 5 + apex - 14 * (ev * ev + eu * eu) - brk - (1 - endF) * 90 + (n3 - 0.5) * 8;
            if (dbzC > 0) zAdd += zOf(dbzC);
          }

          // Trailing rain shield: a big area of moderate rain, a quieter "transition zone"
          // just behind the line, and a rear-inflow notch behind the apex.
          const sd = -dl;
          if (sd > 2 && shieldStr > 0) {
            const g = (sd - shieldDepth * 0.55) / (shieldDepth * 0.55);
            const lat = vn / 1.05;
            const gS = g * g + lat * lat * lat * lat;
            const tz = (sd - 13) / 6;
            const trans = 6 * Math.exp(-tz * tz);
            const nv = vn / 0.3;
            const ns = (sd - 12) / 8;
            const notch = 22 * A * Math.exp(-nv * nv) * Math.exp(-ns * ns);
            const dbzS =
              18 + 24 * shieldStr - 14 * gS - trans - notch - broken * 12 + (n1 - 0.5) * 18 + (n2 - 0.5) * 12 + (n3 - 0.5) * 8;
            if (dbzS > 0) zAdd += zOf(dbzS);
            if (gS < 1) topVal = Math.max(topVal, (24 + 10 * shieldStr) * (1 - 0.3 * gS));
          }
          const endD = Math.max(0, Math.abs(vn) - 0.9) * L;
          const hd = dl > 0 ? dl / 5 : Math.max(0, sd - shieldDepth) / 12;
          minD2 = hd * hd + (endD / 10) * (endD / 10);
          const bw = dl / (w * 1.8);
          const band = 1 - bw * bw;
          if (band > 0) topVal = Math.max(topVal, topNow * band * endF * (1 - broken * 0.3));

          // Gust front hugging the leading edge.
          if (gustOn > 0 && Math.abs(vn) < 1.05) {
            const gd = (dl - gustR * (1 + (n1 - 0.5) * 0.3)) / 0.9;
            const dbzG = 18 * gustOn - 10 * gd * gd + (n3 - 0.5) * 12 - Math.max(0, Math.abs(vn) - 0.85) * 150;
            if (dbzG > 0) zAdd += zOf(dbzG);
          }

          // Damaging straight-line winds: the rear-inflow jet comes down and surges out
          // along the whole leading edge, strongest behind the apex.
          const jb = (dl + 4) / 9;
          const jv = vn / 0.85;
          const ja = (dl - gustR) / 2.5;
          jetU =
            44 * s.strength * (0.4 + A) * Math.exp(-jb * jb) * Math.exp(-jv * jv) * (dl > gustR ? Math.exp(-ja * ja) : 1) * endF;
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
        if (zAdd > 0) this.z[idx] += zAdd * fade * deathZ;
        topVal *= fade * deathTop;
        if (topVal > this.top[idx]) this.top[idx] = topVal;

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

/** Spacing of the storm cores along a bow echo's line, km. */
const CORE_SPACING = 11;

/** Repeatable pseudo-random number 0..1 for an integer pair. */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Rankine vortex tangential wind, tapered so it fades out far from the centre. */
function rankine(r: number, rc: number, vmax: number, taper: number): number {
  const inner = r < rc ? r / rc : rc / r;
  const k = r / (taper * rc);
  return vmax * inner * Math.exp(-k * k);
}
