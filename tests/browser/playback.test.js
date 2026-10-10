/**
 * Playback search and calendar: request building, response parsing, paging
 * and device-time handling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDeviceTime, toDeviceTime } from '../../extension/lib/device-time.js';
import {
  SEARCH_PAGE_SIZE, buildSearchXml, isEventRecordType, nextRecordingStart, parseCalendar, parsePictures,
  parseRecordings, parseSearchPage, recordKind, recordingAt, searchMatchKey, storedPicturePath,
} from '../../extension/lib/playback.js';
import { Isapi, MAX_SEARCH_REQUESTS } from '../../extension/lib/isapi.js';
import { parseXml } from '../../extension/lib/xml.js';
import searchPage1 from '../fixtures/search-page1.xml?raw';
import calendar from '../fixtures/calendar.xml?raw';
// The DS-7604NI's answers to one 3-day video search (10-07 to 10-10, 139
// recordings) and one 10-day picture search (113 pictures), page by page.
// Each page holds at most 64 matches although maxResults asked for 100.
import videoP0 from '../fixtures/search-nvr-video-p0.xml?raw';
import videoP64 from '../fixtures/search-nvr-video-p64.xml?raw';
import videoP128 from '../fixtures/search-nvr-video-p128.xml?raw';
import picturesP0 from '../fixtures/search-nvr-pictures-p0.xml?raw';
import picturesP64 from '../fixtures/search-nvr-pictures-p64.xml?raw';

/**
 * A device wall-clock time as the floating Date the extension keeps it as
 * (see lib/device-time.js), with a month counted from 1.
 */
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));

/** @param {string} xml */
const recordingsOf = (xml) => parseRecordings(parseSearchPage(parseXml(xml)).matches);

describe('device time', () => {
  it('is the device’s wall-clock time with a Z suffix, kept as a floating Date', () => {
    const t = at(2026, 10, 10, 14, 5, 9);
    expect(toDeviceTime(t)).toBe('2026-10-10T14:05:09Z');
    expect(parseDeviceTime('2026-10-10T14:05:09Z')).toEqual(t);
    expect(parseDeviceTime('2026-10-10T14:05:09+02:00')).toEqual(t);
    expect(parseDeviceTime('nonsense')).toBeNull();
  });
});

describe('recording search', () => {
  it('builds the request the way the Hikvision web UI does', () => {
    const xml = buildSearchXml({
      searchId: 'abc', trackId: '101', start: at(2026, 10, 10), end: at(2026, 10, 10, 23, 59, 59), position: 64,
    });
    const root = parseXml(xml).documentElement;
    expect(root.localName).toBe('CMSearchDescription');
    expect(xml).toContain('<searchResultPostion>64</searchResultPostion>'); // sic, as the device expects
    expect(xml).toContain('<startTime>2026-10-10T00:00:00Z</startTime><endTime>2026-10-10T23:59:59Z</endTime>');
    expect(xml).toContain('<trackID>101</trackID>');
    // Under the device's 64-a-page cap, like the web UI's download page
    expect(xml).toContain(`<maxResults>${SEARCH_PAGE_SIZE}</maxResults>`);
    expect(SEARCH_PAGE_SIZE).toBeLessThanOrEqual(64);
  });

  it('parses matches, times and record types', () => {
    const { status, matches } = parseSearchPage(parseXml(searchPage1));
    expect(status).toBe('MORE');
    const recordings = parseRecordings(matches);
    expect(recordings.map(r => [r.start.getUTCHours(), r.start.getUTCMinutes(), r.kind, r.isEvent]))
      .toEqual([[8, 0, 'continuous', false], [14, 5, 'event', true]]);
    expect(recordings[1].uri).toContain('name=00000000102000000');
  });

  it('reads every match on a real page and ignores numOfMatches', () => {
    // Video: numOfMatches is the search's total (139), not this page's 64
    const video = parseSearchPage(parseXml(videoP0));
    expect(video.status).toBe('MORE');
    expect(video.matches).toHaveLength(64);
    const recordings = parseRecordings(video.matches);
    expect(recordings).toHaveLength(64);
    expect(recordings.every(r => r.kind === 'continuous' && r.uri.startsWith('rtsp://'))).toBe(true); // ".../timing"
    // Pictures: numOfMatches is only this page's count
    const pictures = parseSearchPage(parseXml(picturesP0));
    expect(pictures.status).toBe('MORE');
    expect(pictures.matches).toHaveLength(64);
    expect(parsePictures(pictures.matches).every(p => p.uri.startsWith('http://'))).toBe(true);
  });

  it('identifies a match by its playbackURI, or by its times without one', () => {
    const [first] = parseSearchPage(parseXml(videoP0)).matches;
    expect(searchMatchKey(first)).toMatch(/^rtsp:\/\/.*name=00000000492000000/);
    first.getElementsByTagNameNS('*', 'mediaSegmentDescriptor')[0].remove();
    expect(searchMatchKey(first)).toBe('2026-10-06T23:34:07Z/2026-10-07T00:12:11Z');
  });

  it('parses picture-track results as stored pictures', () => {
    const doc = parseXml(searchPage1.replaceAll('<trackID>101</trackID>', '<trackID>103</trackID>'));
    const pictures = parsePictures(parseSearchPage(doc).matches);
    expect(pictures.map(p => p.time.getUTCHours())).toEqual([8, 14]);
    expect(pictures[0].uri).toMatch(/^rtsp:/);
  });

  it('classifies record types the way iVMS and the web UI do', () => {
    // Scheduled recording
    expect(recordKind('recordType.meta.std-cgi.com/CMR')).toBe('continuous');
    expect(recordKind('recordType.meta.hikvision.com/timing')).toBe('continuous'); // DS-7604 continuous
    expect(recordKind('')).toBe('continuous');
    // Their own non-event categories, whatever the case
    expect(recordKind('recordType.meta.hikvision.com/manual')).toBe('manual');
    expect(recordKind('recordType.meta.hikvision.com/command')).toBe('command');
    expect(recordKind('recordType.meta.std-cgi.com/Command')).toBe('command');
    // Events, and anything not recognised
    for (const type of ['motion', 'alarm', 'motionOrAlarm', 'motionAndAlarm', 'smart', 'personOrVehicel', 'VideoMotion', 'AllEvent', 'somethingNew']) {
      expect(recordKind(`recordType.meta.hikvision.com/${type}`), type).toBe('event');
    }

    expect(isEventRecordType('recordType.meta.std-cgi.com/CMR')).toBe(false);
    expect(isEventRecordType('recordType.meta.hikvision.com/manual')).toBe(false);
    expect(isEventRecordType('recordType.meta.hikvision.com/command')).toBe(false);
    expect(isEventRecordType('recordType.meta.hikvision.com/motion')).toBe(true);
    expect(isEventRecordType('recordType.meta.hikvision.com/personOrVehicel')).toBe(true);
    expect(isEventRecordType('')).toBe(false);
  });

  it('finds the recording at a moment and the next one after a gap', () => {
    const recordings = recordingsOf(searchPage1);
    expect(recordingAt(recordings, at(2026, 10, 10, 8, 15))).toBe(recordings[0]);
    expect(recordingAt(recordings, at(2026, 10, 10, 9, 0))).toBeNull();
    expect(nextRecordingStart(recordings, at(2026, 10, 10, 9, 0))).toEqual(at(2026, 10, 10, 14, 5, 10));
    expect(nextRecordingStart(recordings, at(2026, 10, 10, 20, 0))).toBeNull();
  });

  it('parses the month calendar', () => {
    expect(parseCalendar(parseXml(calendar))).toEqual([2, 9, 10]);
  });

  it('takes a stored picture’s path and query from its URI, whatever scheme, host and port it names', () => {
    const pictures = parsePictures(parseSearchPage(parseXml(picturesP0)).matches);
    expect(pictures.length).toBeGreaterThan(0);
    for (const { uri } of pictures) expect(storedPicturePath(uri)).toBe(uri.slice('http://192.168.0.108'.length));
    expect(storedPicturePath(pictures[0].uri)).toMatch(/^\/picture\/Streaming\/tracks\/103\/\?starttime=20261001T031019Z&endtime=/);

    const path = '/picture/Streaming/tracks/103/?name=ch01_7&size=95018';
    // The Host header echoed back with curl's trailing dot, a proxy's address, another scheme, or just the path
    for (const uri of [`http://192.168.0.108.${path}`, `https://Proxy.example:8443${path}`, `rtsp://10.0.0.5${path}`, path]) {
      expect(storedPicturePath(uri), uri).toBe(path);
    }
  });

  it('refuses any other resource as a stored picture, also through dot segments', () => {
    for (const uri of ['http://192.168.0.108/ISAPI/Security/users', 'http://192.168.0.108/picture/../ISAPI/Security/users',
      'http://192.168.0.108/picture/%2E%2E/ISAPI/Security/users', 'http://192.168.0.108/Picture/x', '/pictures/x', 'http://']) {
      expect(() => storedPicturePath(uri), uri).toThrow(/isn’t a stored picture/);
    }
  });
});

// Real device captures from tests/probe-playback.sh, when present (git-ignored)
const captured = import.meta.glob('../fixtures/local/playback-search-*.xml', { query: '?raw', import: 'default', eager: true });
const capturedVideo = Object.entries(captured).find(([path]) => path.endsWith('search-video.xml'))?.[1];
const capturedPictures = Object.entries(captured).find(([path]) => path.endsWith('search-pictures.xml'))?.[1];

describe.runIf(capturedVideo && capturedPictures)('captured device searches', () => {
  it('parses the device’s video search', () => {
    const { status, matches } = parseSearchPage(parseXml(capturedVideo));
    expect(status).toBe('OK');
    const recordings = parseRecordings(matches);
    expect(recordings.length).toBeGreaterThan(0);
    expect(recordings.every(r => r.end > r.start && r.uri.startsWith('rtsp://'))).toBe(true);
  });

  it('parses the device’s picture search with fetchable URIs', () => {
    const pictures = parsePictures(parseSearchPage(parseXml(capturedPictures)).matches);
    expect(pictures.every(p => p.uri.startsWith('http://') && p.uri.includes('/picture/'))).toBe(true);
  });
});

describe('Isapi playback requests', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = () => ({ host: '10.9.9.8', port: 80, username: `pb${Math.random()}`, password: 'pw' });

  /** @param {string} body */
  const positionOf = (body) => Number(/<searchResultPostion>(\d+)</.exec(body)[1]);

  /**
   * Answer searches like the device: the page for each request's position.
   * @param {(position: number) => string} pageAt
   * @returns {string[]} the request bodies, filled in as requests arrive
   */
  function stubSearch(pageAt) {
    const bodies = [];
    vi.stubGlobal('fetch', async (url, opts) => {
      bodies.push(String(opts.body));
      return new Response(pageAt(positionOf(String(opts.body))), { status: 200 });
    });
    return bodies;
  }

  /** @param {Record<number, string>} pages - by position */
  const pagesAt = (pages) => (position) => {
    if (!(position in pages)) throw new Error(`No page at position ${position}`);
    return pages[position];
  };

  /** @param {string} xml @returns {string[]} the page's searchMatchItem elements, as text */
  const matchItems = (xml) => xml.match(/<searchMatchItem>[\s\S]*?<\/searchMatchItem>/g) ?? [];
  /** @param {string} xml @param {string[]} items @returns {string} the page with these matches instead */
  const withMatches = (xml, items) => xml.replace(/<matchList>[\s\S]*<\/matchList>/, () => `<matchList>${items.join('')}</matchList>`);

  const threeDays = [at(2026, 10, 7), at(2026, 10, 10, 23, 59, 59)];

  it('steps by the matches received, not by the page size or numOfMatches', async () => {
    const bodies = stubSearch(pagesAt({ 0: videoP0, 64: videoP64, 128: videoP128 }));
    const recordings = await Isapi.searchRecordings(config(), '1', ...threeDays);
    // The device sent 64 although asked for more, and numOfMatches said 139
    expect(bodies.map(positionOf)).toEqual([0, 64, 128]);
    expect(bodies[1]).toContain('<searchResultPostion>64</searchResultPostion>');
    expect(bodies.every(b => b.includes('<trackID>101</trackID>'))).toBe(true);
    // One search, one searchID across pages
    expect(new Set(bodies.map(b => /<searchID>([^<]+)/.exec(b)[1])).size).toBe(1);
    // All 139, including the ~22 hours a 100-step would skip (positions 64–99)
    expect(recordings).toHaveLength(139);
    expect(new Set(recordings.map(r => r.uri)).size).toBe(139);
    expect(recordings.some(r => r.start.getTime() === at(2026, 10, 8, 15, 44, 49).getTime())).toBe(true);
    expect(recordings.map(r => r.start.getTime())).toEqual(recordings.map(r => r.start.getTime()).sort((a, b) => a - b));
    expect(recordings.at(-1).start).toEqual(at(2026, 10, 10, 13, 8, 3));
  });

  it('pages picture searches the same way, where numOfMatches is only the page’s count', async () => {
    const bodies = stubSearch(pagesAt({ 0: picturesP0, 64: picturesP64 }));
    const pictures = await Isapi.searchPictures(config(), '1', at(2026, 10, 1), at(2026, 10, 10, 23, 59, 59));
    expect(bodies.map(positionOf)).toEqual([0, 64]);
    expect(bodies.every(b => b.includes('<trackID>103</trackID>'))).toBe(true);
    expect(pictures).toHaveLength(113);
    expect(pictures[0].time).toEqual(at(2026, 10, 1, 3, 10, 19));
    expect(pictures.at(-1).time).toEqual(at(2026, 10, 10, 12, 7, 47));
  });

  it('drops repeats when pages overlap', async () => {
    // The device's real answer for position 100: 28 matches the page at 64
    // already held, then the last 11
    const p100 = withMatches(videoP128, [...matchItems(videoP64).slice(36), ...matchItems(videoP128)]);
    const bodies = stubSearch(pagesAt({ 0: videoP0, 64: videoP64, 128: p100 }));
    const recordings = await Isapi.searchRecordings(config(), '1', ...threeDays);
    expect(bodies).toHaveLength(3);
    expect(recordings).toHaveLength(139);
    expect(new Set(recordings.map(r => r.uri)).size).toBe(139);
  });

  it('stops when the device ignores the position and repeats its first page', async () => {
    const bodies = stubSearch(() => videoP0);
    const recordings = await Isapi.searchRecordings(config(), '1', ...threeDays);
    expect(bodies.map(positionOf)).toEqual([0, 64]);
    expect(recordings).toHaveLength(64);
  });

  it('stops on an empty page even when it says MORE', async () => {
    const bodies = stubSearch(pagesAt({ 0: videoP0, 64: withMatches(videoP0, []) }));
    expect(await Isapi.searchRecordings(config(), '1', ...threeDays)).toHaveLength(64);
    expect(bodies).toHaveLength(2);
  });

  it('stops after a bounded number of requests when the device never stops answering MORE', async () => {
    // A new single-match page for every position
    const [match] = matchItems(videoP0);
    const bodies = stubSearch(position => withMatches(videoP0, [match.replace('name=00000000492000000', `name=${position}`)]));
    const recordings = await Isapi.searchRecordings(config(), '1', ...threeDays);
    expect(bodies).toHaveLength(MAX_SEARCH_REQUESTS);
    expect(bodies.map(positionOf).slice(0, 3)).toEqual([0, 1, 2]);
    expect(recordings).toHaveLength(MAX_SEARCH_REQUESTS);
  });

  /**
   * Answer every request with a JPEG.
   * @returns {string[]} the requested URLs, in order
   */
  function stubPictures() {
    const urls = [];
    vi.stubGlobal('fetch', async (url) => {
      urls.push(String(url));
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    });
    return urls;
  }

  it('fetches a stored picture from the connected device, whatever address its URI names', async () => {
    const urls = stubPictures();
    const blob = await Isapi.getStoredPicture(config(), 'http://evil.example/picture/x?name=a');
    expect(urls).toEqual(['http://10.9.9.8:80/picture/x?name=a']);
    expect(blob.type).toBe('image/jpeg');

    // The DS-7604NI writes back the Host header, which the browser lower-cases
    const named = { ...config(), host: 'NVR-Office' };
    await Isapi.getStoredPicture(named, 'http://nvr-office/picture/Streaming/tracks/103/?starttime=20261010T004608Z&name=ch01_7&size=95018');
    expect(urls[1]).toBe('http://NVR-Office:80/picture/Streaming/tracks/103/?starttime=20261010T004608Z&name=ch01_7&size=95018');
  });

  it('fetches nothing but stored pictures', async () => {
    const urls = stubPictures();
    for (const uri of ['http://10.9.9.8/ISAPI/Security/users', 'http://10.9.9.8/picture/../ISAPI/Security/users',
      'http://10.9.9.8/picture/%2e%2e/ISAPI/Security/users', 'http://10.9.9.8/pictures/x', 'http://10.9.9.8/picture', 'http://']) {
      await expect(Isapi.getStoredPicture(config(), uri), uri).rejects.toThrow(/isn’t a stored picture/);
    }
    expect(urls).toEqual([]);
  });

  it('returns no recorded frame when the device answers with something other than a JPEG', async () => {
    vi.stubGlobal('fetch', async () => new Response('<ResponseStatus/>', { status: 200 }));
    expect(await Isapi.getRecordedFrame(config(), '1', new Date())).toBeNull();
  });
});
