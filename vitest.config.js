/**
 * Vitest config. Projects:
 * - node: pure logic in extension/lib (Digest auth against a local HTTP
 *   server, the network scan, snapshots and their pacing, shapes, device
 *   time, picture sizes, the recordings calendar cache)
 * - browser: anything that needs the real browser XML stack or DOM, run
 *   headless in the locally installed Google Chrome (no browser download)
 * - the same in time zones with daylight saving (tests/timezones): playback
 *   days on the days the clocks change, with the process's TZ set (node) or
 *   the browser's time zone emulated (browser)
 */
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/** Zones whose changeover days the timezone tests know (see tests/timezones). */
const NODE_ZONES = ['Europe/Prague', 'America/New_York'];

/**
 * Headless local Chrome, optionally with an emulated time zone.
 * @param {string} [timezoneId]
 */
const chrome = (timezoneId) => ({
  enabled: true,
  headless: true,
  provider: playwright({ launchOptions: { channel: 'chrome' }, ...(timezoneId && { contextOptions: { timezoneId } }) }),
  instances: [{ browser: 'chromium' }],
});

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
          // A desktop-sized page, as the config page is used: the drawing canvas has the picture's
          // size on screen, and the tools aim in screen pixels
          browser: { ...chrome(), viewport: { width: 1280, height: 800 } },
        },
      },
      ...NODE_ZONES.map(zone => ({
        test: {
          name: `node TZ=${zone}`,
          include: ['tests/timezones/node/**/*.test.js'],
          environment: 'node',
          env: { TZ: zone },
        },
      })),
      {
        test: {
          name: 'browser TZ=Europe/Prague',
          include: ['tests/timezones/browser/**/*.test.js'],
          // A desktop-sized page, so the playback timeline is wide enough to tell 12:00 from 11:54
          browser: { ...chrome('Europe/Prague'), viewport: { width: 1280, height: 800 } },
        },
      },
    ],
  },
});
