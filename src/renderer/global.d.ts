/**
 * Build-time globals injected by `electron-vite.config.ts` via Vite's `define`
 * (#GH-87 About section).
 *
 * Both globals are STRING LITERALS injected at build time — the renderer
 * code reads them like any other constant, no IPC round-trip required.
 *
 * - `__APP_VERSION__`: matches `package.json.version` at build time
 *   (e.g. `'0.1.0'`).
 * - `__BUILD_COMMIT__`: short git SHA from CI / dist:* scripts
 *   (e.g. `'a1b2c3d'`). Falls back to `'dev'` for local builds where the
 *   `BUILD_COMMIT` env var isn't set.
 */
declare const __APP_VERSION__: string;
declare const __BUILD_COMMIT__: string;
