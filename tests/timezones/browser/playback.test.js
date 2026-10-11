/**
 * Playback in a browser in Europe/Prague (the project emulates the zone, see
 * vitest.config.js) against the mock NVR: the days the clocks change, a
 * device whose date is ahead of the browser's, one that doesn't tell its
 * time, and the month calendar asked for once per month. Steps share one
 * page, so they run in order.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import appHtml from '../../../extension/app.html?raw';
import '../../../extension/app.css';
import { NVR_HOST, STATUS, createChromeStub, createMockNvr } from '../../support/mock-nvr.js';

const HOUR_MS = 3600 * 1000;
const CALENDAR_1 = 'POST /ISAPI/ContentMgmt/record/tracks/101/dailyDistribution';
const CALENDAR_2 = 'POST /ISAPI/ContentMgmt/record/tracks/201/dailyDistribution';

let device, state;
const $ = (id) => document.getElementById(id);
/** How many requests the device got as "METHOD /path". @param {string} request */
const count = (request) => device.requests.filter(r => r === request).length;

/** @param {Date} moment @returns {string} its local date, "YYYY-MM-DD" */
const localDateKey = (moment) =>
  `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(moment.getDate()).padStart(2, '0')}`;

/** The playhead's time of day in seconds. */
const playheadSeconds = () => {
  const [h, m, s] = $('pbTimestamp').textContent.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/**
 * Whether the timeline has something drawn half-way up at a point of the day.
 * @param {number} hour - e.g. 23.75
 */
const drawnAt = (hour) => {
  const canvas = $('pbTimeline');
  const x = Math.floor((hour / 24) * canvas.width);
  return canvas.getContext('2d').getImageData(x, Math.floor(canvas.height / 2), 1, 1).data[3] > 0;
};

/** Wait until the day's search has been answered and shown. */
const searched = () => vi.waitFor(() => expect($('pbInfo').textContent).toMatch(/^\d+ recordings?, /));

/** Connect afresh (Disconnect first when connected) and open Playback, where the device's clock is read. */
async function connectAndOpenPlayback() {
  if (state.connected) $('disconnectBtn').click();
  $('manualEntryBtn').click();
  $('hostInput').value = NVR_HOST;
  $('passInput').value = 'test-pass';
  $('connectBtn').click();
  await vi.waitFor(() => expect(state.channels).toHaveLength(4));
  $('playbackSectionTab').click();
  await searched();
}

/** Show another day by the date picker. @param {string} key - "YYYY-MM-DD" */
async function pickDate(key) {
  $('pbDateInput').value = key;
  $('pbDateInput').dispatchEvent(new Event('change'));
  await searched();
}

beforeAll(async () => {
  const page = new DOMParser().parseFromString(appHtml, 'text/html');
  page.querySelectorAll('script').forEach(s => s.remove());
  document.body.innerHTML = page.body.innerHTML;

  vi.stubGlobal('chrome', createChromeStub().chrome);
  device = createMockNvr({ realFetch: fetch.bind(window) });
  // The last hour of the long day, the hour the short day skips, and midday
  device.recordings = [
    { start: '02:30:00', end: '02:45:00', type: 'CMR' },
    { start: '12:00:00', end: '12:10:00', type: 'VideoMotion' },
    { start: '23:30:00', end: '23:59:59', type: 'CMR' },
  ];
  vi.stubGlobal('fetch', device.fetch);

  await import('../../../extension/src/main.js');
  ({ state } = await import('../../../extension/src/state.js'));
});

describe('playback with the browser in Europe/Prague', () => {
  it('runs where 25 October 2026 lasts 25 hours and 28 March 2027 23', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Prague');
    expect(new Date(2026, 9, 26).getTime() - new Date(2026, 9, 25).getTime()).toBe(25 * HOUR_MS);
    expect(new Date(2027, 2, 29).getTime() - new Date(2027, 2, 28).getTime()).toBe(23 * HOUR_MS);
  });

  it('searches and draws the whole of the day the clocks go back', async () => {
    // The device's own clock (with the "+01:00" the DS-7604NI writes all year) decides which day is today
    device.localTime = '2026-10-25T15:00:00+01:00';
    const searches = device.searches.length;
    await connectAndOpenPlayback();
    expect(count('GET /ISAPI/System/time')).toBe(1);

    expect($('pbDateLabel').textContent).toBe('Today');
    expect($('pbDateInput').value).toBe('2026-10-25');
    expect($('pbDateInput').max).toBe('2026-10-25');
    expect($('pbDateNext').disabled).toBe(true);
    // Video and pictures, each from 00:00:00 to 23:59:59 on the device's clock
    const bodies = device.searches.slice(searches);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain('<startTime>2026-10-25T00:00:00Z</startTime><endTime>2026-10-25T23:59:59Z</endTime>');
    }
    expect($('pbInfo').textContent).toMatch(/^3 recordings, 55 min, 1 triggered by events\./);

    // The first recording at 02:30, a tenth of the way along, and its frame asked for at 02:30
    expect($('pbTimestamp').textContent).toBe('02:30:00');
    expect($('pbPlayhead').style.left).toBe('10.417%');
    await vi.waitFor(() => expect(device.urls)
      .toContain('GET /ISAPI/ContentMgmt/StreamingProxy/channels/101/picture?starttime=2026-10-25T02%3A30%3A00Z'));

    // 12:00 is drawn half-way, and the last hour (23:30) is drawn too
    expect(drawnAt(12.08)).toBe(true);
    expect(drawnAt(11.9)).toBe(false);
    expect(drawnAt(23.75)).toBe(true);
    expect(drawnAt(22.5)).toBe(false);

    // A click half-way along is 12:00 (give or take a pixel)
    const wrap = $('pbTimelineWrap').getBoundingClientRect();
    $('pbTimelineWrap').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: wrap.left + wrap.width / 2, clientY: wrap.top + 5 }));
    expect(Math.abs(playheadSeconds() - 12 * 3600)).toBeLessThan(300);
    expect(parseFloat($('pbPlayhead').style.left)).toBeCloseTo(50, 0);
  });

  it('asks for a month’s calendar once, not for every day', async () => {
    expect(count(CALENDAR_1)).toBe(1);
    $('pbDatePrev').click();
    await searched();
    expect($('pbDateLabel').textContent).toBe('Yesterday');
    expect($('pbDateInput').value).toBe('2026-10-24');
    expect($('pbDateNext').disabled).toBe(false);
    $('pbDateNext').click();
    await searched();
    expect($('pbDateLabel').textContent).toBe('Today');
    expect(count(CALENDAR_1)).toBe(1);

    // Not past the device's today
    const searches = device.searches.length;
    $('pbDateNext').click();
    expect(device.searches).toHaveLength(searches);
    expect($('pbDateInput').value).toBe('2026-10-25');

    // Another month is asked for once too; back in October, it is still known
    await pickDate('2026-09-30');
    expect($('pbInfo').textContent).toContain('Days with recordings in September: 1, 2,');
    expect(count(CALENDAR_1)).toBe(2);
    await pickDate('2026-10-01');
    expect(count(CALENDAR_1)).toBe(2);
    expect($('pbInfo').textContent).toContain('Days with recordings in October: 1, 2,');

    // Another channel, and back: each asks again
    document.querySelectorAll('.channel-item')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await searched();
    expect(count(CALENDAR_2)).toBe(1);
    document.querySelectorAll('.channel-item')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await searched();
    expect(count(CALENDAR_1)).toBe(3);
  });

  it('shows 02:30 on the day the clocks go forward, an hour Prague skips', async () => {
    device.localTime = '2027-03-28T15:00:00+01:00';
    const searches = device.searches.length;
    await connectAndOpenPlayback();
    // Read again for the new connection
    expect(count('GET /ISAPI/System/time')).toBe(2);

    expect($('pbDateLabel').textContent).toBe('Today');
    expect($('pbDateInput').value).toBe('2027-03-28');
    for (const body of device.searches.slice(searches)) {
      expect(body).toContain('<startTime>2027-03-28T00:00:00Z</startTime><endTime>2027-03-28T23:59:59Z</endTime>');
    }
    expect($('pbTimestamp').textContent).toBe('02:30:00');
    expect($('pbPlayhead').style.left).toBe('10.417%');
    await vi.waitFor(() => expect(device.urls)
      .toContain('GET /ISAPI/ContentMgmt/StreamingProxy/channels/101/picture?starttime=2027-03-28T02%3A30%3A00Z'));
    expect(drawnAt(2.6)).toBe(true);
    expect(drawnAt(12.08)).toBe(true);
    expect(drawnAt(11.9)).toBe(false);
  });

  it('reaches the device’s today when it is the browser’s tomorrow', async () => {
    // A device a day ahead of the browser, e.g. across the date line
    const now = new Date();
    const ahead = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, now.getHours(), now.getMinutes());
    const pad = (n) => String(n).padStart(2, '0');
    device.localTime = `${localDateKey(ahead)}T${pad(ahead.getHours())}:${pad(ahead.getMinutes())}:00+01:00`;
    await connectAndOpenPlayback();

    expect($('pbDateLabel').textContent).toBe('Today');
    expect($('pbDateInput').value).toBe(localDateKey(ahead));
    expect($('pbDateInput').max).toBe(localDateKey(ahead));
    expect($('pbDateNext').disabled).toBe(true);
    // The browser's today is the device's yesterday
    $('pbDatePrev').click();
    await searched();
    expect($('pbDateLabel').textContent).toBe('Yesterday');
    expect($('pbDateInput').value).toBe(localDateKey(now));
  });

  it('goes by the browser’s clock when the device doesn’t tell its time', async () => {
    device.localTime = null;
    device.failures['GET /ISAPI/System/time'] = { httpStatus: 403, ...STATUS.notSupport };
    await connectAndOpenPlayback();

    expect($('pbDateLabel').textContent).toBe('Today');
    expect($('pbDateInput').value).toBe(localDateKey(new Date()));
    expect($('pbDateNext').disabled).toBe(true);
    // Asked once on this connection, not on every visit
    const reads = count('GET /ISAPI/System/time');
    $('liveViewSectionTab').click();
    $('playbackSectionTab').click();
    await searched();
    expect(count('GET /ISAPI/System/time')).toBe(reads);
  });
});
