/**
 * Playback search and calendar: request building, response parsing and
 * device-time handling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSearchXml, isEventRecordType, nextRecordingStart, parseCalendar, parseDeviceTime, parseSearchResult,
  recordingAt, toDeviceTime,
} from '../../extension/lib/playback.js';
import { Isapi } from '../../extension/lib/isapi.js';
import { parseXml } from '../../extension/lib/xml.js';
import searchPage1 from '../fixtures/search-page1.xml?raw';
import searchPage2 from '../fixtures/search-page2.xml?raw';
import calendar from '../fixtures/calendar.xml?raw';

describe('device time', () => {
  it('is local wall-clock time with a Z suffix, not UTC', () => {
    const t = new Date(2026, 9, 10, 14, 5, 9);
    expect(toDeviceTime(t)).toBe('2026-10-10T14:05:09Z');
    expect(parseDeviceTime('2026-10-10T14:05:09Z')).toEqual(t);
    expect(parseDeviceTime('2026-10-10T14:05:09+02:00')).toEqual(t);
    expect(parseDeviceTime('nonsense')).toBeNull();
  });
});

describe('recording search', () => {
  it('builds the request the way the Hikvision web UI does', () => {
    const xml = buildSearchXml({
      searchId: 'abc', trackId: '101', start: new Date(2026, 9, 10), end: new Date(2026, 9, 10, 23, 59, 59), position: 100,
    });
    const root = parseXml(xml).documentElement;
    expect(root.localName).toBe('CMSearchDescription');
    expect(xml).toContain('<searchResultPostion>100</searchResultPostion>'); // sic, as the device expects
    expect(xml).toContain('<startTime>2026-10-10T00:00:00Z</startTime><endTime>2026-10-10T23:59:59Z</endTime>');
    expect(xml).toContain('<trackID>101</trackID>');
  });

  it('parses matches, times and record types', () => {
    const { status, recordings } = parseSearchResult(parseXml(searchPage1));
    expect(status).toBe('MORE');
    expect(recordings.map(r => [r.start.getHours(), r.start.getMinutes(), r.isEvent])).toEqual([[8, 0, false], [14, 5, true]]);
    expect(recordings[1].uri).toContain('name=00000000102000000');
  });

  it('classifies record types', () => {
    expect(isEventRecordType('recordType.meta.std-cgi.com/CMR')).toBe(false);
    expect(isEventRecordType('recordType.meta.hikvision.com/VideoMotion')).toBe(true);
    expect(isEventRecordType('recordType.meta.std-cgi.com/AllEvent')).toBe(true);
    expect(isEventRecordType('')).toBe(false);
  });

  it('finds the recording at a moment and the next one after a gap', () => {
    const { recordings } = parseSearchResult(parseXml(searchPage1));
    expect(recordingAt(recordings, new Date(2026, 9, 10, 8, 15))).toBe(recordings[0]);
    expect(recordingAt(recordings, new Date(2026, 9, 10, 9, 0))).toBeNull();
    expect(nextRecordingStart(recordings, new Date(2026, 9, 10, 9, 0))).toEqual(new Date(2026, 9, 10, 14, 5, 10));
    expect(nextRecordingStart(recordings, new Date(2026, 9, 10, 20, 0))).toBeNull();
  });

  it('parses the month calendar', () => {
    expect(parseCalendar(parseXml(calendar))).toEqual([2, 9, 10]);
  });
});

describe('Isapi playback requests', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = () => ({ host: '10.9.9.8', port: 80, username: `pb${Math.random()}`, password: 'pw' });

  it('follows MORE pages and returns recordings sorted by time', async () => {
    const bodies = [];
    const pages = [searchPage1, searchPage2];
    vi.stubGlobal('fetch', async (url, opts) => {
      bodies.push(opts.body);
      return new Response(pages.shift(), { status: 200 });
    });
    const recordings = await Isapi.searchRecordings(config(), '1', new Date(2026, 9, 10), new Date(2026, 9, 10, 23, 59, 59));
    expect(recordings.map(r => r.start.getHours())).toEqual([6, 8, 14]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('<searchResultPostion>100</searchResultPostion>');
    // One search, one searchID across pages
    expect(/<searchID>([^<]+)/.exec(bodies[0])[1]).toBe(/<searchID>([^<]+)/.exec(bodies[1])[1]);
  });

  it('returns no recorded frame when the device answers with something other than a JPEG', async () => {
    vi.stubGlobal('fetch', async () => new Response('<ResponseStatus/>', { status: 200 }));
    expect(await Isapi.getRecordedFrame(config(), '1', new Date())).toBeNull();
  });
});
