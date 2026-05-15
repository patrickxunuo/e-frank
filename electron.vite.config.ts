import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import packageJson from './package.json' with { type: 'json' };

/**
 * Build-time globals (#GH-87 About section). Renderer code reads these via
 * `__APP_VERSION__` and `__BUILD_COMMIT__` (typed in `src/renderer/global.d.ts`).
 *
 * - `__APP_VERSION__`: snapshot of `package.json.version` at build time.
 * - `__BUILD_COMMIT__`: short git SHA, set by CI / dist:* scripts via
 *   `BUILD_COMMIT=$(git rev-parse --short HEAD)`. Falls back to `'dev'`
 *   for local builds where the env var isn't set.
 */
const APP_VERSION_DEFINE = JSON.stringify(packageJson.version);
const BUILD_COMMIT_DEFINE = JSON.stringify(process.env.BUILD_COMMIT ?? 'dev');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
        // Emit as CommonJS so the preload can run with `sandbox: true`.
        // Electron rejects ESM preloads (.mjs) when the renderer is sandboxed.
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    define: {
      __APP_VERSION__: APP_VERSION_DEFINE,
      __BUILD_COMMIT__: BUILD_COMMIT_DEFINE,
    },
  },
});
