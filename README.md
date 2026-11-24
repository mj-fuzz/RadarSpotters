# Radar Spotters 🌩️📡

Watch the weather radar, spot the storm cells, and (soon!) draw warning boxes before they hit town.

Storms form, grow, mature, and fall apart on their own while the steering winds push them across
the map — with the clock cranked way up so it gets frantic.

## Radar views

| Key | View | What it shows |
| --- | --- | --- |
| `1` | **REF** – Reflectivity | How much rain/hail. Green light, red heavy, pink/purple = hail |
| `2` | **VEL** – Velocity | Wind. Green blows *toward* the radar, red *away*. Bright green touching bright red = rotation (tornado x-ray!) |
| `3` | **ET** – Echo Tops | How tall the storm is, in thousands of feet |

**Warnings & watches:** pick a tool from the palette on the left; it stays picked until you switch.

| Tool | Key | Use it for | Bonus |
| --- | --- | --- | --- |
| ✥ Cursor | `C` / `Esc` | Pan and look | |
| ⚠ SVR | `W` | Severe Thunderstorm Warning | |
| 💥 PDS SVR | `E` | Destructive: 80+ mph wind or 2.75"+ hail | ×2 when a destructive report verifies |
| 🌪 TOR | `T` | Tornado Warning | |
| ☠ TOR EMERG | `Y` | Tornado Emergency: violent (EF3+) tornado | ×3 + 200 when it verifies |
| ▭ SVR WATCH | `A` | Big box, 90 minutes | points per report, ×1.2 for warnings inside |
| ▭ TOR WATCH | `S` | Big box, 90 minutes | points per report, ×1.2 for warnings inside |

For warnings, press on the storm and drag the way it's moving; for watches, drag a big box. Right-drag
(or two fingers) pans while a tool is picked. Storm reports (hail ◆, wind ■, tornado ▼) score points
inside your warnings (bonus for lead time, a tight box, and EXTREME storms); reports outside are misses,
and products with no reports are false alarms. Special warnings that never catch an extreme report are
"overwarned" and cost points.

**Alerts:** active warnings are listed on the side, spotter reports scroll across the ticker at the
bottom, and issuing a Tornado warning sets off a (simulated!) Emergency Alert: flashing banner, red
ticker, alert tones and a robot voice reading the warning. The tones are deliberately NOT the real EAS
tones, which may not be used outside real alerts. `M` mutes all sounds.

Other controls: `Space` pause · `+`/`-` speed · `N` new day · drag to pan · scroll/pinch to zoom ·
`0` reset view · `B` smooth/blocky pixels · `M` mute · `D` cheat mode (shows every storm's type, stage, and path) · `H` help.

## Play / develop

```bash
npm install
npm run dev        # open the printed localhost link
npm run build      # production build in dist/
```

The game is a web app (TypeScript + Canvas, built with Vite) and an installable PWA, so it runs
in any modern browser on desktop or phone and works offline once loaded. Native Windows / Linux /
Android builds can come later by wrapping the same code with Tauri.

## How the weather works

- `src/sim/weather.ts` — the storm engine: storm cells (single, multicell, supercell, bow echo), their life
  cycle, steering winds, boundaries where new storms fire, gust-front "child" storms, tornadoes.
- `src/sim/fields.ts` — turns the storm list into reflectivity, wind, and echo-top grids
  (ragged edges, trailing rain, hook echoes, mesocyclones, outflow, debris balls).
- `src/radar/scope.ts` — the rotating radar beam that samples those grids, plus coloring.
- `src/game/warnings.ts` — the warning game: cones, storm reports, scoring.
- `src/map/geography.ts` — made-up counties, towns, highways, and a river state line.

## Roadmap

- [x] Storms that form, drift, grow, and dissipate
- [x] Reflectivity, velocity, and echo-top views
- [x] Supercells with hook echoes, cycling mesocyclones, tornadoes and debris balls
- [x] Bow echoes (with bookend comma heads and rear-inflow jets), gust fronts, a Derecho day
- [x] Scan-by-scan radar updates (a new volume scan every 4 game minutes)
- [x] Draw SVR / TOR warning cones along storm motion and get scored against storm reports
- [ ] Spot storm cells / tornado cells modes
- [ ] Flash flooding, lightning & the power grid
- [ ] Scenarios: derecho, hurricane, microbursts, snow / sleet / freezing rain, traffic reports
- [ ] Radar DOWN! Track storms from spotter reports only
- [ ] Native builds (Tauri) for Windows, Linux, Android

## Privacy rule (important!)

Nothing personal goes into this repo: no real names, no absolute file paths, no personal emails.
A git hook (`scripts/privacy-check.mjs`, enabled by `npm install`) blocks commits that contain them.
Copy `.privacy-blocklist.example` to `.privacy-blocklist` and put any extra words that must never be committed (like real names) one per line in it. That local
file is git-ignored and never leaves your computer.
