import { RANGE_KM } from '../sim/fields';
import { cellShape, outflowWind, type StormCell, type Weather } from '../sim/weather';

/**
 * The warning game.
 *
 * The player draws Severe Thunderstorm (SVR) and Tornado (TOR) warnings as cones
 * along a storm's path. Meanwhile the storms produce "storm reports" (hail, damaging
 * wind, tornadoes) based on what they are really doing. A report inside a matching
 * warning scores points (more for lead time and a tight box); a report outside every
 * warning is a miss; a warning that expires without any reports is a false alarm.
 */

export type WarningKind = 'svr' | 'tor';
export type ReportKind = 'hail' | 'wind' | 'tornado';

export interface Warning {
  id: number;
  kind: WarningKind;
  /** Polygon corners in km (x east, y north). */
  poly: Array<[number, number]>;
  areaKm2: number;
  /** Game minutes. */
  issued: number;
  expires: number;
  reports: number;
  /** Set once the warning has been scored at expiry. */
  done: boolean;
  /** Towns (or a nearby place) inside the warning, for the alert panel and ticker. */
  areaText: string;
}

export interface Report {
  kind: ReportKind;
  x: number;
  y: number;
  time: number;
  /** Hail size (inches) or wind speed (mph). */
  magnitude: number;
  warned: boolean;
}

export interface Toast {
  text: string;
  good: boolean;
  time: number;
}

/** How long warnings last, game minutes. Short, so it stays frantic! */
export const WARNING_MINUTES: Record<WarningKind, number> = { svr: 30, tor: 20 };
/** Cone shape: width at the storm end, and how fast it widens along the path. */
const NEAR_WIDTH = 16;
const SPREAD = 0.55;
const BEHIND = 6;
const MIN_LENGTH = 15;
const MAX_LENGTH = 160;
/** No penalty for misses in the first few minutes of a day, while you get your bearings. */
const GRACE_MINUTES = 6;

export class WarningGame {
  warnings: Warning[] = [];
  reports: Report[] = [];
  toasts: Toast[] = [];
  score = 0;
  hits = 0;
  misses = 0;
  falseAlarms = 0;

  /** Called when a storm report comes in (for the ticker). */
  onReport: ((r: Report, what: string, where: string) => void) | null = null;
  /** Called when a warning expires. */
  onExpire: ((w: Warning) => void) | null = null;

  private nextId = 1;
  private clock = 0;
  /** Per storm: minutes since its last report of each kind (so reports don't spam). */
  private cooldown = new Map<string, number>();

  reset(): void {
    this.warnings = [];
    this.reports = [];
    this.toasts = [];
    this.score = 0;
    this.hits = 0;
    this.misses = 0;
    this.falseAlarms = 0;
    this.cooldown.clear();
    this.clock = 0;
  }

  /** Build the cone from where the player pressed (on the storm) to where they let go. */
  static cone(x0: number, y0: number, x1: number, y1: number): { poly: Array<[number, number]>; area: number } | null {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len = Math.hypot(dx, dy);
    if (len < MIN_LENGTH) return null;
    dx /= len;
    dy /= len;
    len = Math.min(len, MAX_LENGTH);
    const px = -dy;
    const py = dx;
    const w0 = NEAR_WIDTH / 2;
    const w1 = (NEAR_WIDTH + len * SPREAD) / 2;
    const bx = x0 - dx * BEHIND;
    const by = y0 - dy * BEHIND;
    const ex = x0 + dx * len;
    const ey = y0 + dy * len;
    const poly: Array<[number, number]> = [
      [bx + px * w0, by + py * w0],
      [ex + px * w1, ey + py * w1],
      [ex - px * w1, ey - py * w1],
      [bx - px * w0, by - py * w0],
    ];
    const area = ((2 * w0 + 2 * w1) / 2) * (len + BEHIND);
    return { poly, area };
  }

  issue(kind: WarningKind, x0: number, y0: number, x1: number, y1: number, now: number): Warning | null {
    const c = WarningGame.cone(x0, y0, x1, y1);
    if (!c) return null;
    const w: Warning = {
      id: this.nextId++,
      kind,
      poly: c.poly,
      areaKm2: c.area,
      issued: now,
      expires: now + WARNING_MINUTES[kind],
      reports: 0,
      done: false,
      areaText: '',
    };
    this.warnings.push(w);
    return w;
  }

  /** Advance the game to the weather's current time. */
  update(weather: Weather, describe: (x: number, y: number) => string): void {
    // Work in whole game minutes so the report odds don't depend on frame rate.
    while (this.clock + 1 <= weather.time) {
      this.clock += 1;
      for (const c of weather.cells) this.stormReports(c, this.clock, describe);
    }
    const now = weather.time;
    for (const w of this.warnings) {
      if (!w.done && now >= w.expires) {
        w.done = true;
        this.onExpire?.(w);
        if (w.reports === 0) {
          this.falseAlarms++;
          this.score -= 30;
          this.toast(`False alarm: ${w.kind.toUpperCase()} warning expired with no reports  −30`, false, now);
        }
      }
    }
    // Keep expired warnings around briefly so they can fade out on screen.
    this.warnings = this.warnings.filter((w) => now < w.expires + 3);
    this.reports = this.reports.filter((r) => now - r.time < 25);
    this.toasts = this.toasts.filter((t) => now - t.time < 12);
  }

  private stormReports(c: StormCell, now: number, describe: (x: number, y: number) => string): void {
    const s = cellShape(c);
    const roll = (key: string, chance: number, minGap: number): boolean => {
      const k = `${c.id}:${key}`;
      const last = this.cooldown.get(k) ?? -999;
      if (now - last < minGap || Math.random() >= chance) return false;
      this.cooldown.set(k, now);
      return true;
    };
    const jitter = () => (Math.random() - 0.5) * 6;

    // Tornado: report when it touches down, then every few minutes along its path.
    if (c.tornado && c.tornado.age > 1 && roll('tor', 1, 5)) {
      const x = s.mesoX + c.tornado.ox;
      const y = s.mesoY + c.tornado.oy;
      const ef = c.tornado.vmax > 70 ? 3 : c.tornado.vmax > 55 ? 2 : c.tornado.vmax > 42 ? 1 : 0;
      this.addReport('tornado', x, y, ef, now, describe);
    }

    // Large hail from intense cores.
    const hailLine = c.kind === 'super' ? 58 : 60;
    if (s.peak >= hailLine && roll('hail', c.kind === 'super' ? 0.18 : 0.1, 4)) {
      const size = Math.min(4, 1 + (s.peak - hailLine) * 0.15 + Math.random() * 0.75);
      this.addReport('hail', c.x + jitter(), c.y + jitter(), Math.round(size * 4) / 4, now, describe);
    }

    // Damaging wind: bow echoes along the leading edge, strong downdrafts elsewhere.
    if (c.kind === 'bow') {
      const gust = (22 + 30 * s.bowAmt) * s.strength; // m/s, matches the radar's rear-inflow jet
      if (gust > 24 && roll('wind', 0.35, 2)) {
        const v = (Math.random() - 0.5) * 1.4 * s.bowL;
        const vn = v / s.bowL;
        const u = s.bowAmt * s.bowL * 1.2 * (1 - vn * vn) - s.bowAmt * s.bowL * 0.6 - 4;
        this.addReport('wind', c.x + s.dirX * u + s.rightX * v, c.y + s.dirY * u + s.rightY * v, mph(gust * (0.9 + Math.random() * 0.3)), now, describe);
      }
    } else {
      // Only storms that look strong on radar (a 50+ dBZ core) can knock trees down,
      // so a sharp-eyed player always has a fair chance to see it coming.
      const gust = outflowWind(c) * 1.25;
      if (gust > 25 && s.peak >= 50 && roll('wind', 0.12, 4)) {
        const ahead = s.b * 0.8;
        this.addReport('wind', c.x + s.dirX * ahead + jitter(), c.y + s.dirY * ahead + jitter(), mph(gust), now, describe);
      }
    }
  }

  private addReport(kind: ReportKind, x: number, y: number, magnitude: number, now: number, describe: (x: number, y: number) => string): void {
    if (Math.hypot(x, y) > RANGE_KM) return; // outside our area
    const active = this.warnings.filter((w) => !w.done && now >= w.issued && now < w.expires && inside(w.poly, x, y));
    // Tornadoes need a tornado warning; hail and wind are covered by either.
    const covering = active.filter((w) => kind !== 'tornado' || w.kind === 'tor');
    const r: Report = { kind, x, y, time: now, magnitude, warned: covering.length > 0 };
    this.reports.push(r);
    const what = reportText(r);
    const where = describe(x, y);
    this.onReport?.(r, what, where);
    if (covering.length) {
      // Best warning: the one issued earliest (most lead time).
      const w = covering.reduce((a, b) => (a.issued <= b.issued ? a : b));
      w.reports++;
      const lead = Math.max(0, Math.round(now - w.issued));
      const tight = Math.max(0.3, Math.min(2, 2500 / w.areaKm2));
      const pts = Math.round((kind === 'tornado' ? 150 : 100) + lead * 4 + 25 * tight);
      this.score += pts;
      this.hits++;
      this.toast(`✔ ${what} ${where} — warned, ${lead} min lead  +${pts}`, true, now);
    } else if (now < GRACE_MINUTES) {
      this.toast(`${what} ${where} (warm-up, no penalty)`, false, now);
    } else {
      const pts = kind === 'tornado' ? 100 : 50;
      this.score -= pts;
      this.misses++;
      this.toast(`✘ MISSED: ${what} ${where}  −${pts}`, false, now);
    }
  }

  private toast(text: string, good: boolean, time: number): void {
    this.toasts.push({ text, good, time });
    if (this.toasts.length > 5) this.toasts.shift();
  }
}

function mph(ms: number): number {
  return Math.round((ms * 2.237) / 5) * 5;
}

export function reportText(r: Report): string {
  if (r.kind === 'tornado') return `EF${r.magnitude} tornado`;
  if (r.kind === 'hail') return `${r.magnitude.toFixed(2)}" hail`;
  return `${r.magnitude} mph wind`;
}

/** Point-in-polygon (ray casting). */
export function inside(poly: Array<[number, number]>, x: number, y: number): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
