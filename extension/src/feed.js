/**
 * Live snapshot feeds for the single view and the 4-camera grid.
 */

import { AuthError } from '../lib/digest-auth.js';
import { Isapi } from '../lib/isapi.js';
import { redraw, resizeCanvas } from './canvas.js';
import { byId, dom, query, queryAll, state } from './state.js';
import { errorMessage, setStatus } from './ui.js';

/** Stop all 4-cam grid snapshot loops. */
export function stopAllGridFeeds() {
  state.gridFeedStops.forEach(stop => stop?.());
  state.gridFeedStops = [null, null, null, null];
}

/** Stop the single-view snapshot loop. */
export function stopSnapshotFeed() {
  state.stopSnapshotFeed?.();
  state.stopSnapshotFeed = null;
}

// ─── Video Feed ─────────────────────────────────────────────────────────────

/** Minimum time between snapshot requests: up to 5 fps in the single view. */
export const SINGLE_FEED_INTERVAL_MS = 200;
/** Up to 2 fps per grid cell, so four cameras don't overload the NVR. */
export const GRID_FEED_INTERVAL_MS = 500;

/**
 * Poll snapshots for a channel, one request at a time: the next request is
 * scheduled only after the previous one finishes, so a slow device never
 * builds up a queue of overlapping requests.
 *
 * Each request has a time limit (TIMEOUT_MS.picture for SD, .fullPicture for
 * HD, in lib/isapi.js), so a stalled response costs one frame instead of
 * freezing the feed. Stopping
 * aborts the request in flight, so a channel or stream switch doesn't leave
 * the device serving a frame nobody will show.
 *
 * @param {string} channelId
 * @param {object} handlers
 * @param {(blob: Blob) => void} handlers.onFrame
 * @param {(err: unknown) => void} [handlers.onError]
 * @param {'main'|'sub'} [handlers.stream]
 * @param {number} [handlers.intervalMs] - minimum time between requests
 * @returns {() => void} stops the loop
 */
export function createSnapshotLoop(channelId, { onFrame, onError, stream = 'main', intervalMs = SINGLE_FEED_INTERVAL_MS }) {
  const config = state.config;
  if (!config) return () => {};
  let stopped = false;
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;

  const tick = async () => {
    const started = performance.now();
    try {
      const blob = await Isapi.getSnapshot(config, channelId, stream, { signal: controller.signal });
      if (!stopped) {
        onFrame(blob);
        recordFrame();
      }
    } catch (err) {
      if (stopped) return;
      onError?.(err);
      // handleAuthFailure has already stopped everything; don't reschedule
      if (err instanceof AuthError) return;
    }
    if (!stopped) {
      timer = setTimeout(tick, Math.max(0, intervalMs - (performance.now() - started)));
    }
  };

  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  };
}

/** Count a displayed frame and refresh the FPS readout. */
function recordFrame() {
  const now = performance.now();
  state.frameTimes.push(now);
  while (state.frameTimes.length && now - state.frameTimes[0] > 1000) state.frameTimes.shift();
  updateFeedStatus();
}

/** Right side of the status bar: what's streaming, frames per second, quality. */
export function updateFeedStatus() {
  const fps = state.frameTimes.length;
  const quality = state.viewMode === 'grid' && state.activeSection === 'liveview'
    ? 'Grid · SD'
    : `Channel ${state.activeChannel} · ${state.streamType === 'main' ? 'HD' : 'SD'}`;
  dom.statusRight.textContent = fps > 0 ? `${quality} · ${fps} fps` : quality;
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
  dom.videoFeed.onload = () => {
    resizeCanvas();
    redraw();
    frameCount++;
  };

  state.frameTimes = [];
  state.stopSnapshotFeed = createSnapshotLoop(channelId, {
    stream: state.streamType,
    onFrame: blob => showFrame(dom.videoFeed, blob),
    onError: err => {
      if (frameCount === 0) setStatus('Failed to get video feed: ' + errorMessage(err));
    },
  });
  setStatus('Live view');
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
  // On errors, keep showing the loading state until the next successful frame
  state.gridFeedStops[cellIdx] = createSnapshotLoop(channelId, {
    stream: 'sub',
    intervalMs: GRID_FEED_INTERVAL_MS,
    onFrame: blob => showFrame(img, blob),
  });
}
