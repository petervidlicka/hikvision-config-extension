/**
 * Recording search and calendar requests for playback, and parsing of their
 * results. Formats follow Hikvision's own web UI (playback/search.js):
 * - Device times are local wall-clock time written with a "Z" suffix, e.g.
 *   "2026-10-10T14:05:00Z" means 14:05 on the device's clock, not UTC.
 * - The search request misspells its paging field as <searchResultPostion>.
 *
 * Depends on lib/xml.js.
 */

import { childElement, childElements, childText, findDescendant, xmlPath } from './xml.js';

/** Results per search page; the device answers "MORE" when there are more. */
export const SEARCH_PAGE_SIZE = 100;

/**
 * A recorded stretch of video.
 * @typedef {object} Recording
 * @property {Date} start - device wall-clock time, as a local Date
 * @property {Date} end
 * @property {string} uri - playbackURI, identifies the recording on the device
 * @property {boolean} isEvent - triggered by motion/alarm/etc rather than continuous
 */

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/**
 * Format a Date as device time: its local wall-clock time with a "Z" suffix.
 * @param {Date} date
 * @returns {string}
 */
export function toDeviceTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}Z`;
}

/**
 * Parse a device time as local wall-clock time, ignoring any zone suffix.
 * @param {string} text - e.g. "2026-10-10T14:05:00Z"
 * @returns {Date|null}
 */
export function parseDeviceTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

/** Escape text for an XML element body. @param {string} text */
const escapeXml = (text) => text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c);

/**
 * Body of a recording search (POST /ISAPI/ContentMgmt/search).
 * @param {object} params
 * @param {string} params.searchId - same id for every page of one search
 * @param {string} params.trackId - channel × 100 + 1 for the main stream, e.g. "101"
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {number} params.position - index of the first result on this page
 * @returns {string}
 */
export function buildSearchXml({ searchId, trackId, start, end, position }) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CMSearchDescription>' +
    `<searchID>${escapeXml(searchId)}</searchID>` +
    `<trackList><trackID>${escapeXml(trackId)}</trackID></trackList>` +
    `<timeSpanList><timeSpan><startTime>${toDeviceTime(start)}</startTime><endTime>${toDeviceTime(end)}</endTime></timeSpan></timeSpanList>` +
    `<maxResults>${SEARCH_PAGE_SIZE}</maxResults>` +
    `<searchResultPostion>${position}</searchResultPostion>` +
    '<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>' +
    '</CMSearchDescription>';
}

/**
 * Whether a match was recorded because of an event. The record type is the
 * last part of its metadata descriptor, e.g. "recordType.meta.std-cgi.com/CMR"
 * for continuous recording or ".../VideoMotion" for motion.
 * @param {string} descriptor
 */
export function isEventRecordType(descriptor) {
  const type = descriptor.split('/').pop() ?? '';
  return type !== '' && !/^(CMR|time|timing|continuous|allrecord)$/i.test(type);
}

/**
 * Parse one page of search results.
 * @param {XMLDocument} doc - CMSearchResult
 * @returns {{status: string, recordings: Recording[]}} status is "OK", "MORE" or "NO MATCHES"
 */
export function parseSearchResult(doc) {
  const root = doc.documentElement;
  /** @type {Recording[]} */
  const recordings = [];
  for (const item of childElements(childElement(root, 'matchList'), 'searchMatchItem')) {
    const span = childElement(item, 'timeSpan');
    const start = parseDeviceTime(childText(span, 'startTime') ?? '');
    const end = parseDeviceTime(childText(span, 'endTime') ?? '');
    if (!start || !end) continue;
    const descriptor = findDescendant(item, 'metadataDescriptor')?.textContent?.trim() ?? '';
    recordings.push({
      start,
      end,
      uri: xmlPath(item, 'mediaSegmentDescriptor', 'playbackURI')?.textContent?.trim() ?? '',
      isEvent: isEventRecordType(descriptor),
    });
  }
  return { status: (childText(root, 'responseStatusStrg') ?? '').toUpperCase(), recordings };
}

/**
 * Body of a monthly recording calendar request
 * (POST /ISAPI/ContentMgmt/record/tracks/{trackId}/dailyDistribution).
 * @param {number} year
 * @param {number} month - 1–12
 */
export function buildCalendarXml(year, month) {
  return `<?xml version="1.0" encoding="UTF-8"?><trackDailyParam><year>${year}</year><monthOfYear>${month}</monthOfYear></trackDailyParam>`;
}

/**
 * Days of the month that have recordings.
 * @param {XMLDocument} doc - trackDailyDistribution
 * @returns {number[]} day numbers, 1–31
 */
export function parseCalendar(doc) {
  const days = doc.documentElement.getElementsByTagNameNS('*', 'day');
  return Array.from(days)
    .filter(day => childText(day, 'record') === 'true')
    .map(day => parseInt(childText(day, 'dayOfMonth') ?? '', 10))
    .filter(n => n >= 1 && n <= 31);
}

/**
 * The recording covering a moment, if any.
 * @param {Recording[]} recordings
 * @param {Date} time
 */
export function recordingAt(recordings, time) {
  return recordings.find(r => r.start <= time && time < r.end) ?? null;
}

/**
 * The start of the first recording after a moment, for skipping gaps.
 * @param {Recording[]} recordings - sorted by start
 * @param {Date} time
 */
export function nextRecordingStart(recordings, time) {
  return recordings.find(r => r.start > time)?.start ?? null;
}
