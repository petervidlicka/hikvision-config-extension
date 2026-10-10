/**
 * Live snapshot feeds for the single view and the 4-camera grid. A channel
 * that stops delivering frames shows "No signal", over its last frame when
 * there is one, which is then dimmed as stale (see lib/snapshots.js for how
 * often it is asked meanwhile). A repeat of the last frame isn't shown again
 * or counted, so the fps readout is the rate of new pictures (see
 * lib/snapshot-pacer.js). No feed asks the device for anything while the
 * page is hidden.
 */

import { Isapi } from '../lib/isapi.js';
import { SnapshotPacer } from '../lib/snapshot-pacer.js';
import { pollSnapshots } from '../lib/snapshots.js';
import { redraw, resizeCanvas } from './canvas.js';
import { byId, dom, query, queryAll, state } from './state.js';
import { channelInfo, errorMessage, setStatus } from './ui.js';

/** @typedef {import('../lib/snapshots.js').SnapshotStream} SnapshotStream */

/** Stop all 4-cam grid snapshot loops. */
export function stopAllGridFeeds() {
  state.gridFeedStops.forEach(stop => stop?.());
  state.gridFeedStops = [null, null, null, null];
}

/** Stop the single-view snapshot loop, and drop its "No signal" overlay. */
export function stopSnapshotFeed() {
  state.stopSnapshotFeed?.();
  state.stopSnapshotFeed = null;
  dom.canvasContainer.classList.remove('no-signal');
}

// ─── Video Feed ─────────────────────────────────────────────────────────────

/**
 * Time between snapshot requests in the single view while every answer is a
 * new picture (a camera encodes one per request): up to 5 fps.
 */
export const SINGLE_FEED_INTERVAL_MS = 200;
/** Up to 2 fps per grid cell, so four cameras don't overload the NVR. */
export const GRID_FEED_INTERVAL_MS = 500;
/**
 * In the single view, on a device that repeats its picture (an NVR's cached
 * still), the time between requests after a repeat, until the new picture
 * arrives. A request takes about 0.2 s on the DS-7604NI, so this sends the
 * next one as soon as the last is answered: about 3 requests a second for
 * its one new picture a second, instead of 5.
 */
export const SINGLE_FEED_REPEAT_STEP_MS = 150;
/**
 * The same for a grid cell: its interval, so a cell never asks more often
 * than every 500 ms. A shorter step would show each picture ~0.1 s sooner,
 * which nobody sees at one picture a second, for ~20 % more requests from
 * four cells to one NVR; this way a cell asks 1.7 times a second instead of 2.
 */
export const GRID_FEED_REPEAT_STEP_MS = GRID_FEED_INTERVAL_MS;

/**
 * A feed's polling, which runs only while the page is visible: paused when
 * it is hidden, resumed when it is shown again.
 * @typedef {object} LiveLoop
 * @property {SnapshotPacer|null} pacer - the running poll's, for the fps readout; null while paused
 * @property {boolean} noSignal - the channel isn't delivering frames (it is left out of the readout)
 * @property {() => void} resume - start polling, unless it is already running
 * @property {() => void} pause - stop polling, aborting the request in flight
 */

/** Every live feed on the page, polling or paused. @type {Set<LiveLoop>} */
const liveLoops = new Set();

/** Whether the page is hidden: another tab in front, or the window minimized. */
const pageHidden = () => document.visibilityState === 'hidden';

/**
 * Poll a channel's snapshots for the connected device, one request at a
 * time (see pollSnapshots in lib/snapshots.js): the URL that serves them is
 * found once, a failing channel is asked less and less often, and stopping
 * aborts the request in flight. Each request has a time limit
 * (TIMEOUT_MS.picture for SD, .fullPicture for HD, in lib/isapi.js), so a
 * stalled response costs one frame instead of freezing the feed.
 *
 * A repeat of the last picture is neither shown nor counted, and on a device
 * that repeats itself requests are timed to its refresh (SnapshotPacer). The
 * polling pauses while the page is hidden (syncFeedsWithVisibility) and
 * resumes with the same channel URL and failure count, so an empty channel
 * isn't suddenly asked more often.
 *
 * @param {string} channelId
 * @param {object} handlers
 * @param {(blob: Blob) => void} handlers.onFrame - a new picture
 * @param {(err: unknown) => void} [handlers.onError] - each failed request
 * @param {(noSignal: boolean) => void} [handlers.onNoSignal] - the channel stopped (true) or
 *   resumed (false) delivering frames; true at the start for a camera listed offline
 * @param {SnapshotStream} [handlers.stream]
 * @param {number} [handlers.intervalMs] - time between requests while every answer is new
 * @param {number} [handlers.repeatStepMs] - time between requests after a repeat of the last picture
 * @returns {() => void} stops the loop
 */
export function createSnapshotLoop(channelId, {
  onFrame, onError, onNoSignal, stream = 'main',
  intervalMs = SINGLE_FEED_INTERVAL_MS, repeatStepMs = SINGLE_FEED_REPEAT_STEP_MS,
}) {
  const config = state.config;
  if (!config) return () => {};
  const source = Isapi.snapshotSource(config, channelInfo(channelId), stream);
  /** @type {(() => void)|null} */
  let stopPolling = null;
  /** @type {LiveLoop} */
  const loop = {
    pacer: null,
    noSignal: source.noSignal,
    resume() {
      if (stopPolling) return;
      // A fresh pacer: the time spent hidden isn't an interval between pictures
      const pacer = new SnapshotPacer({ intervalMs, repeatStepMs });
      loop.pacer = pacer;
      stopPolling = pollSnapshots(source, {
        pacer,
        onFrame: blob => {
          onFrame(blob);
          updateFeedStatus();
        },
        // Unchanged pictures still count for the readout: a feed stuck on one picture reads ever lower
        onRepeat: updateFeedStatus,
        onError,
        onNoSignal: lost => {
          loop.noSignal = lost;
          onNoSignal?.(lost);
          updateFeedStatus();
        },
      });
    },
    pause() {
      stopPolling?.();
      stopPolling = null;
      loop.pacer = null;
    },
  };
  liveLoops.add(loop);
  if (!pageHidden()) loop.resume();
  return () => {
    liveLoops.delete(loop);
    loop.pause();
  };
}

/**
 * Pause every live feed while the page is hidden, and resume them when it is
 * shown again. Nobody sees a hidden tab's feeds, and the NVR serves other
 * clients too (four grid feeds cost about 4 requests a second even with
 * Chrome's throttling of hidden tabs). Call on every visibilitychange.
 */
export function syncFeedsWithVisibility() {
  const hidden = pageHidden();
  for (const loop of liveLoops) {
    if (hidden) loop.pause();
    else loop.resume();
  }
  if (liveLoops.size > 0) updateFeedStatus();
}

/**
 * The live feeds' rate of new pictures: the average of the feeds that have
 * a signal and have measured one, so the grid shows a per-camera rate, not
 * the sum of four.
 * @returns {number|null} null when no feed has a rate yet
 */
function feedFramesPerSecond() {
  const now = performance.now();
  const rates = [...liveLoops]
    .filter(loop => !loop.noSignal)
    .map(loop => loop.pacer?.framesPerSecond(now) ?? null)
    .filter(rate => rate !== null);
  return rates.length > 0 ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null;
}

/**
 * A rate of new pictures for the readout: one decimal below 10 fps, where
 * the difference between 1 and 1.5 fps matters.
 * @param {number} fps
 * @returns {string}
 */
function formatFps(fps) {
  return fps < 10 ? fps.toFixed(1) : String(Math.round(fps));
}

/** Right side of the status bar: what's streaming, its quality, and new pictures per second. */
export function updateFeedStatus() {
  const grid = state.viewMode === 'grid' && state.activeSection === 'liveview';
  const quality = grid
    ? 'Grid · SD'
    : `Channel ${state.activeChannel} · ${state.streamType === 'main' ? 'HD' : 'SD'}`;
  const fps = feedFramesPerSecond();
  dom.statusRight.textContent = fps === null ? quality : `${quality} · ${formatFps(fps)} fps${grid ? ' per camera' : ''}`;
}

/**
 * Switch the single view between the main (HD) and sub (SD) stream, and
 * remember the choice.
 * @param {'main'|'sub'} type
 */
export function setStreamType(type) {
  state.streamType = type;
  byId('streamBtnSd').classList.toggle('active', type === 'sub');
  byId('streamBtnHd').classList.toggle('active', type === 'main');
  chrome.storage.local.set({ streamType: type });
  if (state.stopSnapshotFeed && state.activeChannel) startSnapshotFeed(state.activeChannel);
  updateFeedStatus();
}

/**
 * Show a JPEG blob in an <img>, releasing the previous frame's object URL.
 * Object URLs avoid re-encoding every frame as a base64 data URL.
 * @param {HTMLImageElement} img
 * @param {Blob} blob
 */
export function showFrame(img, blob) {
  const previous = img.dataset.objectUrl;
  const url = URL.createObjectURL(blob);
  img.dataset.objectUrl = url;
  img.src = url;
  if (previous) URL.revokeObjectURL(previous);
}

/**
 * Clear an <img> that was showing frames from showFrame().
 * @param {HTMLImageElement} img
 */
export function clearFrame(img) {
  if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
  delete img.dataset.objectUrl;
  img.removeAttribute('src');
}

/**
 * Show a live feed of one channel in the single view (and under the config canvas).
 * @param {string} channelId
 */
export function startSnapshotFeed(channelId) {
  stopSnapshotFeed();

  dom.noFeed.style.display = 'none';
  dom.canvasWrapper.style.display = 'block';

  let frameCount = 0;
  let noSignal = false;
  dom.videoFeed.onload = () => {
    resizeCanvas();
    redraw();
    frameCount++;
  };

  setStatus('Live view');
  state.stopSnapshotFeed = createSnapshotLoop(channelId, {
    stream: state.streamType,
    onFrame: blob => showFrame(dom.videoFeed, blob),
    onError: err => {
      if (frameCount === 0 || noSignal) setStatus('Failed to get video feed: ' + errorMessage(err));
    },
    onNoSignal: lost => {
      noSignal = lost;
      // The overlay says so, over this feed's last frame, dimmed as stale. A
      // frame from before (another channel, a playback still) isn't this
      // feed's, so it goes.
      if (lost && frameCount === 0) clearFrame(dom.videoFeed);
      dom.canvasContainer.classList.toggle('no-signal', lost);
      if (!lost) setStatus('Live view');
    },
  });
  updateFeedStatus();
}


// ─── 4-Camera Grid View ──────────────────────────────────────────────────────

/**
 * Start (or clear, when `channelId` is null) the feed in one grid cell.
 * @param {number} cellIdx - 0–3
 * @param {string|null} channelId
 */
export function startGridCellFeed(cellIdx, channelId) {
  state.gridFeedStops[cellIdx]?.();
  state.gridFeedStops[cellIdx] = null;

  const cell = queryAll(document, '.grid-cell')[cellIdx];
  if (!cell) return;

  const img = query(cell, '.grid-feed', HTMLImageElement);
  const noFeed = query(cell, '.grid-no-feed');

  img.classList.remove('loaded');
  cell.classList.remove('no-signal');
  noFeed.removeAttribute('title');
  clearFrame(img);

  if (!channelId) {
    cell.classList.remove('is-loading');
    noFeed.textContent = 'No camera';
    noFeed.style.display = '';
    return;
  }

  cell.classList.add('is-loading');
  noFeed.style.display = 'none';

  img.onload = () => {
    cell.classList.remove('is-loading');
    img.classList.add('loaded');
  };
  // A single failed frame keeps the spinner (or the last frame); a channel
  // without signal says so, over its last frame if it had one
  state.gridFeedStops[cellIdx] = createSnapshotLoop(channelId, {
    stream: 'sub',
    intervalMs: GRID_FEED_INTERVAL_MS,
    repeatStepMs: GRID_FEED_REPEAT_STEP_MS,
    onFrame: blob => showFrame(img, blob),
    onError: err => {
      noFeed.title = errorMessage(err);
    },
    onNoSignal: lost => {
      cell.classList.toggle('no-signal', lost);
      if (lost) cell.classList.remove('is-loading');
      else noFeed.removeAttribute('title');
      noFeed.textContent = 'No signal';
      noFeed.style.display = lost ? '' : 'none';
    },
  });
}
