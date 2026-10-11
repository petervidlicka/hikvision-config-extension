/**
 * The playback calendar cache: one calendar request per channel and month,
 * asked again only while the device's current month can still gain days.
 */
import { describe, expect, it } from 'vitest';
import { CALENDAR_MAX_AGE_MS, RecordingDaysCache } from '../../extension/lib/playback.js';

describe('RecordingDaysCache', () => {
  const past = { currentMonth: false };
  const current = { currentMonth: true };

  it('keeps a month’s days for every day of that month', () => {
    const cache = new RecordingDaysCache();
    expect(cache.get('1', 2026, 9, { now: 0, ...past })).toBeNull();
    expect(cache.set('1', 2026, 9, [1, 2, 30], 0)).toEqual([1, 2, 30]);
    expect(cache.get('1', 2026, 9, { now: 3_600_000, ...past })).toEqual([1, 2, 30]);
    // Hours later, a past month is still what the device said
    expect(cache.get('1', 2026, 9, { now: 24 * 3_600_000, ...past })).toEqual([1, 2, 30]);
  });

  it('asks again for another month, year or channel', () => {
    const cache = new RecordingDaysCache();
    cache.set('1', 2026, 9, [1], 0);
    expect(cache.get('1', 2026, 10, { now: 0, ...past })).toBeNull();
    expect(cache.get('1', 2025, 9, { now: 0, ...past })).toBeNull();
    expect(cache.get('2', 2026, 9, { now: 0, ...past })).toBeNull();
  });

  it('asks again for the current month once its answer is a few minutes old', () => {
    const cache = new RecordingDaysCache();
    cache.set('1', 2026, 10, [1, 9], 1000);
    expect(cache.get('1', 2026, 10, { now: 1000 + CALENDAR_MAX_AGE_MS, ...current })).toEqual([1, 9]);
    expect(cache.get('1', 2026, 10, { now: 1001 + CALENDAR_MAX_AGE_MS, ...current })).toBeNull();
    cache.set('1', 2026, 10, [1, 9, 10], 2000 + CALENDAR_MAX_AGE_MS);
    expect(cache.get('1', 2026, 10, { now: 2000 + CALENDAR_MAX_AGE_MS, ...current })).toEqual([1, 9, 10]);
  });

  it('forgets everything when cleared', () => {
    const cache = new RecordingDaysCache();
    cache.set('1', 2026, 9, [1], 0);
    cache.set('1', 2026, 10, [1], 0);
    cache.clear();
    expect(cache.get('1', 2026, 9, { now: 0, ...past })).toBeNull();
    expect(cache.get('1', 2026, 10, { now: 0, ...past })).toBeNull();
  });
});
