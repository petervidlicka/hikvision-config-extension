/**
 * Snapshot pacing without a device or timers: telling repeats from new
 * pictures, when to ask next on a camera (always new) and on an NVR whose
 * still changes about once a second, and the rate of new pictures.
 */
import { describe, expect, it } from 'vitest';
import { MAX_HOLD_MS, RECENT_ANSWERS, SnapshotPacer, sameFrame } from '../../extension/lib/snapshot-pacer.js';

/** A picture's bytes, different for each `n`. */
const picture = (n) => new Uint8Array([0xff, 0xd8, n >> 8, n & 0xff]);

/**
 * Feed a pacer answers as a device would give them.
 * @param {SnapshotPacer} pacer
 * @param {Array<[number, number]>} answers - [arrival time in ms, picture number]
 * @returns {Array<{isNew: boolean, delayMs: number}>} what the pacer said after each
 */
function answer(pacer, answers) {
  return answers.map(([at, n]) => ({ isNew: pacer.record(picture(n), at), delayMs: pacer.delayMs }));
}

describe('sameFrame', () => {
  it('compares lengths first, then every byte', () => {
    expect(sameFrame(picture(1), picture(1))).toBe(true);
    expect(sameFrame(picture(1), new Uint8Array([0xff, 0xd8, 0]))).toBe(false);
    expect(sameFrame(picture(1), picture(2))).toBe(false);
    expect(sameFrame(new Uint8Array(70000), new Uint8Array(70000))).toBe(true);
  });
});

describe('SnapshotPacer', () => {
  it('keeps the fixed interval for a camera, whose every answer is a new picture', () => {
    const pacer = new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });
    const said = answer(pacer, Array.from({ length: 10 }, (_, i) => [i * 200, i]));
    expect(said.every(s => s.isNew && s.delayMs === 200)).toBe(true);
    expect(pacer.pacing).toBe(false);
    expect(pacer.framesPerSecond(1800)).toBe(5);
  });

  it('drops repeats, and once the device repeats itself, waits most of the way to its next picture', () => {
    const pacer = new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });
    // The DS-7604NI: one cached still a second, a request every ~0.2 s
    const said = answer(pacer, [[200, 1], [400, 1], [600, 1], [800, 1], [1000, 2], [1600, 2], [1800, 2], [2000, 3]]);
    expect(said.map(s => s.isNew)).toEqual([true, false, false, false, true, false, false, true]);
    expect(said.map(s => s.delayMs)).toEqual([
      200, // a first answer says nothing about the device
      200, // one repeat could be chance
      150, // two: ask again soon until the picture changes
      150,
      480, // a new picture 800 ms after the last: wait 0.6 × 800
      150,
      150,
      540, // the median of 800 and 1000 ms, × 0.6
    ]);
    expect(pacer.pacing).toBe(true);
  });

  it('waits at least the fixed interval and at most a second after a new picture', () => {
    const slow = new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });
    answer(slow, [[0, 1], [150, 1], [300, 1], [3000, 2], [3150, 2], [3300, 2], [6000, 3]]);
    expect(slow.delayMs).toBe(MAX_HOLD_MS);

    const grid = new SnapshotPacer({ intervalMs: 500, repeatStepMs: 500 });
    answer(grid, [[0, 1], [100, 1], [200, 1], [600, 2]]);
    expect(grid.delayMs).toBe(500); // 0.6 × 600 = 360, below the grid's interval
  });

  it('goes back to the fixed interval once the device stops repeating itself', () => {
    const pacer = new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });
    answer(pacer, [[0, 1], [200, 1], [400, 1]]);
    expect(pacer.pacing).toBe(true);
    const said = answer(pacer, Array.from({ length: RECENT_ANSWERS }, (_, i) => [600 + i * 200, i + 2]));
    expect(said.at(-1)?.delayMs).toBe(200);
    expect(pacer.pacing).toBe(false);
  });

  it('takes the usual interval between new pictures as the median, so one late picture doesn’t skew it', () => {
    const pacer = new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });
    answer(pacer, [[0, 1], [1000, 2], [2000, 3], [7000, 4], [8000, 5], [9000, 6]]);
    expect(pacer.frameIntervalMs).toBe(1000);
  });

  it('counts new pictures only, and reads lower while the picture stays the same', () => {
    const pacer = new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });
    expect(pacer.framesPerSecond(0)).toBeNull();
    answer(pacer, [[0, 1], [200, 1], [400, 1], [600, 1], [800, 1], [1000, 2]]);
    expect(pacer.framesPerSecond(1000)).toBe(1);
    expect(pacer.framesPerSecond(2900)).toBe(1); // a picture a little late is still the usual rate
    // The device keeps serving the same picture: 10 s on, 0.2 fps
    answer(pacer, Array.from({ length: 50 }, (_, i) => [1200 + i * 200, 2]));
    expect(pacer.framesPerSecond(11000)).toBe(0.2);
  });
});
