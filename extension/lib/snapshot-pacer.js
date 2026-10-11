/**
 * Live snapshot pacing: which answers are new pictures, when to ask for the
 * next one, and how many new pictures a second a feed really shows.
 *
 * A camera encodes a fresh JPEG for every request, so asking more often
 * shows more pictures. An NVR like the DS-7604NI serves a cached still
 * instead, refreshed about once a second (every 0.65–1.16 s) whatever the
 * polling rate, with no ETag or Last-Modified to ask whether it changed. On
 * such a device most answers are byte-for-byte repeats of the last one:
 * showing them again costs a decode and a redraw for nothing, and counting
 * them makes a 1 fps feed read "5 fps".
 *
 * So a repeat is dropped, and once a device is seen repeating itself, the
 * next request waits most of the way to the next expected picture and then
 * asks in short steps until it arrives (SnapshotPacer.delayMs). Measured on
 * the DS-7604NI: the same 1.1 new pictures a second from 3 requests a second
 * instead of 5. A device that never repeats keeps the fixed interval.
 *
 * Pure: times are passed in, so everything here runs without a device, a
 * page or timers.
 */

/** How many of the latest answers decide whether the device repeats its pictures. */
export const RECENT_ANSWERS = 5;
/** Repeats among the RECENT_ANSWERS latest answers that switch pacing on. */
export const REPEATS_TO_PACE = 2;
/**
 * After a new picture, wait this fraction of the usual time between new
 * pictures. The DS-7604NI's refresh jitters by ±20 %, so waiting the whole
 * interval would miss pictures and add up to a second of delay.
 */
export const HOLD_FRACTION = 0.6;
/** The longest wait after a new picture, so a slow refresh still shows up within a second plus a step. */
export const MAX_HOLD_MS = 1000;
/** How many of the latest intervals between new pictures the usual interval is the median of. */
export const FRAME_INTERVALS_KEPT = 5;

/**
 * Whether two answers are the same picture: the same bytes. Different
 * pictures nearly always differ in length, so most checks end there; equal
 * lengths are compared in full (about 0.1 ms for a 67 KB JPEG).
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function sameFrame(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The median of some numbers.
 * @param {number[]} values - at least one
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One feed's pacing: told about each answer (record), it says whether that
 * was a new picture, how long after the start of that request to send the
 * next one (delayMs), and the feed's rate of new pictures (framesPerSecond).
 *
 * Until the device repeats itself (REPEATS_TO_PACE of the RECENT_ANSWERS
 * latest answers), every request is `intervalMs` after the one before. From
 * then on, after a new picture it waits HOLD_FRACTION of the usual interval
 * between new pictures (at least `intervalMs`, at most MAX_HOLD_MS), and
 * after a repeat only `repeatStepMs`, so the next picture is caught soon
 * after the device has it. Failed requests aren't recorded: how long to wait
 * after those is SnapshotSource's business.
 *
 * @example
 * const pacer = new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });
 * if (pacer.record(bytes, performance.now())) show(bytes);
 * setTimeout(next, pacer.delayMs - (performance.now() - requestStart));
 */
export class SnapshotPacer {
  /**
   * @param {object} timing
   * @param {number} timing.intervalMs - time between the starts of two requests while every
   *   answer is new, and the shortest wait after a new picture
   * @param {number} timing.repeatStepMs - time between the starts of two requests after a repeat
   */
  constructor({ intervalMs, repeatStepMs }) {
    this.intervalMs = intervalMs;
    this.repeatStepMs = repeatStepMs;
    /**
     * The last new picture, which the next answer is compared with.
     * @type {Uint8Array|null}
     */
    this.lastFrame = null;
    /**
     * Whether each of the latest answers (oldest first, at most RECENT_ANSWERS) was a repeat.
     * @type {boolean[]}
     */
    this.recentRepeats = [];
    /**
     * When the latest new pictures arrived (oldest first), one more than FRAME_INTERVALS_KEPT.
     * @type {number[]}
     */
    this.frameTimes = [];
  }

  /**
   * Take note of a successful answer.
   * @param {Uint8Array} bytes - the picture the device sent
   * @param {number} at - when it arrived, in ms (performance.now())
   * @returns {boolean} whether it is a new picture; false for a repeat of the last one
   */
  record(bytes, at) {
    const repeat = this.lastFrame !== null && sameFrame(this.lastFrame, bytes);
    this.recentRepeats.push(repeat);
    if (this.recentRepeats.length > RECENT_ANSWERS) this.recentRepeats.shift();
    if (repeat) return false;
    this.lastFrame = bytes;
    this.frameTimes.push(at);
    if (this.frameTimes.length > FRAME_INTERVALS_KEPT + 1) this.frameTimes.shift();
    return true;
  }

  /** Whether the device has been repeating its pictures, so requests are timed to its refresh. */
  get pacing() {
    return this.recentRepeats.filter(Boolean).length >= REPEATS_TO_PACE;
  }

  /** The usual time between new pictures (the median of the latest intervals), in ms; null before two have arrived. */
  get frameIntervalMs() {
    if (this.frameTimes.length < 2) return null;
    return median(this.frameTimes.slice(1).map((t, i) => t - this.frameTimes[i]));
  }

  /** How long after the start of the latest request to start the next one, in ms. */
  get delayMs() {
    if (!this.pacing) return this.intervalMs;
    if (this.recentRepeats.at(-1)) return this.repeatStepMs;
    const interval = this.frameIntervalMs;
    if (interval === null) return this.intervalMs;
    return Math.max(this.intervalMs, Math.min(HOLD_FRACTION * interval, MAX_HOLD_MS));
  }

  /**
   * New pictures per second: one per usual interval. A feed whose picture
   * hasn't changed for more than two usual intervals reads lower and lower,
   * so a picture the device keeps serving unchanged doesn't pass for live.
   * @param {number} now - in ms (performance.now())
   * @returns {number|null} null before two new pictures have arrived
   */
  framesPerSecond(now) {
    const interval = this.frameIntervalMs;
    if (interval === null) return null;
    const sinceLast = now - this.frameTimes[this.frameTimes.length - 1];
    return 1000 / Math.max(interval, sinceLast / 2);
  }
}
