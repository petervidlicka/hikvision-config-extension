/**
 * Device wall-clock time as floating Dates, and the days of the playback
 * timeline, in whatever time zone this runs in. tests/timezones/ runs the
 * daylight-saving changeover days in zones that have them.
 */
import { describe, expect, it } from 'vitest';
import {
  DAY_MS, addDays, clockOffsetMs, dateKey, dayFraction, deviceNow, endOfDay, formatDate, localWallClock, parseDateKey,
  parseDeviceTime, sameDay, sameMonth, startOfDay, timeAtDayFraction, timeOfDay, toDeviceTime,
} from '../../extension/lib/device-time.js';

/** A floating time from wall-clock fields, with a month counted from 1. */
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));

describe('device times', () => {
  it('keep the device’s wall-clock fields, whatever zone suffix the device adds', () => {
    expect(parseDeviceTime('2026-10-25T12:00:00Z')).toEqual(at(2026, 10, 25, 12));
    // /ISAPI/System/time on the DS-7604NI: 13:23 CEST with an offset that leaves out daylight saving
    expect(parseDeviceTime('2026-10-10T13:23:07+01:00')).toEqual(at(2026, 10, 10, 13, 23, 7));
    expect(parseDeviceTime(' 2026-10-10T13:23:07 ')).toEqual(at(2026, 10, 10, 13, 23, 7));
    expect(toDeviceTime(at(2026, 10, 25, 2, 30))).toBe('2026-10-25T02:30:00Z');
    // Milliseconds (e.g. from a click on the timeline) aren't part of a device time
    expect(toDeviceTime(new Date(at(2026, 10, 25, 12).getTime() + 999))).toBe('2026-10-25T12:00:00Z');
  });

  it('round-trip unchanged', () => {
    for (const text of ['2026-10-25T00:00:00Z', '2026-10-25T02:30:00Z', '2027-03-28T02:30:00Z', '2026-12-31T23:59:59Z']) {
      expect(toDeviceTime(/** @type {Date} */ (parseDeviceTime(text)))).toBe(text);
    }
  });

  it('reject text that isn’t a time on any clock', () => {
    for (const text of ['', 'nonsense', '2026-10-25', '2026-10-25T25:00:00Z', '2026-02-30T10:00:00Z', '2026-13-01T00:00:00Z']) {
      expect(parseDeviceTime(text), text).toBeNull();
    }
  });
});

describe('device days', () => {
  it('are 24 hours, searched from 00:00:00 to 23:59:59', () => {
    const day = at(2026, 10, 25);
    expect(startOfDay(at(2026, 10, 25, 17, 45, 3))).toEqual(day);
    expect(toDeviceTime(endOfDay(day))).toBe('2026-10-25T23:59:59Z');
    expect(endOfDay(at(2026, 10, 25, 12)).getTime() - day.getTime()).toBe(DAY_MS - 1000);
    expect(addDays(day, 1)).toEqual(at(2026, 10, 26));
    expect(addDays(day, -25)).toEqual(at(2026, 9, 30));
    expect(addDays(at(2026, 12, 31, 8), 1)).toEqual(at(2027, 1, 1, 8));
  });

  it('place a time on the day’s timeline by its wall-clock time', () => {
    const day = at(2027, 3, 28);
    expect(dayFraction(at(2027, 3, 28, 12), day) * 24).toBe(12);
    expect(dayFraction(at(2027, 3, 28, 2, 30), day) * 24).toBe(2.5);
    expect(dayFraction(at(2027, 3, 29), day)).toBe(1);
    expect(timeOfDay(timeAtDayFraction(day, 0.5))).toBe('12:00:00');
    expect(timeAtDayFraction(day, 23.5 / 24)).toEqual(at(2027, 3, 28, 23, 30));
    expect(timeOfDay(at(2027, 3, 28, 2, 30, 9))).toBe('02:30:09');
  });

  it('are the dates a date input holds', () => {
    expect(dateKey(at(2026, 10, 25, 23, 59, 59))).toBe('2026-10-25');
    expect(parseDateKey('2026-10-25')).toEqual(at(2026, 10, 25));
    for (const text of ['', '2026-10', '2026-02-30', '25.10.2026']) expect(parseDateKey(text), text).toBeNull();
    expect(sameDay(at(2026, 10, 25), at(2026, 10, 25, 23, 59, 59))).toBe(true);
    expect(sameDay(at(2026, 10, 25, 23, 59, 59), at(2026, 10, 26))).toBe(false);
    expect(sameMonth(at(2026, 10, 1), at(2026, 10, 31, 23))).toBe(true);
    expect(sameMonth(at(2026, 10, 31), at(2026, 11, 1))).toBe(false);
    expect(sameMonth(at(2026, 10, 1), at(2027, 10, 1))).toBe(false);
  });

  it('are formatted on their own date', () => {
    expect(formatDate(at(2026, 10, 25), { day: 'numeric' })).toBe('25');
    expect(formatDate(at(2026, 10, 31, 23, 59), { day: 'numeric' })).toBe('31');
    expect(formatDate(at(2026, 11, 1), { month: 'numeric' })).toBe('11');
  });
});

describe('the device’s clock', () => {
  it('is the browser’s wall clock when the device is in the browser’s zone', () => {
    const moment = new Date(2026, 9, 25, 15, 4, 5);
    expect(localWallClock(moment)).toEqual(at(2026, 10, 25, 15, 4, 5));
    expect(clockOffsetMs(at(2026, 10, 25, 15, 4, 5), moment)).toBe(0);
    expect(deviceNow(0, moment)).toEqual(at(2026, 10, 25, 15, 4, 5));
  });

  it('keeps its offset from the browser’s, so the device’s today is known later without asking again', () => {
    // An NVR 8 hours ahead (e.g. the browser in Prague, the NVR in Tokyo), read at 22:00 browser time
    const readAt = new Date(2026, 9, 24, 22, 0, 0);
    const offset = clockOffsetMs(at(2026, 10, 25, 6, 0, 0), readAt);
    expect(offset).toBe(8 * 3600 * 1000);
    // An hour and a half later the browser is still on the 24th, the device on the 25th
    const later = new Date(readAt.getTime() + 90 * 60 * 1000);
    expect(startOfDay(deviceNow(offset, later))).toEqual(at(2026, 10, 25));
    expect(timeOfDay(deviceNow(offset, later))).toBe('07:30:00');
    // A device behind the browser
    expect(startOfDay(deviceNow(clockOffsetMs(at(2026, 10, 24, 14), readAt), later))).toEqual(at(2026, 10, 24));
  });
});
