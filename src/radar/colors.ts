/** Colour tables for the three radar products, plus a lookup-table builder. */

export type Stop = [value: number, color: string];

export interface ColorScale {
  stops: Stop[];
  min: number;
  max: number;
  unit: string;
  /** Values below this are not drawn. */
  floor: number;
  /** Blend smoothly between stops (true) or use hard steps (false). */
  smooth: boolean;
}

/** Classic NWS-style reflectivity, dBZ. */
export const REFLECTIVITY: ColorScale = {
  unit: 'dBZ',
  min: 5,
  max: 80,
  floor: 5,
  smooth: true,
  stops: [
    [5, '#04e9e7'],
    [10, '#019ff4'],
    [15, '#0300f4'],
    [20, '#02fd02'],
    [25, '#01c501'],
    [30, '#008e00'],
    [35, '#fdf802'],
    [40, '#e5bc00'],
    [45, '#fd9500'],
    [50, '#fd0000'],
    [55, '#d40000'],
    [60, '#bc0000'],
    [65, '#f800fd'],
    [70, '#9854c6'],
    [75, '#fdfdfd'],
    [80, '#fdfdfd'],
  ],
};

/** Base radial velocity, knots. Green = toward the radar, red = away. */
export const VELOCITY: ColorScale = {
  unit: 'kt',
  min: -100,
  max: 100,
  floor: -1000,
  smooth: true,
  stops: [
    [-100, '#c8fff8'],
    [-80, '#00e5d0'],
    [-60, '#00ff3c'],
    [-40, '#00c000'],
    [-20, '#007a00'],
    [-5, '#3c5a3c'],
    [0, '#6e6e6e'],
    [5, '#5a3c3c'],
    [20, '#7a0000'],
    [40, '#c40000'],
    [60, '#ff2020'],
    [80, '#ff8cb4'],
    [100, '#ffe4f0'],
  ],
};

/** Echo tops, thousands of feet. */
export const ECHO_TOPS: ColorScale = {
  unit: 'kft',
  min: 10,
  max: 70,
  floor: 10,
  smooth: false,
  stops: [
    [10, '#1a3a6e'],
    [15, '#2160c0'],
    [20, '#1e9be0'],
    [25, '#20d4e8'],
    [30, '#22c46a'],
    [35, '#7ee020'],
    [40, '#f0f020'],
    [45, '#f8b020'],
    [50, '#f86020'],
    [55, '#e01818'],
    [60, '#e020e0'],
    [65, '#ffffff'],
    [70, '#ffffff'],
  ],
};

export const LUT_SIZE = 1024;

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Build packed RGBA (little-endian ABGR) colours for fast pixel writes. */
export function buildLut(scale: ColorScale, alpha = 235): Uint32Array {
  const lut = new Uint32Array(LUT_SIZE);
  const stops = scale.stops.map(([v, c]) => [v, ...hex(c)] as [number, number, number, number]);
  for (let k = 0; k < LUT_SIZE; k++) {
    const val = scale.min + ((scale.max - scale.min) * k) / (LUT_SIZE - 1);
    let s = 0;
    while (s < stops.length - 2 && val >= stops[s + 1][0]) s++;
    const [v0, r0, g0, b0] = stops[s];
    const [v1, r1, g1, b1] = stops[s + 1];
    const f = scale.smooth ? Math.min(1, Math.max(0, (val - v0) / (v1 - v0))) : val >= v1 ? 1 : 0;
    const r = Math.round(r0 + (r1 - r0) * f);
    const g = Math.round(g0 + (g1 - g0) * f);
    const b = Math.round(b0 + (b1 - b0) * f);
    lut[k] = (alpha << 24) | (b << 16) | (g << 8) | r;
  }
  return lut;
}

export function lutIndex(scale: ColorScale, val: number): number {
  const k = Math.round(((val - scale.min) / (scale.max - scale.min)) * (LUT_SIZE - 1));
  return k < 0 ? 0 : k >= LUT_SIZE ? LUT_SIZE - 1 : k;
}
