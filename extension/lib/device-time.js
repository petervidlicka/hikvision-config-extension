/**
 * The device's wall-clock time, as playback uses it, and the days of the
 * playback timeline.
 *
 * Hikvision devices write times on their own wall clock with a "Z" suffix:
 * "2026-10-25T12:00:00Z" means 12:00 on the device's clock, not UTC. A
 * device day runs from 00:00:00 to 23:59:59 on that clock. The browser may
 * be in another time zone, and on a daylight-saving changeover day its own
 * day lasts 23 or 25 hours. Kept as browser-local Dates, the fall-back day
 * lost its last hour and 12:00 was drawn at 13:00.
 *
 * So device times are "floating" Dates here: the wall-clock fields stored
 * as if they were UTC, so that only the getUTC* accessors, UTC arithmetic
 * and timeZone: 'UTC' formatting ever read them. Every day is then exactly
 * 24 hours, and 12:00 is half-way through it, whatever the browser's zone.
 * Nothing here converts between zones: the device's offset isn't used at
 * all (the DS-7604NI's /ISAPI/System/time leaves daylight saving out of it).
 *
 * Pure, no imports: runs in a page, a worker or Node.
 */

/** One device day: always 24 hours of wall-clock time. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** A device time's wall-clock part, e.g. "2026-10-25T12:00:00". */
const DEVICE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/** A day as an <input type="date"> holds it, e.g. "2026-10-25". */
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Format a floating time as a device time: its wall-clock fields with a "Z"
 * suffix, as searches and recorded-frame requests expect.
 * @param {Date} time - floating
 * @returns {string} e.g. "2026-10-25T12:00:00Z"
 * @example toDeviceTime(parseDeviceTime('2026-10-25T12:00:00Z')) // '2026-10-25T12:00:00Z'
 */
export function toDeviceTime(time) {
  return `${time.toISOString().slice(0, 19)}Z`;
}

/**
 * Parse a device time as a floating time, ignoring any zone suffix ("Z" in
 * search results, a UTC offset in /ISAPI/System/time).
 * @param {string} text - e.g. "2026-10-25T12:00:00Z" or "2026-10-10T13:23:07+01:00"
 * @returns {Date|null} null when it isn't a device time, or names a moment
 *   that doesn't exist on any clock (e.g. 25:00)
 */
export function parseDeviceTime(text) {
  const match = DEVICE_TIME.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return fieldsHold(new Date(Date.UTC(y, mo - 1, d, h, mi, s)), match[0]);
}

/**
 * The time, unless Date.UTC rolled an out-of-range field over into the
 * next one (Date.UTC(2026, 1, 30) is 2 March), which means the text wasn't
 * a real date.
 * @param {Date} time
 * @param {string} text - what it was built from, "YYYY-MM-DD" or "YYYY-MM-DDThh:mm:ss"
 * @returns {Date|null}
 */
function fieldsHold(time, text) {
  return time.toISOString().startsWith(text) ? time : null;
}

/**
 * The browser's own wall clock at a moment, as a floating time: what a
 * device in the browser's time zone would write for it.
 * @param {Date} [moment] - a real moment (default now)
 * @returns {Date} floating
 */
export function localWallClock(moment = new Date()) {
  return new Date(Date.UTC(moment.getFullYear(), moment.getMonth(), moment.getDate(),
    moment.getHours(), moment.getMinutes(), moment.getSeconds(), moment.getMilliseconds()));
}

/**
 * How far the device's wall clock is ahead of the browser's (negative when
 * behind), from one reading of the device's clock. It stays valid while
 * both clocks run, so the device's time can be known later without asking
 * again (deviceNow); when both are in one zone it is about 0, and it
 * follows the browser through daylight-saving changes.
 * @param {Date} deviceTime - floating: the device's clock, e.g. from /ISAPI/System/time
 * @param {Date} [readAt] - the real moment it was read (default now)
 * @returns {number} milliseconds
 */
export function clockOffsetMs(deviceTime, readAt = new Date()) {
  return deviceTime.getTime() - localWallClock(readAt).getTime();
}

/**
 * The device's wall-clock time at a moment, from its clock offset.
 * @param {number} offsetMs - from clockOffsetMs; 0 takes the browser's clock for the device's
 * @param {Date} [moment] - a real moment (default now)
 * @returns {Date} floating
 * @example startOfDay(deviceNow(offsetMs)) // the device's "today"
 */
export function deviceNow(offsetMs, moment = new Date()) {
  return new Date(localWallClock(moment).getTime() + offsetMs);
}

/**
 * Midnight at the start of a time's day.
 * @param {Date} time - floating
 * @returns {Date} floating
 */
export function startOfDay(time) {
  return new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));
}

/**
 * The last whole second of a time's day (23:59:59), where a search of that
 * day ends.
 * @param {Date} time - floating
 * @returns {Date} floating
 */
export function endOfDay(time) {
  return new Date(startOfDay(time).getTime() + DAY_MS - 1000);
}

/**
 * The same time of day some days later or earlier.
 * @param {Date} time - floating
 * @param {number} days - e.g. -1 for the day before
 * @returns {Date} floating
 */
export function addDays(time, days) {
  return new Date(time.getTime() + days * DAY_MS);
}

/**
 * A time's day as "YYYY-MM-DD": an <input type="date"> value, and a key
 * that two times share exactly when they are on the same day.
 * @param {Date} time - floating
 * @returns {string}
 */
export function dateKey(time) {
  return time.toISOString().slice(0, 10);
}

/**
 * The day an <input type="date"> holds.
 * @param {string} text - "YYYY-MM-DD"
 * @returns {Date|null} its midnight, floating; null for an empty or impossible date
 */
export function parseDateKey(text) {
  const match = DATE_KEY.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d] = match.map(Number);
  return fieldsHold(new Date(Date.UTC(y, mo - 1, d)), match[0]);
}

/**
 * Whether two times are on the same day.
 * @param {Date} a - floating
 * @param {Date} b - floating
 * @returns {boolean}
 */
export function sameDay(a, b) {
  return dateKey(a) === dateKey(b);
}

/**
 * Whether two times are in the same month of the same year.
 * @param {Date} a - floating
 * @param {Date} b - floating
 * @returns {boolean}
 */
export function sameMonth(a, b) {
  return dateKey(a).slice(0, 7) === dateKey(b).slice(0, 7);
}

/**
 * A time's wall-clock time of day.
 * @param {Date} time - floating
 * @returns {string} "hh:mm:ss"
 */
export function timeOfDay(time) {
  return time.toISOString().slice(11, 19);
}

/**
 * How far through a day a time is, for placing it on the day's timeline:
 * 0 at 00:00, 0.5 at 12:00, 1 at the next midnight.
 * @param {Date} time - floating
 * @param {Date} day - floating midnight
 * @returns {number} outside 0–1 for times on other days
 */
export function dayFraction(time, day) {
  return (time.getTime() - day.getTime()) / DAY_MS;
}

/**
 * The time a point on a day's timeline stands for: the inverse of dayFraction.
 * @param {Date} day - floating midnight
 * @param {number} fraction - 0–1
 * @returns {Date} floating
 */
export function timeAtDayFraction(day, fraction) {
  return new Date(day.getTime() + fraction * DAY_MS);
}

/**
 * Format a floating date for people, in the browser's language. Always in
 * UTC, where floating times keep their wall-clock fields.
 * @param {Date} time - floating
 * @param {Omit<Intl.DateTimeFormatOptions, 'timeZone'>} options - e.g. { month: 'long' }
 * @returns {string}
 */
export function formatDate(time, options) {
  return time.toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}
