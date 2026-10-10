/**
 * Live snapshot feeds for the single view and the 4-camera grid.
 */

import { AuthError } from '../lib/digest-auth.js';
import { Isapi } from '../lib/isapi.js';
import { redraw, resizeCanvas } from './canvas.js';
import { dom, state } from './state.js';
import { setStatus } from './ui.js';

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

/** Minimum time between snapshot requests for one feed. */
export const SNAPSHOT_INTERVAL_MS = 1000;

/**
 * Poll snapshots for a channel, one request at a time: the next request is
 * scheduled only after the previous one finishes, so a slow device never
 * builds up a queue of overlapping requests.
 *
 * @param {string} channelId
 * @param {object} handlers
 * @param {(blob: Blob) => void} handlers.onFrame
 * @param {(err: Error) => void} [handlers.onError]
 * @returns {() => void} stops the loop
 */
export function createSnapshotLoop(channelId, { onFrame, onError }) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    const started = performance.now();
    try {
      const blob = await Isapi.getSnapshot(state.config, channelId);
      if (!stopped) onFrame(blob);
    } catch (err) {
      if (stopped) return;
      onError?.(err);
      // handleAuthFailure has already stopped everything; don't reschedule
      if (err instanceof AuthError) return;
    }
    if (!stopped) {
      timer = setTimeout(tick, Math.max(0, SNAPSHOT_INTERVAL_MS - (performance.now() - started)));
    }
  };

  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Show a JPEG blob in an <img>, releasing the previous frame's object URL.
 * Object URLs avoid re-encoding every frame as a base64 data URL.
 */
export function showFrame(img, blob) {
  const previous = img.dataset.objectUrl;
  const url = URL.createObjectURL(blob);
  img.dataset.objectUrl = url;
  img.src = url;
  if (previous) URL.revokeObjectURL(previous);
}

/** Clear an <img> that was showing frames from showFrame(). */
export function clearFrame(img) {
  if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
  delete img.dataset.objectUrl;
  img.removeAttribute('src');
}

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

  state.stopSnapshotFeed = createSnapshotLoop(channelId, {
    onFrame: blob => showFrame(dom.videoFeed, blob),
    onError: err => {
      if (frameCount === 0) setStatus('Failed to get video feed: ' + err.message);
    },
  });
  setStatus('Streaming snapshots', `Channel ${channelId}`);
}


// ─── 4-Camera Grid View ──────────────────────────────────────────────────────

export function startGridCellFeed(cellIdx, channelId) {
  state.gridFeedStops[cellIdx]?.();
  state.gridFeedStops[cellIdx] = null;

  const cell = document.querySelectorAll('.grid-cell')[cellIdx];
  if (!cell) return;

  const img = cell.querySelector('.grid-feed');
  const noFeed = cell.querySelector('.grid-no-feed');

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
    onFrame: blob => showFrame(img, blob),
  });
}
