/**
 * Playback days on daylight-saving changeover days, run with the process in
 * zones that have them (vitest.config.js sets TZ per project). There the
 * browser's own day is 23 or 25 hours long; a device day must still be
 * 00:00:00–23:59:59 with 12:00 half-way through, as on the device's clock.
 */
import { describe, expect, it } from 'vitest';
import {
  DAY_MS, addDays, dateKey, dayFraction, endOfDay, formatDate, localWallClock, parseDateKey, parseDeviceTime, startOfDay,
  timeAtDayFraction, timeOfDay, toDeviceTime,
} from '../../../extension/lib/device-time.js';
import { buildSearchXml } from '../../../extension/lib/playback.js';

const HOUR_MS = 3600 * 1000;

/** Each zone's own changeover days in 2026–27, local dates. */
const CHANGEOVERS = {
  'Europe/Prague': { fallBack: '2026-10-25', springForward: '2027-03-28' },
  'America/New_York': { fallBack: '2026-11-01', springForward: '2027-03-14' },
};
const zone = /** @type {keyof typeof CHANGEOVERS} */ (process.env.TZ);
const ALL_DAYS = Object.values(CHANGEOVERS).flatMap(({ fallBack, springForward }) => [fallBack, springForward]);

/** How long the browser's own local day is, by local midnights. @param {string} key - "YYYY-MM-DD" */
const localDayLength = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d + 1).getTime() - new Date(y, m - 1, d).getTime();
};

describe(`playback days with the browser in ${zone}`, () => {
  it('runs in a zone whose changeover days aren’t 24 hours long', () => {
    expect(Object.keys(CHANGEOVERS)).toContain(zone);
    expect(localDayLength(CHANGEOVERS[zone].fallBack)).toBe(25 * HOUR_MS);
    expect(localDayLength(CHANGEOVERS[zone].springForward)).toBe(23 * HOUR_MS);
  });

  for (const key of ALL_DAYS) {
    describe(key, () => {
      const day = /** @type {Date} */ (parseDateKey(key));

      it('is searched from 00:00:00 to 23:59:59', () => {
        expect(endOfDay(day).getTime() - day.getTime()).toBe(DAY_MS - 1000);
        const xml = buildSearchXml({ searchId: 's', trackId: '101', start: day, end: endOfDay(day), position: 0 });
        expect(xml).toContain(`<startTime>${key}T00:00:00Z</startTime><endTime>${key}T23:59:59Z</endTime>`);
      });

      it('plots each time at its own hour', () => {
        for (const [time, hour] of [['00:00:00', 0], ['02:30:00', 2.5], ['12:00:00', 12], ['23:30:00', 23.5]]) {
          const parsed = /** @type {Date} */ (parseDeviceTime(`${key}T${time}Z`));
          // 02:30 doesn't exist on the browser's clock on a spring-forward day, nor is it twice on a fall-back day
          expect(toDeviceTime(parsed)).toBe(`${key}T${time}Z`);
          expect(dayFraction(parsed, day) * 24, time).toBe(hour);
          expect(timeOfDay(timeAtDayFraction(day, Number(hour) / 24))).toBe(time);
        }
      });

      it('steps to the days either side and is labelled with its own date', () => {
        expect(dateKey(addDays(day, 1))).not.toBe(key);
        expect(addDays(addDays(day, 1), -1)).toEqual(day);
        expect(startOfDay(timeAtDayFraction(day, 0.999))).toEqual(day);
        expect(formatDate(day, { day: 'numeric' })).toBe(String(Number(key.slice(8))));
      });
    });
  }

  it('reads the browser’s wall clock as the browser shows it', () => {
    const { fallBack, springForward } = CHANGEOVERS[zone];
    // Late on the long day (the 25th hour since midnight), midday on the short one
    const [fy, fm, fd] = fallBack.split('-').map(Number);
    expect(toDeviceTime(localWallClock(new Date(fy, fm - 1, fd, 23, 30)))).toBe(`${fallBack}T23:30:00Z`);
    const [sy, sm, sd] = springForward.split('-').map(Number);
    expect(toDeviceTime(localWallClock(new Date(sy, sm - 1, sd, 12, 0)))).toBe(`${springForward}T12:00:00Z`);
  });
});
