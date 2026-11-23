# Radar Spotters – notes for AI assistants

## PRIVACY IS THE #1 RULE
- Never commit or push personal info: real names, absolute file paths (home folders etc.),
  personal email addresses, machine names, or anything else identifying.
- Use relative paths only. Credits use handles, never real names.
- Commits are authored as `mj-fuzz` with the GitHub no-reply email. Do not use any other identity.
- Do not add session links or other identifying trailers to commit messages.
- The pre-commit / commit-msg hooks (`.githooks/`, `scripts/privacy-check.mjs`) must stay enabled:
  run `git config core.hooksPath .githooks` (done by `npm install`). Never bypass them with `--no-verify`.

## Project
- Web-first TypeScript + Canvas 2D game built with Vite; PWA (`public/manifest.webmanifest`, `public/sw.js`).
- Later: wrap with Tauri 2 for Windows / Linux / Android.
- `npm run dev`, `npm run build` (typechecks), `npm run privacy-check`.
- Sim units: game minutes, kilometres; x east, y north; radar at (0,0); range 230 km on a 512² grid.
- In dev builds `window.rs` exposes `{ weather, view, scope, fields, setMode, newDay }` for poking at the sim.
- This is a family project built with a kid: keep things fun, readable, and well commented.
