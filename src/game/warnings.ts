import { RANGE_KM } from '../sim/fields';
import { cellShape, outflowWind, type StormCell, type Weather } from '../sim/weather';

/**
 * The warning game.
 *
 * The player issues products:
 *  - warnings (cones drawn along a storm's path): SVR, Destructive/PDS SVR, TOR, TOR Emergency
 *  - watches (big boxes): Severe Thunderstorm Watch, Tornado Watch
 *
 * Storms produce "storm reports" (hail, damaging wind, tornadoes) from what they are
 * really doing. Reports inside a matching warning score points (bonuses for lead time,
 * a tight box, extreme storms, the right special warning, and being inside a watch).
 * Reports outside every warning are misses. Products that expire with nothing in
 * them are false alarms.
 */

export type WarningKind = 'svr' | 'svrd' | 'tor' | 'tore' | 'sva' | 'toa';
export type ReportKind = 'hail' | 'wind' | 'tornado';

export interface KindInfo {
  /** Full name for the alerts panel / ticker. */
  name: string;
  /** Short label drawn on the map. */
  short: string;
  /** Outline colour, "r,g,b". */
  rgb: string;
  /** How long it lasts, game minutes. */
  minutes: number;
  /** Watches are big boxes; warnings are cones. */
  watch: boolean;
  /** Can a tornado report be covered by this? */
  tornado: boolean;
  /** Points lost if it expires with no reports at all. */
  bust: number;
}

/** Colours follow the real NWS map colours where there is one. */
export const KINDS: Record<WarningKind, KindInfo> = {
  svr: { name: 'Severe Thunderstorm Warning', short: 'SVR', rgb: '255,165,0', minutes: 30, watch: false, tornado: false, bust: 30 },
  svrd: { name: 'DESTRUCTIVE Severe Thunderstorm Warning', short: 'PDS SVR', rgb: '255,90,30', minutes: 30, watch: false, tornado: false, bust: 60 },
  tor: { name: 'Tornado Warning', short: 'TOR', rgb: '255,40,40', minutes: 20, watch: false, tornado: true, bust: 30 },
  tore: { name: 'TORNADO EMERGENCY', short: 'TOR EMERG', rgb: '255,40,255', minutes: 20, watch: false, tornado: true, bust: 150 },
  sva: { name: 'Severe Thunderstorm Watch', short: 'SVR WATCH', rgb: '219,112,147', minutes: 90, watch: true, tornado: false, bust: 40 },
  toa: { name: 'Tornado Watch', short: 'TOR WATCH', rgb: '255,255,60', minutes: 90, watch: true, tornado: true, bust: 40 },
};

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
  /** Reports caught that were at the extreme level this product is meant for. */
  extremeHits: number;
  /** Issued inside an active matching watch (preparedness bonus). */
  inWatch: boolean;
  /** Watch number (for the ticker), 0 for warnings. */
  number: number;
  /** Set once scored at expiry. */
  done: boolean;
  /** Towns (or a nearby place) inside, for the alert panel and ticker. */
  areaText: string;
}

export interface Report {
  kind: ReportKind;
  x: number;
  y: number;
  time: number;
  /** Hail size (inches), wind speed (mph) or EF rating. */
  magnitude: number;
  warned: boolean;
}

export interface Toast {
  text: string;
  good: boolean;
  time: number;
}

/** Cone shape: width at the storm end, and how fast it widens along the path. */
const NEAR_WIDTH = 16;
const SPREAD = 0.55;
const BEHIND = 6;
const MIN_LENGTH = 15;
const MAX_LENGTH = 160;
/** Watches: smallest box side, km. */
const MIN_WATCH = 40;
/** No penalty for misses in the first few minutes of a day, while you get your bearings. */
const GRACE_MINUTES = 6;

/** Is this report at the "insane storm" level? */
export function isExtreme(r: Pick<Report, 'kind' | 'magnitude'>): boolean {
  if (r.kind === 'hail') return r.magnitude >= 2.75;
  if (r.kind === 'wind') return r.magnitude >= 80;
  return r.magnitude >= 3;
}

/** Tornado wind (m/s) -> EF rating. */
export function efRating(vmax: number): number {
  return vmax > 89 ? 5 : vmax > 74 ? 4 : vmax > 61 ? 3 : vmax > 49 ? 2 : vmax > 38 ? 1 : 0;
}

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
  /** Called when a warning or watch expires. */
  onExpire: ((w: Warning) => void) | null = null;

  private nextId = 1;
  private nextWatch = 101;
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

  /** Build the warning cone from where the player pressed (on the storm) to where they let go. */
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

  /** Build a watch box from two opposite corners. */
  static box(x0: number, y0: number, x1: number, y1: number): { poly: Array<[number, number]>; area: number } | null {
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w < MIN_WATCH || h < MIN_WATCH) return null;
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    return {
      poly: [
        [xa, ya],
        [xb, ya],
        [xb, yb],
        [xa, yb],
      ],
      area: w * h,
    };
  }

  static shape(kind: WarningKind, x0: number, y0: number, x1: number, y1: number) {
    return KINDS[kind].watch ? WarningGame.box(x0, y0, x1, y1) : WarningGame.cone(x0, y0, x1, y1);
  }

  issue(kind: WarningKind, x0: number, y0: number, x1: number, y1: number, now: number): Warning | null {
    const c = WarningGame.shape(kind, x0, y0, x1, y1);
    if (!c) return null;
    const info = KINDS[kind];
    const inWatch =
      !info.watch &&
      this.warnings.some(
        (w) => KINDS[w.kind].watch && !w.done && now < w.expires && (w.kind === 'toa' || !info.tornado) && inside(w.poly, x0, y0),
      );
    const w: Warning = {
      id: this.nextId++,
      kind,
      poly: c.poly,
      areaKm2: c.area,
      issued: now,
      expires: now + info.minutes,
      reports: 0,
      extremeHits: 0,
      inWatch,
      number: info.watch ? this.nextWatch++ : 0,
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
      if (w.done || now < w.expires) continue;
      w.done = true;
      this.onExpire?.(w);
      const info = KINDS[w.kind];
      if (w.reports === 0) {
        this.falseAlarms++;
        this.score -= info.bust;
        this.toast(`${info.watch ? 'Watch bust' : 'False alarm'}: ${info.short} expired with no reports  −${info.bust}`, false, now);
      } else if ((w.kind === 'svrd' || w.kind === 'tore') && w.extremeHits === 0) {
        const pts = w.kind === 'tore' ? 75 : 25;
        this.score -= pts;
        this.toast(`Overwarned: ${info.short} never caught a ${w.kind === 'tore' ? 'violent tornado' : 'destructive report'}  −${pts}`, false, now);
      }
    }
    // Keep expired products around briefly so they can fade out on screen.
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
      this.addReport('tornado', x, y, efRating(c.tornado.vmax), now, describe);
    }

    // Large hail from intense cores.
    const hailLine = c.kind === 'super' ? 58 : 60;
    if (s.peak >= hailLine && roll('hail', c.kind === 'super' ? 0.18 : 0.1, 4)) {
      const size = Math.min(4.5, 1 + (s.peak - hailLine) * 0.17 + Math.random() * 0.9);
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
    const live = this.warnings.filter((w) => !w.done && now >= w.issued && now < w.expires && inside(w.poly, x, y));
    const r: Report = { kind, x, y, time: now, magnitude, warned: false };
    const extreme = isExtreme(r);

    // Watches: every report inside one is a little win, warned or not.
    let watchPts = 0;
    for (const w of live) {
      if (!KINDS[w.kind].watch || (kind === 'tornado' && !KINDS[w.kind].tornado)) continue;
      w.reports++;
      watchPts += Math.round(10 * Math.max(0.3, Math.min(1.5, 30000 / w.areaKm2)));
    }

    // Warnings: tornadoes need a tornado warning; hail and wind are covered by any warning.
    const covering = live.filter((w) => !KINDS[w.kind].watch && (kind !== 'tornado' || KINDS[w.kind].tornado));
    r.warned = covering.length > 0;
    this.reports.push(r);
    const what = reportText(r);
    const where = describe(x, y);
    this.onReport?.(r, what, where);

    if (covering.length) {
      // Score with the warning that earns the most.
      let best = covering[0];
      let bestPts = -Infinity;
      let bestTags: string[] = [];
      for (const w of covering) {
        const { pts, tags } = this.pointsFor(w, r, extreme, now);
        if (pts > bestPts) {
          bestPts = pts;
          best = w;
          bestTags = tags;
        }
      }
      best.reports++;
      if (
        (best.kind === 'svrd' && extreme && kind !== 'tornado') ||
        (best.kind === 'tore' && kind === 'tornado' && extreme)
      ) {
        best.extremeHits++;
      }
      const total = bestPts + watchPts;
      this.score += total;
      this.hits++;
      const lead = Math.max(0, Math.round(now - best.issued));
      const tagText = bestTags.length ? ` [${bestTags.join(' · ')}]` : '';
      this.toast(`✔ ${what} ${where} — ${lead} min lead${tagText}  +${total}`, true, now);
    } else if (now < GRACE_MINUTES) {
      this.toast(`${what} ${where} (warm-up, no penalty)`, false, now);
    } else {
      const pts = (kind === 'tornado' ? 100 : 50) + (extreme ? 50 : 0);
      this.score += watchPts - pts;
      this.misses++;
      this.toast(`✘ MISSED: ${what} ${where}  −${pts}${watchPts ? ` (watch +${watchPts})` : ''}`, false, now);
    }
  }

  /** Points a warning earns for a report, with the bonus tags that explain them. */
  private pointsFor(w: Warning, r: Report, extreme: boolean, now: number): { pts: number; tags: string[] } {
    const tags: string[] = [];
    const lead = Math.max(0, Math.round(now - w.issued));
    const tight = Math.max(0.3, Math.min(2, 2500 / w.areaKm2));
    let pts = (r.kind === 'tornado' ? 150 : 100) + lead * 4 + 25 * tight;
    if (w.kind === 'svrd' && r.kind !== 'tornado') {
      if (extreme) {
        pts *= 2;
        tags.push('DESTRUCTIVE ×2');
      }
    } else if (w.kind === 'tore' && r.kind === 'tornado') {
      if (extreme) {
        pts = pts * 3 + 200;
        tags.push('TORNADO EMERGENCY ×3');
      }
    } else if (extreme) {
      pts += 75;
      tags.push('EXTREME +75');
    }
    if (w.inWatch) {
      pts *= 1.2;
      tags.push('WATCH ×1.2');
    }
    return { pts: Math.round(pts), tags };
  }

  private toast(text: string, good: boolean, time: number): void {
    this.toasts.push({ text, good, time });
    if (this.toasts.length > 5) this.toasts.shift();
  }
}

function mph(ms: number): number {
  return Math.min(120, Math.round((ms * 2.237) / 5) * 5);
}

export function reportText(r: Pick<Report, 'kind' | 'magnitude'>): string {
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
