/**
 * Playback search and calendar: request building, response parsing and
 * device-time handling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSearchXml, isEventRecordType, nextRecordingStart, parseCalendar, parseDeviceTime, parsePictureResult, parseSearchResult,
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

  it('parses picture-track results as stored pictures', () => {
    const doc = parseXml(searchPage1.replaceAll('<trackID>101</trackID>', '<trackID>103</trackID>'));
    const { pictures } = parsePictureResult(doc);
    expect(pictures.map(p => p.time.getHours())).toEqual([8, 14]);
    expect(pictures[0].uri).toMatch(/^rtsp:/);
  });

  it('classifies record types', () => {
    expect(isEventRecordType('recordType.meta.std-cgi.com/CMR')).toBe(false);
    expect(isEventRecordType('recordType.meta.hikvision.com/timing')).toBe(false); // DS-7604 continuous
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

// Real device captures from tests/probe-playback.sh, when present (git-ignored)
const captured = import.meta.glob('../fixtures/local/playback-search-*.xml', { query: '?raw', import: 'default', eager: true });
const capturedVideo = Object.entries(captured).find(([path]) => path.endsWith('search-video.xml'))?.[1];
const capturedPictures = Object.entries(captured).find(([path]) => path.endsWith('search-pictures.xml'))?.[1];

describe.runIf(capturedVideo && capturedPictures)('captured device searches', () => {
  it('parses the device’s video search', () => {
    const { status, recordings } = parseSearchResult(parseXml(capturedVideo));
    expect(status).toBe('OK');
    expect(recordings.length).toBeGreaterThan(0);
    expect(recordings.every(r => r.end > r.start && r.uri.startsWith('rtsp://'))).toBe(true);
  });

  it('parses the device’s picture search with fetchable URIs', () => {
    const { pictures } = parsePictureResult(parseXml(capturedPictures));
    expect(pictures.every(p => p.uri.startsWith('http://') && p.uri.includes('/picture/'))).toBe(true);
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

  it('only fetches stored pictures from the connected device', async () => {
    await expect(Isapi.getStoredPicture(config(), 'http://evil.example/picture/x')).rejects.toThrow(/not on the connected device/);
  });

  it('returns no recorded frame when the device answers with something other than a JPEG', async () => {
    vi.stubGlobal('fetch', async () => new Response('<ResponseStatus/>', { status: 200 }));
    expect(await Isapi.getRecordedFrame(config(), '1', new Date())).toBeNull();
  });
});
