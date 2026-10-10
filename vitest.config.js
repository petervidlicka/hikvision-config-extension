/**
 * Vitest config. Two projects:
 * - node: pure logic (Digest auth against a local HTTP server, network scan)
 * - browser: anything that needs the real browser XML stack or DOM, run
 *   headless in the locally installed Google Chrome (no browser download)
 */
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/node/**/*.test.js'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.js'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { channel: 'chrome' } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
