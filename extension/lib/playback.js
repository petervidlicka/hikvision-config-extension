/**
 * Recording search and calendar requests for playback, and parsing of their
 * results. Formats follow Hikvision's own web UI (playback/search.js):
 * - Device times are the device's wall-clock time written with a "Z" suffix,
 *   e.g. "2026-10-10T14:05:00Z" means 14:05 on the device's clock, not UTC.
 *   They are kept as floating Dates (see lib/device-time.js).
 * - The search request misspells its paging field as <searchResultPostion>.
 * - A page holds at most 64 matches, however many <maxResults> asks for, so
 *   the next page starts after the matches actually received.
 * - One calendar answer covers a month, so it is asked for once per month
 *   (RecordingDaysCache), not with every day's search.
 *
 * Depends on lib/device-time.js and lib/xml.js.
 */

import { parseDeviceTime, toDeviceTime } from './device-time.js';
import { childElement, childElements, childText, findDescendant, xmlPath } from './xml.js';

/**
 * Results to ask for per search page; the device answers "MORE" when there
 * are more. The DS-7604NI never sends more than 64 a page, however many
 * this asks for, so paging never relies on it. 50 is what the web UI's
 * download page asks for (iVMS asks for 40); both stay under that cap.
 */
export const SEARCH_PAGE_SIZE = 50;

/**
 * Why a recording was made, in the categories Hikvision's own clients draw
 * in separate colours (the iVMS playback timeline and the web UI's timebar):
 * - continuous: the recording schedule ("timing", "CMR")
 * - manual: someone started it by hand
 * - command: a platform or alarm host started it
 * - event: motion, alarm, smart events, and any type not recognised
 * Only "event" counts as triggered by an event, as in both clients.
 * @typedef {'continuous'|'manual'|'command'|'event'} RecordKind
 */

/**
 * A recorded stretch of video.
 * @typedef {object} Recording
 * @property {Date} start - the device's wall-clock time, as a floating Date (lib/device-time.js)
 * @property {Date} end - the same
 * @property {string} uri - playbackURI, identifies the recording on the device
 * @property {RecordKind} kind - why it was recorded, for its timeline colour
 * @property {boolean} isEvent - kind is "event": what the events-only filter shows
 */

/**
 * A still picture stored on the device's picture track (scheduled or
 * event-triggered captures).
 * @typedef {object} StoredPicture
 * @property {Date} time - the device's wall-clock time, as a floating Date
 * @property {string} uri - where to fetch it, an http URL on the device
 */

/** Escape text for an XML element body. @param {string} text */
const escapeXml = (text) => text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c);

/**
 * Body of a recording search (POST /ISAPI/ContentMgmt/search).
 * @param {object} params
 * @param {string} params.searchId - same id for every page of one search
 * @param {string} params.trackId - channel × 100 + 1 for the main stream, e.g. "101"
 * @param {Date} params.start - floating
 * @param {Date} params.end - floating
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

/** Record types of scheduled recording, lower-cased ("allrecord" is the search's own "any type"). */
const CONTINUOUS_TYPES = new Set(['cmr', 'time', 'timing', 'continuous', 'allrecord']);

/**
 * Why a match was recorded. The record type is the last part of its metadata
 * descriptor, e.g. "recordType.meta.std-cgi.com/CMR" or
 * "recordType.meta.hikvision.com/timing" for scheduled recording, ".../manual",
 * ".../command" (the device's capabilities spell it "Command"), ".../motion".
 * A type not listed here counts as an event, as in iVMS and the web UI.
 * A match without a type counts as continuous, so that firmware which sends
 * no type doesn't show every recording as an event.
 * @param {string} descriptor - metadataDescriptor text
 * @returns {RecordKind}
 */
export function recordKind(descriptor) {
  const type = (descriptor.split('/').pop() ?? '').trim().toLowerCase();
  if (type === '' || CONTINUOUS_TYPES.has(type)) return 'continuous';
  if (type === 'manual' || type === 'command') return type;
  return 'event';
}

/**
 * Whether a match was recorded because of an event, which decides what the
 * events-only filter shows. Manual and command recordings aren't events.
 * @param {string} descriptor - metadataDescriptor text
 * @returns {boolean}
 */
export function isEventRecordType(descriptor) {
  return recordKind(descriptor) === 'event';
}

/**
 * One page of search results, as the device sent it.
 * @typedef {object} SearchPage
 * @property {string} status - "OK", "MORE" or "NO MATCHES"
 * @property {Element[]} matches - every <searchMatchItem> on the page,
 *   including any that turn out unusable: the next page starts this many
 *   results further on
 */

/**
 * Read one page of search results. <numOfMatches> is deliberately ignored:
 * on the DS-7604NI it is the total for a video search but only this page's
 * count for a picture search, so it can't tell where the next page starts.
 * @param {XMLDocument} doc - CMSearchResult
 * @returns {SearchPage}
 */
export function parseSearchPage(doc) {
  const root = doc.documentElement;
  return {
    status: (childText(root, 'responseStatusStrg') ?? '').toUpperCase(),
    matches: childElements(childElement(root, 'matchList'), 'searchMatchItem'),
  };
}

/**
 * What identifies a match across pages, for dropping repeats when a device
 * pages unreliably: its playbackURI, which names the file and its times, or
 * its times when it has no URI.
 * @param {Element} match - searchMatchItem
 * @returns {string}
 */
export function searchMatchKey(match) {
  const uri = xmlPath(match, 'mediaSegmentDescriptor', 'playbackURI')?.textContent?.trim();
  if (uri) return uri;
  const span = childElement(match, 'timeSpan');
  return `${childText(span, 'startTime') ?? ''}/${childText(span, 'endTime') ?? ''}`;
}

/**
 * Recordings from search matches. Matches without valid times are skipped.
 * @param {Element[]} matches - searchMatchItem elements
 * @returns {Recording[]} in the order given
 */
export function parseRecordings(matches) {
  /** @type {Recording[]} */
  const recordings = [];
  for (const match of matches) {
    const span = childElement(match, 'timeSpan');
    const start = parseDeviceTime(childText(span, 'startTime') ?? '');
    const end = parseDeviceTime(childText(span, 'endTime') ?? '');
    if (!start || !end) continue;
    const kind = recordKind(findDescendant(match, 'metadataDescriptor')?.textContent ?? '');
    recordings.push({
      start,
      end,
      uri: xmlPath(match, 'mediaSegmentDescriptor', 'playbackURI')?.textContent?.trim() ?? '',
      kind,
      isEvent: kind === 'event',
    });
  }
  return recordings;
}

/**
 * Pictures from picture-track matches: the same result format as video,
 * with one moment per match. Matches without a URI to fetch are skipped.
 * @param {Element[]} matches - searchMatchItem elements
 * @returns {StoredPicture[]} in the order given
 */
export function parsePictures(matches) {
  return parseRecordings(matches).filter(r => r.uri).map(r => ({ time: r.start, uri: r.uri }));
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
 * How long a calendar of the device's current month is reused. The month
 * gains days as recording goes on, so after this a new day shows up.
 */
export const CALENDAR_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The days with recordings that calendar requests returned, per channel and
 * month. One answer covers a whole month, so stepping through its days
 * needs one request, not one a day: Hikvision's web UI asks again only when
 * the month changes. Only the device's current month can still change, so
 * only its answer goes stale (CALENDAR_MAX_AGE_MS). Times are passed in.
 *
 * @example
 * const days = cache.get('1', 2026, 10, { now, currentMonth: true })
 *   ?? cache.set('1', 2026, 10, await Isapi.getRecordingDays(config, '1', 2026, 10), now);
 */
export class RecordingDaysCache {
  constructor() {
    /** @type {Map<string, {days: number[], fetchedAt: number}>} */
    this.entries = new Map();
  }

  /**
   * A month's days with recordings, unless they must be asked for (again).
   * @param {string} channelId
   * @param {number} year
   * @param {number} month - 1–12
   * @param {{now: number, currentMonth: boolean}} when - now in ms (any clock that set() is given too),
   *   and whether this is the device's current month
   * @returns {number[]|null} null when not known, or a current month's answer is older than CALENDAR_MAX_AGE_MS
   */
  get(channelId, year, month, { now, currentMonth }) {
    const entry = this.entries.get(`${channelId}/${year}-${month}`);
    if (!entry || (currentMonth && now - entry.fetchedAt > CALENDAR_MAX_AGE_MS)) return null;
    return entry.days;
  }

  /**
   * Keep a month's days with recordings as the device just returned them.
   * @param {string} channelId
   * @param {number} year
   * @param {number} month - 1–12
   * @param {number[]} days
   * @param {number} now - ms, on the clock get() is given
   * @returns {number[]} the days
   */
  set(channelId, year, month, days, now) {
    this.entries.set(`${channelId}/${year}-${month}`, { days, fetchedAt: now });
    return days;
  }

  /** Forget every month, e.g. when another channel is shown. */
  clear() {
    this.entries.clear();
  }
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
