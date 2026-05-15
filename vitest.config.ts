import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  // Renderer code (`useAppInfo`, etc.) references build-time defines that
  // the production build injects via `electron.vite.config.ts`. Match them
  // here so the symbols resolve in unit tests.
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_COMMIT__: JSON.stringify('test-commit'),
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    // Per-file overrides via `// @vitest-environment jsdom` directive are honored automatically.
  },
});
