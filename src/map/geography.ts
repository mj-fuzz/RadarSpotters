import { Rng } from '../sim/rng';
import { RANGE_KM } from '../sim/fields';

/** A made-up patch of countryside around the radar: counties, a state line, highways, towns. */

export interface Town {
  name: string;
  x: number;
  y: number;
  /** 1 = village, 2 = town, 3 = city. */
  size: 1 | 2 | 3;
}

export type Polyline = Array<[number, number]>;

const TOWN_NAMES = [
  'Hailstone', 'Gustfield', 'Cloverdale', 'Thunder Ridge', 'Prairie Vista', 'Mesa Junction',
  'Windmill Creek', 'Cedar Bluff', 'Rainsford', 'Dusty Springs', 'Larkspur', 'Ironwood',
  'Copper Falls', 'Maple Hollow', 'Redfield', 'Bison Flats', 'Silver Lake', 'Owl Creek',
  'Harvest City', 'Sunflower', 'Whistle Stop', 'Brookhaven', 'Falcon Point', 'Kestrel',
  'Twin Oaks', 'Graniteville', 'Pine Ridge', 'Elk Crossing', 'Willow Bend', 'Anvil Rock',
];

export const RADAR_CITY = 'Stormhaven';
export const RADAR_ID = 'RSPT';

export class Geography {
  readonly counties: Polyline[] = [];
  readonly stateLine: Polyline = [];
  readonly highways: Polyline[] = [];
  readonly towns: Town[] = [];

  constructor(seed: number) {
    const r = new Rng(seed ^ 0x9e3779b9);
    const S = 38;
    const N = 8;
    const ext = RANGE_KM + 20;

    // Jittered square-ish county grid, like the plains.
    const vx: number[][] = [];
    for (let j = -N; j <= N; j++) {
      const row: number[] = [];
      for (let i = -N; i <= N; i++) row.push(r.range(-4, 4));
      vx.push(row);
    }
    for (let j = -N; j <= N; j++) {
      const line: Polyline = [];
      for (let i = -N; i <= N; i++) line.push([i * S + vx[j + N][i + N] * 0.4, j * S + vx[i + N][j + N]]);
      this.counties.push(clip(line, ext));
    }
    for (let i = -N; i <= N; i++) {
      const line: Polyline = [];
      for (let j = -N; j <= N; j++) line.push([i * S + vx[j + N][i + N], j * S + vx[i + N][j + N] * 0.4]);
      this.counties.push(clip(line, ext));
    }

    // A wiggly river forms the state line.
    const sx = r.range(90, 170) * (r.chance(0.5) ? 1 : -1);
    const ph1 = r.range(0, 6);
    const ph2 = r.range(0, 6);
    for (let y = -ext; y <= ext; y += 3) {
      this.stateLine.push([sx + 14 * Math.sin(y / 37 + ph1) + 6 * Math.sin(y / 11 + ph2), y]);
    }

    // Two interstates crossing near the radar city.
    const hw = (angle: number) => {
      const line: Polyline = [];
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const ph = r.range(0, 6);
      for (let t = -ext; t <= ext; t += 6) {
        const off = 7 * Math.sin(t / 53 + ph);
        line.push([ca * t - sa * off + 4, sa * t + ca * off - 3]);
      }
      return line;
    };
    this.highways.push(hw(r.range(-0.15, 0.15)), hw(Math.PI / 2 + r.range(-0.2, 0.2)));

    this.towns.push({ name: RADAR_CITY, x: 4, y: -3, size: 3 });
    const names = [...TOWN_NAMES];
    let tries = 0;
    while (names.length && tries++ < 4000) {
      const x = r.range(-RANGE_KM + 10, RANGE_KM - 10);
      const y = r.range(-RANGE_KM + 10, RANGE_KM - 10);
      if (Math.hypot(x, y) > RANGE_KM - 8) continue;
      if (this.towns.some((t) => Math.hypot(t.x - x, t.y - y) < 32)) continue;
      const name = names.splice(Math.floor(r.next() * names.length), 1)[0];
      const roll = r.next();
      this.towns.push({ name, x, y, size: roll < 0.15 ? 3 : roll < 0.55 ? 2 : 1 });
    }
  }

  /** Spotter-style description like "12 km SW of Hailstone". */
  describe(x: number, y: number): string {
    let best = this.towns[0];
    let bestD = Infinity;
    for (const t of this.towns) {
      const d = Math.hypot(t.x - x, t.y - y) / (t.size === 3 ? 1.4 : 1);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    const d = Math.hypot(best.x - x, best.y - y);
    if (d < 3) return `over ${best.name}`;
    return `${Math.round(d)} km ${compass(x - best.x, y - best.y)} of ${best.name}`;
  }
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass(dx: number, dy: number): string {
  const az = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return POINTS[Math.round(az / 22.5) % 16];
}

function clip(line: Polyline, ext: number): Polyline {
  return line.filter(([x, y]) => Math.abs(x) <= ext + 40 && Math.abs(y) <= ext + 40);
}
