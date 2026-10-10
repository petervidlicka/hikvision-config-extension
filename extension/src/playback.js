/**
 * Playback section: a day's recordings on a 24-hour timeline, with day
 * navigation, an events-only filter and, where the device supports it,
 * still images from the recording at the playhead.
 *
 * Browsers can't decode the device's recorded video stream without
 * Hikvision's plugin, so "playing" steps through still frames.
 *
 * Days and times are the device's wall-clock time, as floating Dates (see
 * lib/device-time.js), so a day is always 00:00–23:59:59 on the device's
 * clock, whatever the browser's time zone and on daylight-saving changeover
 * days too. "Today" is the device's today, from its own clock.
 */

import {
  addDays, clockOffsetMs, dateKey, dayFraction, deviceNow, endOfDay, formatDate, localWallClock, sameDay, sameMonth,
  startOfDay, timeAtDayFraction, timeOfDay,
} from '../lib/device-time.js';
import { AuthError } from '../lib/digest-auth.js';
import { NetworkError } from '../lib/errors.js';
import { Isapi } from '../lib/isapi.js';
import { RecordingDaysCache, nextRecordingStart, recordingAt } from '../lib/playback.js';
import { clearFrame, fitStreamAspect, showFrame } from './feed.js';
import { resizeCanvas } from './canvas.js';
import { byId, dom, queryAll, state } from './state.js';
import { errorMessage, setStatus } from './ui.js';

/** @typedef {import('../lib/digest-auth.js').DeviceConfig} DeviceConfig */
/** @typedef {import('../lib/playback.js').Recording} Recording */
/** @typedef {import('../lib/playback.js').RecordKind} RecordKind */
/** @typedef {import('../lib/playback.js').StoredPicture} StoredPicture */

/**
 * @typedef {object} PlaybackState
 * @property {Date} date - the day shown: its midnight on the device's clock, floating
 * @property {number|null} clockOffsetMs - how far the device's clock is ahead of the browser's
 *   (see deviceToday); null until read on this connection
 * @property {Recording[]} recordings - that day's recordings, sorted
 * @property {StoredPicture[]} pictures - that day's stored pictures, sorted
 * @property {number[]} recordingDays - days of that month with recordings
 * @property {RecordingDaysCache} calendar - the shown channel's months asked for so far
 * @property {Date|null} current - playhead position, floating
 * @property {boolean} playing
 * @property {1|2|4} speed - recorded seconds per real second
 * @property {'all'|'events'} filter
 * @property {boolean|null} framesSupported - null until the device has been asked
 * @property {ReturnType<typeof setTimeout>|undefined} timer
 * @property {number} searchId - ignores results of superseded searches
 */

/** Real time between frames while playing. */
const PLAY_TICK_MS = 1000;
/** How close (px) a click must be to a picture marker to open it. */
const MARKER_HIT_PX = 6;
/**
 * Timeline colour per kind of recording. Like iVMS and the web UI, manual
 * and command recordings get their own colours instead of the event red;
 * command uses their teal, manual is orange because their yellow already
 * marks stored pictures here.
 * @type {Record<RecordKind, string>}
 */
const RECORD_COLORS = {
  continuous: 'rgba(74, 108, 247, 0.6)',
  manual: 'rgba(249, 115, 22, 0.75)',
  command: 'rgba(21, 184, 155, 0.75)',
  event: 'rgba(239, 68, 68, 0.75)',
};

/**
 * Playback as a new connection starts it: today by the browser's clock,
 * until the device's own clock is read.
 * @returns {PlaybackState}
 */
export function initialPlaybackState() {
  return {
    date: startOfDay(localWallClock()),
    clockOffsetMs: null,
    recordings: [],
    pictures: [],
    recordingDays: [],
    calendar: new RecordingDaysCache(),
    current: null,
    playing: false,
    speed: 1,
    filter: 'all',
    framesSupported: null,
    timer: undefined,
    searchId: 0,
  };
}

/**
 * The device's date now, which recordings are filed under: by the device's
 * clock once read, by the browser's until then (or when the device doesn't
 * tell its time). The two differ when the browser is in another time zone,
 * so the device's newest day may be the browser's tomorrow or yesterday.
 * @returns {Date} floating midnight
 */
function deviceToday() {
  return startOfDay(deviceNow(state.playback.clockOffsetMs ?? 0));
}

/**
 * Show the Playback section for the active channel. The first time on a
 * connection it reads the device's clock first, and then shows the
 * device's today (unless a visit whose clock read failed showed another
 * day than the browser's today: the user may have picked it).
 * @returns {Promise<void>}
 */
export async function enterPlayback() {
  byId('playbackSection').style.display = 'block';
  byId('playbackBar').style.display = '';
  dom.noFeed.style.display = 'none';
  dom.canvasWrapper.style.display = 'block';
  dom.canvas.style.cursor = 'default';
  clearFrame(dom.videoFeed);

  const pb = state.playback;
  if (pb.clockOffsetMs === null && state.config) {
    const showsToday = pb.searchId === 0 || sameDay(pb.date, deviceToday());
    setInfo('Searching recordings…');
    await readDeviceClock(state.config, pb);
    // Left Playback, or disconnected, while the device answered
    if (state.playback !== pb || state.activeSection !== 'playback') return;
    if (showsToday) pb.date = deviceToday();
  }
  setDate(pb.date);
}

/**
 * Learn how far the device's clock is from the browser's, once per
 * connection. A device that doesn't tell its time (an error answer) leaves
 * the browser's clock to stand in for good.
 * @param {DeviceConfig} config
 * @param {PlaybackState} pb
 * @returns {Promise<void>}
 */
async function readDeviceClock(config, pb) {
  try {
    const time = await Isapi.getDeviceTime(config);
    pb.clockOffsetMs = time ? clockOffsetMs(time) : 0;
  } catch (err) {
    // No answer (NetworkError, TimeoutError): the browser's clock stands in
    // for now and the next visit asks again. The search that follows asks
    // the same device, so it reports the failure. A rejected login has
    // already disconnected (Isapi.onAuthFailure).
    if (!(err instanceof NetworkError || err instanceof AuthError)) throw err;
  }
}

/**
 * Hide the Playback section and stop playing. The still shown last (a
 * 1280×720 stored picture, a recorded frame) goes too: it isn't the live
 * picture, so it mustn't stand in for it under the drawing tools.
 */
export function leavePlayback() {
  pause();
  byId('playbackSection').style.display = 'none';
  byId('playbackBar').style.display = 'none';
  clearFrame(dom.videoFeed);
}

/** Forget everything about the last device (on disconnect). */
export function resetPlayback() {
  leavePlayback();
  state.playback = initialPlaybackState();
}

/**
 * Show a day: update the date controls and search its recordings. Days up
 * to the device's today can be shown, even when that is the browser's
 * tomorrow.
 * @param {Date} date - floating, any time of that day
 */
export function setDate(date) {
  const pb = state.playback;
  pb.date = startOfDay(date);
  pause();

  const today = deviceToday();
  byId('pbDateLabel').textContent = sameDay(pb.date, today) ? 'Today'
    : sameDay(pb.date, addDays(today, -1)) ? 'Yesterday'
      : formatDate(pb.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const input = byId('pbDateInput', HTMLInputElement);
  input.value = dateKey(pb.date);
  input.max = dateKey(today);
  byId('pbDateNext', HTMLButtonElement).disabled = pb.date >= today;

  searchDay();
}

/** @param {number} delta - days to move, e.g. -1 */
export function shiftDate(delta) {
  const next = addDays(state.playback.date, delta);
  if (next > deviceToday()) return;
  setDate(next);
}

/** Search the shown day's recordings (and that month's recording days). */
async function searchDay() {
  const pb = state.playback;
  const config = state.config;
  const channelId = state.activeChannel;
  if (!config || !channelId) return;

  const searchId = ++pb.searchId;
  const date = pb.date;
  setInfo('Searching recordings…');
  setStatus('Playback', `Channel ${channelId}`);
  pb.recordings = [];
  pb.pictures = [];
  pb.current = null;
  renderTimeline();

  const dayEnd = endOfDay(date);
  try {
    const [recordings, pictures, days, ignoresTime] = await Promise.all([
      Isapi.searchRecordings(config, channelId, date, dayEnd),
      Isapi.searchPictures(config, channelId, date, dayEnd).catch(() => []),
      recordingDaysOf(config, channelId, date, pb.calendar),
      // Only ask once per channel whether stills from recordings are real
      pb.framesSupported === null ? Isapi.ignoresRecordedFrameTime(config, channelId) : Promise.resolve(false),
    ]);
    if (searchId !== pb.searchId) return; // a newer search started meanwhile
    pb.recordings = recordings;
    pb.pictures = pictures;
    pb.recordingDays = days;
    if (ignoresTime) pb.framesSupported = false;
    describeDay();
    renderTimeline();
    if (recordings.length > 0) seek(recordings[0].start);
  } catch (err) {
    if (searchId !== pb.searchId || err instanceof AuthError) return;
    setInfo(`Search failed: ${errorMessage(err)}`);
    renderTimeline();
  }
}

/**
 * The days with recordings in a day's month, asked for only when the
 * calendar cache doesn't have them (see RecordingDaysCache).
 * @param {DeviceConfig} config
 * @param {string} channelId
 * @param {Date} date - floating
 * @param {RecordingDaysCache} calendar - the connection's cache
 * @returns {Promise<number[]>} empty when the calendar request failed: it is optional, and asked again next time
 */
async function recordingDaysOf(config, channelId, date, calendar) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const cached = calendar.get(channelId, year, month, { now: performance.now(), currentMonth: sameMonth(date, deviceToday()) });
  if (cached) return cached;
  try {
    return calendar.set(channelId, year, month, await Isapi.getRecordingDays(config, channelId, year, month), performance.now());
  } catch {
    // Only the summary lists these days; the day's own search, sent to the
    // same device at the same time, reports what went wrong
    return [];
  }
}

/** Summary of the day in the sidebar. */
function describeDay() {
  const pb = state.playback;
  const lines = [];
  if (pb.recordings.length === 0) {
    lines.push('No recordings on this day.');
  } else {
    const minutes = Math.round(pb.recordings.reduce((sum, r) => sum + (r.end.getTime() - r.start.getTime()), 0) / 60000);
    const events = pb.recordings.filter(r => r.isEvent).length;
    lines.push(`${pb.recordings.length} recording${pb.recordings.length > 1 ? 's' : ''}, ${formatDuration(minutes)}` +
      (events ? `, ${events} triggered by events` : '') + '.');
  }
  if (pb.pictures.length > 0) {
    lines.push(`${pb.pictures.length} stored picture${pb.pictures.length > 1 ? 's' : ''}: click a yellow marker to view.`);
  }
  if (pb.recordingDays.length > 0) {
    const month = formatDate(pb.date, { month: 'long' });
    lines.push(`Days with recordings in ${month}: ${pb.recordingDays.join(', ')}.`);
  }
  if (pb.framesSupported === false) lines.push(FRAMES_UNSUPPORTED);
  setInfo(lines.join('\n'));
  // Without stills from recordings, playing would only move the playhead
  byId('pbPlayPauseBtn', HTMLButtonElement).disabled = pb.framesSupported === false;
}

const FRAMES_UNSUPPORTED = 'This device doesn’t provide still images from recorded video, so the timeline shows when recordings exist; stored pictures (yellow) can be viewed.';

/** @param {number} minutes */
function formatDuration(minutes) {
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** @param {string} text */
function setInfo(text) {
  byId('pbInfo').textContent = text;
}

/** Draw the day's recordings in their kind's colour (continuous blue, events red) and the stored pictures. */
export function renderTimeline() {
  const pb = state.playback;
  const canvas = byId('pbTimeline', HTMLCanvasElement);
  const wrap = byId('pbTimelineWrap');
  const dpr = window.devicePixelRatio || 1;
  const width = wrap.clientWidth;
  const height = 36;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, width, height);

  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 1;
  for (let h = 1; h < 24; h++) {
    const x = (h / 24) * width;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
  }

  /** @param {Date} t */
  const toX = (t) => dayFraction(t, pb.date) * width;
  for (const r of pb.recordings) {
    if (pb.filter === 'events' && !r.isEvent) continue;
    g.fillStyle = RECORD_COLORS[r.kind];
    const x1 = Math.max(0, toX(r.start));
    g.fillRect(x1, 4, Math.max(toX(r.end) - x1, 2), height - 8);
  }

  g.fillStyle = 'rgba(250, 204, 21, 0.95)';
  for (const p of pb.pictures) g.fillRect(Math.round(toX(p.time)) - 1, 0, 3, height);

  const labels = byId('pbTimelineLabels');
  labels.replaceChildren(...[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => {
    const span = document.createElement('span');
    span.textContent = `${String(h).padStart(2, '0')}:00`;
    return span;
  }));
  updatePlayhead();
}

/** Move the playhead and timestamp to `state.playback.current`. */
function updatePlayhead() {
  const pb = state.playback;
  const playhead = byId('pbPlayhead');
  playhead.style.display = pb.current ? '' : 'none';
  byId('pbTimestamp').textContent = pb.current ? timeOfDay(pb.current) : '--:--:--';
  if (pb.current) {
    playhead.style.left = `${(dayFraction(pb.current, pb.date) * 100).toFixed(3)}%`;
  }
}

/**
 * Jump to a moment and show the frame there.
 * @param {Date} time - floating, kept within the shown day
 */
export function seek(time) {
  const pb = state.playback;
  const dayEnd = endOfDay(pb.date);
  pb.current = time < pb.date ? pb.date : time > dayEnd ? dayEnd : time;
  updatePlayhead();
  showFrameAt(pb.current);
}

/**
 * Click on the timeline: open a stored picture if the click is on its
 * marker, otherwise move the playhead there.
 * @param {MouseEvent} e
 */
export function seekFromClick(e) {
  const pb = state.playback;
  const rect = byId('pbTimelineWrap').getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
  const picture = pb.pictures.find(p => Math.abs(dayFraction(p.time, pb.date) * rect.width - x) <= MARKER_HIT_PX);
  if (picture) {
    showStoredPicture(picture);
    return;
  }
  seek(timeAtDayFraction(pb.date, x / rect.width));
}

/**
 * Lay out a stored picture or recorded frame once it has loaded: at the
 * camera's aspect, like a live frame (a recorded frame is the NVR's squeezed
 * 704×576 still too), with the drawing canvas over it.
 */
function fitPlaybackFrame() {
  fitStreamAspect(dom.videoFeed, state.activeChannel);
  resizeCanvas();
}

/**
 * Show a stored picture and put the playhead at its time.
 * @param {StoredPicture} picture
 */
async function showStoredPicture(picture) {
  const pb = state.playback;
  if (!state.config) return;
  pause();
  pb.current = picture.time;
  updatePlayhead();
  try {
    const blob = await Isapi.getStoredPicture(state.config, picture.uri);
    if (state.activeSection !== 'playback') return;
    dom.videoFeed.onload = fitPlaybackFrame;
    showFrame(dom.videoFeed, blob);
    setStatus(`Stored picture from ${timeOfDay(picture.time)}`);
  } catch (err) {
    if (!(err instanceof AuthError)) setStatus(`Couldn’t load picture: ${errorMessage(err)}`);
  }
}

/** @param {number} seconds */
export function skip(seconds) {
  const current = state.playback.current;
  if (current) seek(new Date(current.getTime() + seconds * 1000));
}

/**
 * Show the recorded frame at a moment, if the device provides one and
 * there's a recording then.
 * @param {Date} time
 * @returns {Promise<void>}
 */
async function showFrameAt(time) {
  const pb = state.playback;
  if (pb.framesSupported === false || !state.config || !state.activeChannel) return;
  if (!recordingAt(pb.recordings, time)) return;
  try {
    const blob = await Isapi.getRecordedFrame(state.config, state.activeChannel, time);
    if (state.activeSection !== 'playback') return;
    if (!blob) {
      if (pb.framesSupported === null) {
        pb.framesSupported = false;
        describeDay();
      }
      return;
    }
    pb.framesSupported = true;
    dom.videoFeed.onload = fitPlaybackFrame;
    showFrame(dom.videoFeed, blob);
  } catch (err) {
    if (!(err instanceof AuthError)) setStatus(`Couldn’t load frame: ${errorMessage(err)}`);
  }
}

/** Start stepping through the recordings from the playhead. */
export function play() {
  const pb = state.playback;
  if (pb.recordings.length === 0) return;
  if (!pb.current) pb.current = pb.recordings[0].start;
  pb.playing = true;
  byId('pbPlayPauseBtn').textContent = '❚❚';

  const tick = async () => {
    if (!pb.playing || !pb.current) return;
    let next = new Date(pb.current.getTime() + pb.speed * 1000);
    if (!recordingAt(pb.recordings, next)) {
      const resume = nextRecordingStart(pb.recordings, next);
      if (!resume) {
        pause();
        return;
      }
      next = resume; // skip gaps between recordings
    }
    pb.current = next;
    updatePlayhead();
    await showFrameAt(next); // one request at a time, like the live feed
    if (pb.playing) pb.timer = setTimeout(tick, PLAY_TICK_MS);
  };
  pb.timer = setTimeout(tick, PLAY_TICK_MS);
}

export function pause() {
  const pb = state.playback;
  pb.playing = false;
  clearTimeout(pb.timer);
  pb.timer = undefined;
  const button = document.getElementById('pbPlayPauseBtn');
  if (button) button.textContent = '▶';
}

export function togglePlay() {
  if (state.playback.playing) pause();
  else play();
}

/** @param {1|2|4} speed */
export function setSpeed(speed) {
  state.playback.speed = speed;
  queryAll(document, '.pb-speed').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.speed) === speed));
}

/** @param {'all'|'events'} filter */
export function setFilter(filter) {
  state.playback.filter = filter;
  renderTimeline();
}

/** The active channel changed while in Playback: search it for the same day. */
export function onPlaybackChannelChange() {
  state.playback.framesSupported = null;
  state.playback.calendar.clear();
  clearFrame(dom.videoFeed);
  setDate(state.playback.date);
}
