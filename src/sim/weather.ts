import { Rng } from './rng';

/**
 * The storm engine. Storm cells are born, grow, mature, and fall apart while
 * the steering winds push them across the map. All times are in GAME minutes,
 * all distances in kilometres. x points east, y points north, the radar sits at (0, 0).
 *
 * Storm types:
 *  - single: a lone pop-up shower or thunderstorm
 *  - multi:  a cluster; new updrafts ("parts") keep bubbling up on its leading flank
 *  - super:  a rotating supercell with a mesocyclone, hook echo, and maybe a tornado
 *  - bow:    a line of storms bowed out by a rush of wind (damaging straight-line winds)
 */

export type CellKind = 'single' | 'multi' | 'super' | 'bow';

export interface Tornado {
  age: number;
  life: number;
  /** Peak rotational wind, m/s. */
  vmax: number;
  /** Wobble offset from the mesocyclone centre, km. */
  ox: number;
  oy: number;
}

/**
 * One updraft/precipitation core inside a storm. Positions and size are in units
 * of the storm's radius `b`, measured along (u) and to the right of (v) its motion.
 */
export interface Part {
  u: number;
  v: number;
  r: number;
  /** Strength relative to the storm's peak, dB. */
  amp: number;
  age: number;
  /** Infinity = lives as long as the storm. */
  life: number;
  /** Drift relative to the storm, radius units per minute (old cells fall to the back). */
  du: number;
}

export interface StormCell {
  id: number;
  kind: CellKind;
  x: number;
  y: number;
  /** Motion, km per game minute. */
  vx: number;
  vy: number;
  age: number;
  life: number;
  /** Strongest reflectivity the cell will reach, dBZ. */
  peakDbz: number;
  /** Core radius at maturity, km. */
  radius: number;
  /** How stretched the main core is along its motion. */
  elong: number;
  /** Highest echo top the cell will reach, thousands of feet. */
  top: number;
  /** Mesocyclone strength in m/s (0 = no rotation). */
  rot: number;
  /** Phase of the mesocyclone's strengthen/weaken cycle. */
  mesoPhase: number;
  tornado: Tornado | null;
  /** Bow echoes: half-length of the line, km. */
  bowLen: number;
  /** Bow echoes: how far this one will bow out (0.2 = stays a fairly straight squall line, 0.9 = big bow). */
  bowMax: number;
  parts: Part[];
  /** Minutes until the next new part bubbles up. */
  partTimer: number;
  /** Minutes until this cell may trigger a neighbour on its gust front. */
  childTimer: number;
  /** Per-cell offsets into the noise texture so every cell looks different. */
  seedX: number;
  seedY: number;
  /** Per-cell phase for gentle pulsing. */
  phase: number;
}

export interface DayType {
  label: string;
  /** Roughly how many cells the day "wants" in the area. */
  targetCells: number;
  /** Base chance per minute of a brand new cell popping up. */
  spawnPerMin: number;
  /** Chance per minute a mature cell kicks off a neighbour. */
  childPerMin: number;
  /** Chance weights for single / multicell / supercell / bow echo. */
  mix: [number, number, number, number];
  /** Chance per minute a mature supercell drops a tornado. */
  tornadoPerMin: number;
  /** Steering wind speed range, km/h. */
  windKmh: [number, number];
}

export const DAY_TYPES = {
  calm: {
    label: 'Pop-up showers',
    targetCells: 10,
    spawnPerMin: 0.4,
    childPerMin: 0.05,
    mix: [0.75, 0.25, 0, 0],
    tornadoPerMin: 0,
    windKmh: [20, 35],
  },
  active: {
    label: 'Severe day',
    targetCells: 18,
    spawnPerMin: 0.6,
    childPerMin: 0.09,
    mix: [0.42, 0.4, 0.12, 0.06],
    tornadoPerMin: 0.02,
    windKmh: [35, 55],
  },
  outbreak: {
    label: 'Outbreak!',
    targetCells: 20,
    spawnPerMin: 0.75,
    childPerMin: 0.1,
    mix: [0.25, 0.33, 0.36, 0.06],
    tornadoPerMin: 0.045,
    windKmh: [45, 70],
  },
  derecho: {
    label: 'Derecho!',
    targetCells: 14,
    spawnPerMin: 0.5,
    childPerMin: 0.1,
    mix: [0.2, 0.42, 0.06, 0.32],
    tornadoPerMin: 0.01,
    windKmh: [60, 90],
  },
} satisfies Record<string, DayType>;

export type DayKey = keyof typeof DAY_TYPES;

/** A boundary (front, dryline, outflow) where new storms like to fire. */
interface Boundary {
  x: number;
  y: number;
  /** Direction the line runs along, radians. */
  angle: number;
  length: number;
  vx: number;
  vy: number;
}

/** Cells further than this from the radar are dropped. */
const DOMAIN = 330;

export function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Life-cycle strength 0..1: grow, mature, decay. `t` is age / life. */
export function envelope(t: number): number {
  if (t < 0.28) return smoothstep(t / 0.28);
  if (t < 0.65) return 1;
  return 1 - smoothstep((t - 0.65) / 0.35);
}

/** Life-cycle of a single part (quicker rise and fall). */
export function partEnvelope(p: Part): number {
  if (!Number.isFinite(p.life)) return 1;
  const t = p.age / p.life;
  if (t < 0.3) return smoothstep(t / 0.3);
  if (t < 0.6) return 1;
  return 1 - smoothstep((t - 0.6) / 0.4);
}

export class Weather {
  cells: StormCell[] = [];
  /** Game minutes since the start of the day. */
  time = 0;
  /** Steering wind, km per game minute. */
  windX = 0;
  windY = 0;
  /** Meteorological direction the wind blows FROM, degrees. */
  windFromDeg = 240;
  windKmh = 40;
  day: DayType = DAY_TYPES.active;
  dayKey: DayKey = 'active';
  seed = 1;

  private rng = new Rng(1);
  private boundaries: Boundary[] = [];
  private nextId = 1;

  constructor(seed: number, dayKey: DayKey) {
    this.reset(seed, dayKey);
  }

  reset(seed: number, dayKey: DayKey): void {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.dayKey = dayKey;
    this.day = DAY_TYPES[dayKey];
    this.cells = [];
    this.time = 0;
    this.nextId = 1;

    // Steering wind mostly out of the SW-W, like a classic spring setup.
    this.windFromDeg = this.rng.range(200, 290);
    this.windKmh = this.rng.range(this.day.windKmh[0], this.day.windKmh[1]);
    this.setWindVector();

    this.boundaries = [this.makeBoundary(true)];
    if (this.rng.chance(0.5)) this.boundaries.push(this.makeBoundary(true));

    // Spin up the atmosphere so the first look already has storms on it.
    for (let i = 0; i < 90; i++) this.step(1);
    this.time = 0;
  }

  update(dtMin: number): void {
    let left = dtMin;
    while (left > 1e-6) {
      const dt = Math.min(1, left);
      this.step(dt);
      left -= dt;
    }
  }

  private setWindVector(): void {
    const toRad = ((this.windFromDeg + 180) * Math.PI) / 180;
    const kmPerMin = this.windKmh / 60;
    this.windX = Math.sin(toRad) * kmPerMin;
    this.windY = Math.cos(toRad) * kmPerMin;
  }

  private makeBoundary(initial: boolean): Boundary {
    const r = this.rng;
    const wl = Math.hypot(this.windX, this.windY) || 1;
    const wx = this.windX / wl;
    const wy = this.windY / wl;
    // Place it upwind of the radar so storms that fire on it travel across the scope.
    const back = initial ? r.range(60, 200) : r.range(220, 300);
    const side = r.range(-80, 80);
    const along = Math.atan2(wy, wx) + Math.PI / 2 + r.range(-0.6, 0.6);
    return {
      x: -wx * back + -wy * side,
      y: -wy * back + wx * side,
      angle: along,
      length: r.range(220, 420),
      vx: this.windX * r.range(0.25, 0.5),
      vy: this.windY * r.range(0.25, 0.5),
    };
  }

  private step(dt: number): void {
    const r = this.rng;
    this.time += dt;

    // Let the wind wander a little over the afternoon.
    this.windFromDeg += r.gauss() * 0.15 * dt;
    this.windKmh = Math.min(
      this.day.windKmh[1] * 1.2,
      Math.max(this.day.windKmh[0] * 0.8, this.windKmh + r.gauss() * 0.15 * dt),
    );
    this.setWindVector();

    for (const b of this.boundaries) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    this.boundaries = this.boundaries.map((b) => (Math.hypot(b.x, b.y) > 260 ? this.makeBoundary(false) : b));

    // Move and age the cells.
    const born: StormCell[] = [];
    for (const c of this.cells) {
      c.age += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const t = c.age / c.life;

      this.updateParts(c, t, dt);
      if (c.kind === 'super') this.updateTornado(c, t, dt);

      // Mature cells kick off new storms along their gust front.
      if (t > 0.35 && t < 0.9) {
        c.childTimer -= dt;
        if (c.childTimer <= 0) {
          c.childTimer = this.childDelay(c.kind);
          if (this.cells.length + born.length < this.day.targetCells * 1.4) {
            const child = this.spawnChild(c);
            if (child) born.push(child);
          }
        }
      }
    }
    this.cells = this.cells.filter(
      (c) => c.age < c.life && Math.abs(c.x) < DOMAIN + 40 && Math.abs(c.y) < DOMAIN + 40,
    );
    this.cells.push(...born);

    // Brand new storms. More likely when the sky is "under-stormed".
    const deficit = Math.max(0, this.day.targetCells - this.cells.length) / this.day.targetCells;
    const rate = this.day.spawnPerMin * (0.3 + 2 * deficit);
    if (r.chance(rate * dt)) this.cells.push(...this.spawnFresh());
  }

  /** Age the storm's parts and bubble up new ones. */
  private updateParts(c: StormCell, t: number, dt: number): void {
    const r = this.rng;
    for (const p of c.parts) {
      p.age += dt;
      p.u += p.du * dt;
    }
    c.parts = c.parts.filter((p) => p.age < p.life);
    if (t > 0.85) return;
    c.partTimer -= dt;
    // A multicell always keeps a couple of updrafts going until it starts dying.
    if (c.kind === 'multi' && c.parts.filter((p) => p.age < p.life * 0.7).length < 2) c.partTimer = 0;
    if (c.partTimer > 0) return;

    if (c.kind === 'multi') {
      // New updrafts form on the forward / right flank, then slide to the back as they age.
      c.parts.push({
        u: r.range(0.2, 1.0),
        v: r.range(-0.2, 1.1),
        r: r.range(0.4, 0.7),
        amp: r.range(-5, 2),
        age: 0,
        life: r.range(14, 30),
        du: -r.range(0.015, 0.035),
      });
      c.partTimer = r.range(3, 8);
    } else if (c.kind === 'super') {
      // Little towers along the flanking line, trailing back from the meso.
      const k = r.range(0, 1);
      c.parts.push({
        u: -0.7 - 1.3 * k,
        v: 0.9 + 0.7 * k + r.range(-0.2, 0.2),
        r: r.range(0.22, 0.38),
        amp: r.range(-24, -12),
        age: 0,
        life: r.range(8, 16),
        du: 0,
      });
      c.partTimer = r.range(3, 7);
    } else {
      c.partTimer = 999;
    }
  }

  private updateTornado(c: StormCell, t: number, dt: number): void {
    const r = this.rng;
    if (c.tornado) {
      const tor = c.tornado;
      tor.age += dt;
      tor.ox = Math.max(-1.5, Math.min(1.5, tor.ox + r.gauss() * 0.15 * dt));
      tor.oy = Math.max(-1.5, Math.min(1.5, tor.oy + r.gauss() * 0.15 * dt));
      if (tor.age >= tor.life || t > 0.75) c.tornado = null;
    } else {
      // Tornadoes like a strong, tightening mesocyclone.
      const cycle = mesoCycle(c);
      if (t > 0.35 && t < 0.7 && cycle > 0.75 && r.chance(this.day.tornadoPerMin * dt * (c.rot / 28) * 1.6)) {
        c.tornado = {
          age: 0,
          life: r.range(4, 16),
          vmax: r.range(35, 80),
          ox: r.range(-0.8, 0.8),
          oy: r.range(-0.8, 0.8),
        };
      }
    }
  }

  private childDelay(kind: CellKind): number {
    const mult = kind === 'multi' ? 1.8 : kind === 'super' ? 1.2 : kind === 'bow' ? 1.5 : 0.6;
    const rate = this.day.childPerMin * mult;
    return -Math.log(Math.max(1e-6, this.rng.next())) / Math.max(1e-6, rate);
  }

  private pickKind(): CellKind {
    const m = this.day.mix;
    let x = this.rng.next() * (m[0] + m[1] + m[2] + m[3]);
    const kinds: CellKind[] = ['single', 'multi', 'super', 'bow'];
    for (let k = 0; k < 4; k++) {
      if (x < m[k]) return kinds[k];
      x -= m[k];
    }
    return 'single';
  }

  /**
   * Storms need room to breathe: each one feeds on the warm, moist air around it,
   * so a new storm can't fire right on top of another. Supercells need the most room.
   */
  private hasRoom(x: number, y: number, kind: CellKind, ignore?: StormCell): boolean {
    const need = kind === 'super' ? 30 : kind === 'bow' ? 40 : 10;
    for (const c of this.cells) {
      if (c === ignore) continue;
      const own = c.kind === 'bow' ? c.bowLen * 0.9 : c.radius * (c.kind === 'super' ? 3.5 : 2.2);
      if (Math.hypot(c.x - x, c.y - y) < own + need) return false;
    }
    return true;
  }

  private spawnFresh(): StormCell[] {
    const r = this.rng;
    let kind = this.pickKind();
    // Bows are big: only a couple at once.
    if (kind === 'bow' && this.cells.some((c) => c.kind === 'bow')) kind = 'multi';
    for (let attempt = 0; attempt < 8; attempt++) {
      let x: number;
      let y: number;
      if (this.boundaries.length && r.chance(0.7)) {
        const b = r.pick(this.boundaries);
        const along = r.range(-0.5, 0.5) * b.length;
        const off = r.gauss() * 12;
        x = b.x + Math.cos(b.angle) * along - Math.sin(b.angle) * off;
        y = b.y + Math.sin(b.angle) * along + Math.cos(b.angle) * off;
      } else {
        // Scattered convection, a bit more likely upwind.
        const wl = Math.hypot(this.windX, this.windY) || 1;
        do {
          x = r.range(-DOMAIN, DOMAIN);
          y = r.range(-DOMAIN, DOMAIN);
        } while ((x * this.windX + y * this.windY) / wl > r.range(-DOMAIN, DOMAIN * 1.4));
      }
      if (!this.hasRoom(x, y, kind)) continue;
      const cell = this.makeCell(kind, x, y);
      return kind === 'bow' ? [cell, ...this.bowCompanions(cell)] : [cell];
    }
    return [];
  }

  /**
   * A bow echo is the strongest part of a bigger storm system: other storms ride
   * along with it, off the ends of the line and back in its rain shield.
   */
  private bowCompanions(bow: StormCell): StormCell[] {
    const r = this.rng;
    const sp = Math.hypot(bow.vx, bow.vy) || 1;
    const dx = bow.vx / sp;
    const dy = bow.vy / sp;
    const out: StormCell[] = [];
    const n = r.int(2, 4);
    for (let k = 0; k < n; k++) {
      const end = r.chance(0.5) ? -1 : 1;
      const side = end * bow.bowLen * r.range(1.2, 2.0);
      const fwd = -r.range(5, 30);
      const c = this.makeCell(r.chance(0.7) ? 'multi' : 'single', bow.x + dx * fwd + dy * side, bow.y + dy * fwd - dx * side);
      // Same system, same motion; start at different points in their lives.
      c.vx = bow.vx * r.range(0.85, 1.0);
      c.vy = bow.vy * r.range(0.85, 1.0);
      c.age = c.life * r.range(0, 0.3);
      out.push(c);
    }
    return out;
  }

  private spawnChild(p: StormCell): StormCell | null {
    const r = this.rng;
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const dx = p.vx / sp;
    const dy = p.vy / sp;
    // New storms fire out on the gust front, well away from the parent's core
    // (favouring the forward / right flank), or off the ends of a bow.
    const dist = p.radius * (p.kind === 'super' ? r.range(3.5, 5.5) : r.range(2.4, 3.6));
    const ang = r.range(-0.5, 1.3); // radians from straight ahead, positive = to the right
    let fwd = dist * Math.cos(ang);
    let side = dist * Math.sin(ang);
    if (p.kind === 'bow') {
      fwd = r.range(-15, 0);
      side = (r.chance(0.5) ? -1 : 1) * p.bowLen * r.range(1.1, 1.6);
    }
    const x = p.x + dx * fwd + dy * side;
    const y = p.y + dy * fwd - dx * side;
    let kind: CellKind = r.chance(0.55) ? 'single' : 'multi';
    if (p.kind === 'super' && r.chance(this.day.mix[2] * 0.6)) kind = 'super';
    // Children of a bow belong to its system; everyone else needs room to breathe.
    if (p.kind !== 'bow' && !this.hasRoom(x, y, kind, p)) return null;
    const c = this.makeCell(kind, x, y);
    if (p.kind === 'bow') {
      c.vx = p.vx * 0.92;
      c.vy = p.vy * 0.92;
    }
    return c;
  }

  private makeCell(kind: CellKind, x: number, y: number): StormCell {
    const r = this.rng;
    let vx = this.windX;
    let vy = this.windY;
    let radius: number;
    let peakDbz: number;
    let top: number;
    let life: number;
    let rot = 0;
    let bowLen = 0;
    let elong = r.range(1.05, 1.5);
    const parts: Part[] = [];
    if (kind === 'single') {
      radius = r.range(4.5, 8);
      peakDbz = r.range(40, 56);
      top = r.range(24, 40);
      life = r.range(22, 42);
      parts.push({ u: 0, v: 0, r: 1, amp: 0, age: 0, life: Infinity, du: 0 });
      if (r.chance(0.5)) {
        parts.push({ u: r.range(-0.8, 0.8), v: r.range(-0.8, 0.8), r: r.range(0.35, 0.6), amp: r.range(-10, -3), age: 0, life: Infinity, du: 0 });
      }
    } else if (kind === 'multi') {
      radius = r.range(7, 12);
      peakDbz = r.range(48, 62);
      top = r.range(34, 50);
      life = r.range(40, 80);
      for (let k = 0; k < 4; k++) {
        const pl = r.range(14, 30);
        parts.push({
          u: r.range(-0.8, 0.8),
          v: r.range(-0.8, 0.8),
          r: r.range(0.4, 0.75),
          amp: r.range(-5, 2),
          age: r.range(0, pl * 0.6),
          life: pl,
          du: -r.range(0.015, 0.035),
        });
      }
    } else if (kind === 'super') {
      radius = r.range(11, 16);
      peakDbz = r.range(58, 72);
      top = r.range(45, 63);
      life = r.range(80, 160);
      rot = r.range(18, 36);
      parts.push({ u: 0.15, v: -0.1, r: 1, amp: 0, age: 0, life: Infinity, du: 0 });
      // Supercells turn right of the mean wind and slow down a bit ("right movers").
      const turn = -r.range(0.35, 0.6);
      const sp = r.range(0.7, 0.85);
      const cx = vx * Math.cos(turn) - vy * Math.sin(turn);
      const cy = vx * Math.sin(turn) + vy * Math.cos(turn);
      vx = cx * sp;
      vy = cy * sp;
    } else {
      // Bow echo: a fast-moving line that bulges out where the wind is strongest.
      radius = r.range(8, 11);
      bowLen = r.range(35, 70);
      peakDbz = r.range(50, 60);
      top = r.range(42, 54);
      life = r.range(120, 220);
      elong = 1;
      const sp = r.range(1.15, 1.35);
      vx *= sp;
      vy *= sp;
    }
    // A little individual wobble in motion.
    vx += r.gauss() * 0.05;
    vy += r.gauss() * 0.05;
    return {
      id: this.nextId++,
      kind,
      x,
      y,
      vx,
      vy,
      age: 0,
      life,
      peakDbz,
      radius,
      elong,
      top,
      rot,
      mesoPhase: r.range(0, Math.PI * 2),
      tornado: null,
      bowLen,
      bowMax: kind === 'bow' ? r.range(0.2, 0.9) : 0,
      parts,
      partTimer: r.range(1, 5),
      childTimer: this.childDelay(kind),
      seedX: r.range(0, 256),
      seedY: r.range(0, 256),
      phase: r.range(0, Math.PI * 2),
    };
  }
}

/** Mesocyclones strengthen and weaken in cycles: 0.35 (weak) .. 1 (strong and tight). */
export function mesoCycle(c: StormCell): number {
  const s = Math.sin(c.age * 0.16 + c.mesoPhase);
  return 0.35 + 0.65 * (0.5 + 0.5 * s);
}

/** Shared geometry for a cell at its current moment. Used by the field renderer and debug overlay. */
export interface CellShape {
  t: number;
  strength: number;
  peak: number;
  /** Core half-length along motion and half-width across it, km. */
  a: number;
  b: number;
  /** Unit vector of motion and unit vector to its right. */
  dirX: number;
  dirY: number;
  rightX: number;
  rightY: number;
  /** Trailing stratiform rain strength 0..1. */
  strat: number;
  /** Mesocyclone strength right now, m/s, and its centre. */
  meso: number;
  mesoX: number;
  mesoY: number;
  /** Echo top right now, kft. */
  topNow: number;
  /** Bow echoes: current half-length (km) and how far the middle bulges (0..1). */
  bowL: number;
  bowAmt: number;
}

export function cellShape(c: StormCell): CellShape {
  const t = c.age / c.life;
  const e = envelope(t);
  const pulse = 1 + 0.05 * Math.sin(c.age * 0.35 + c.phase);
  const peak = 12 + (c.peakDbz - 12) * e * pulse;
  const grow = t < 0.65 ? 0.5 + 0.5 * Math.sqrt(e) : 1 + 0.3 * smoothstep((t - 0.65) / 0.35);
  const b = c.radius * grow;
  const a = b * c.elong;
  const sp = Math.hypot(c.vx, c.vy) || 1;
  const dirX = c.vx / sp;
  const dirY = c.vy / sp;
  const rightX = dirY;
  const rightY = -dirX;
  const strat = smoothstep((t - 0.3) / 0.6) * (c.kind === 'single' ? 0.55 : 1);
  const meso =
    c.rot * smoothstep((t - 0.12) / 0.2) * (1 - smoothstep((t - 0.82) / 0.15)) * (c.kind === 'super' ? mesoCycle(c) : 1);
  // Mesocyclone sits on the rear-right flank, at the edge of the core (where the hook forms).
  const mesoX = c.x - dirX * 0.55 * a + rightX * 0.85 * b;
  const mesoY = c.y - dirY * 0.55 * a + rightY * 0.85 * b;
  const topNow = 12 + (c.top - 12) * Math.pow(e, 0.6);
  const bowL = c.bowLen * (0.6 + 0.4 * Math.sqrt(e));
  const bowAmt = 0.05 + (c.bowMax - 0.05) * smoothstep((t - 0.15) / 0.45);
  return { t, strength: e, peak, a, b, dirX, dirY, rightX, rightY, strat, meso, mesoX, mesoY, topNow, bowL, bowAmt };
}
