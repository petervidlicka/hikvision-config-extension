/**
 * Playback section: a day's recordings on a 24-hour timeline, with day
 * navigation, an events-only filter and, where the device supports it,
 * still images from the recording at the playhead.
 *
 * Browsers can't decode the device's recorded video stream without
 * Hikvision's plugin, so "playing" steps through still frames.
 */

import { AuthError } from '../lib/digest-auth.js';
import { Isapi } from '../lib/isapi.js';
import { nextRecordingStart, recordingAt } from '../lib/playback.js';
import { clearFrame, showFrame } from './feed.js';
import { resizeCanvas } from './canvas.js';
import { byId, dom, queryAll, state } from './state.js';
import { errorMessage, setStatus } from './ui.js';

/** @typedef {import('../lib/playback.js').Recording} Recording */

/**
 * @typedef {object} PlaybackState
 * @property {Date} date - the day shown (local midnight)
 * @property {Recording[]} recordings - that day's recordings, sorted
 * @property {number[]} recordingDays - days of that month with recordings
 * @property {Date|null} current - playhead position
 * @property {boolean} playing
 * @property {1|2|4} speed - recorded seconds per real second
 * @property {'all'|'events'} filter
 * @property {boolean|null} framesSupported - null until the device has been asked
 * @property {ReturnType<typeof setTimeout>|undefined} timer
 * @property {number} searchId - ignores results of superseded searches
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Real time between frames while playing. */
const PLAY_TICK_MS = 1000;

/** @returns {PlaybackState} */
export function initialPlaybackState() {
  return {
    date: startOfDay(new Date()),
    recordings: [],
    recordingDays: [],
    current: null,
    playing: false,
    speed: 1,
    filter: 'all',
    framesSupported: null,
    timer: undefined,
    searchId: 0,
  };
}

/** @param {Date} date */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** @param {Date} a @param {Date} b */
function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

/** Show the Playback section for the active channel. */
export function enterPlayback() {
  byId('playbackSection').style.display = 'block';
  byId('playbackBar').style.display = '';
  dom.noFeed.style.display = 'none';
  dom.canvasWrapper.style.display = 'block';
  dom.canvas.style.cursor = 'default';
  clearFrame(dom.videoFeed);
  setDate(state.playback.date);
}

/** Hide the Playback section and stop playing. */
export function leavePlayback() {
  pause();
  byId('playbackSection').style.display = 'none';
  byId('playbackBar').style.display = 'none';
}

/** Forget everything about the last device (on disconnect). */
export function resetPlayback() {
  leavePlayback();
  state.playback = initialPlaybackState();
}

/**
 * Show a day: update the date controls and search its recordings.
 * @param {Date} date
 */
export function setDate(date) {
  const pb = state.playback;
  pb.date = startOfDay(date);
  pause();

  const today = new Date();
  const yesterday = new Date(today.getTime() - DAY_MS);
  byId('pbDateLabel').textContent = sameDay(pb.date, today) ? 'Today'
    : sameDay(pb.date, yesterday) ? 'Yesterday'
      : pb.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const input = byId('pbDateInput', HTMLInputElement);
  input.value = `${pb.date.getFullYear()}-${String(pb.date.getMonth() + 1).padStart(2, '0')}-${String(pb.date.getDate()).padStart(2, '0')}`;
  input.max = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  byId('pbDateNext', HTMLButtonElement).disabled = sameDay(pb.date, today);

  searchDay();
}

/** @param {number} delta - days to move, e.g. -1 */
export function shiftDate(delta) {
  const next = new Date(state.playback.date);
  next.setDate(next.getDate() + delta);
  if (next > new Date()) return;
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
  pb.current = null;
  renderTimeline();

  try {
    const [recordings, days] = await Promise.all([
      Isapi.searchRecordings(config, channelId, date, new Date(date.getTime() + DAY_MS - 1000)),
      Isapi.getRecordingDays(config, channelId, date.getFullYear(), date.getMonth() + 1).catch(() => []),
    ]);
    if (searchId !== pb.searchId) return; // a newer search started meanwhile
    pb.recordings = recordings;
    pb.recordingDays = days;
    describeDay();
    renderTimeline();
    if (recordings.length > 0) seek(recordings[0].start);
  } catch (err) {
    if (searchId !== pb.searchId || err instanceof AuthError) return;
    setInfo(`Search failed: ${errorMessage(err)}`);
    renderTimeline();
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
  if (pb.recordingDays.length > 0) {
    const month = pb.date.toLocaleDateString(undefined, { month: 'long' });
    lines.push(`Days with recordings in ${month}: ${pb.recordingDays.join(', ')}.`);
  }
  if (pb.framesSupported === false) lines.push(FRAMES_UNSUPPORTED);
  setInfo(lines.join('\n'));
}

const FRAMES_UNSUPPORTED = 'This device doesn’t provide still images from recordings, so only the timeline is shown.';

/** @param {number} minutes */
function formatDuration(minutes) {
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** @param {string} text */
function setInfo(text) {
  byId('pbInfo').textContent = text;
}

/** Draw the day's recordings: continuous in blue, events in red. */
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
  const toX = (t) => ((t.getTime() - pb.date.getTime()) / DAY_MS) * width;
  for (const r of pb.recordings) {
    if (pb.filter === 'events' && !r.isEvent) continue;
    g.fillStyle = r.isEvent ? 'rgba(239, 68, 68, 0.75)' : 'rgba(74, 108, 247, 0.6)';
    const x1 = Math.max(0, toX(r.start));
    g.fillRect(x1, 4, Math.max(toX(r.end) - x1, 2), height - 8);
  }

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
  byId('pbTimestamp').textContent = pb.current ? pb.current.toTimeString().slice(0, 8) : '--:--:--';
  if (pb.current) {
    playhead.style.left = `${(((pb.current.getTime() - pb.date.getTime()) / DAY_MS) * 100).toFixed(3)}%`;
  }
}

/**
 * Jump to a moment and show the frame there.
 * @param {Date} time
 */
export function seek(time) {
  const pb = state.playback;
  const dayEnd = new Date(pb.date.getTime() + DAY_MS - 1000);
  pb.current = time < pb.date ? pb.date : time > dayEnd ? dayEnd : time;
  updatePlayhead();
  showFrameAt(pb.current);
}

/** @param {MouseEvent} e - click on the timeline */
export function seekFromClick(e) {
  const rect = byId('pbTimelineWrap').getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  seek(new Date(state.playback.date.getTime() + ratio * DAY_MS));
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
    dom.videoFeed.onload = () => resizeCanvas();
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
  clearFrame(dom.videoFeed);
  setDate(state.playback.date);
}
