/**
 * Live snapshots: which URL serves a channel's frames, and how often to ask
 * for one when none arrives.
 *
 * A device serves a channel's current frame at one of a few URLs
 * (snapshotPaths). Which one works is found once per channel and stream and
 * then kept (SnapshotSource), so a frame costs one request, not a walk down
 * the list each time. A channel that stops answering with frames (a camera
 * unplugged, an empty channel, which answers 503 on the DS-7604NI) is asked
 * less and less often (snapshotRetryDelay) instead of several times a
 * second for as long as it is on screen, and counts as "no signal" so the
 * page can say so rather than spin or show a frozen frame as live.
 *
 * The fetching itself is passed in (lib/isapi.js binds it to a device), so
 * everything here runs without a device or a page.
 *
 * Depends on lib/digest-auth.js and lib/errors.js.
 */

import { AuthError } from './digest-auth.js';
import { IsapiError, NotAnImageError, isFallbackError } from './errors.js';

/** @typedef {import('./channels.js').Channel} Channel */
/** @typedef {import('./digest-auth.js').RequestOptions} RequestOptions */

/**
 * Which of a channel's streams to show: "main" (HD) or "sub" (SD), the
 * smaller and faster one.
 * @typedef {'main'|'sub'} SnapshotStream
 */

/**
 * One request for one frame at one URL. Rejects with the device's answer
 * (IsapiError), NotAnImageError, or the request's own errors.
 * @typedef {(path: string, options: RequestOptions) => Promise<Blob>} FetchSnapshot
 */

/** The wait after the first failed request in a row; it doubles with each further one. */
export const SNAPSHOT_RETRY_MIN_MS = 500;
/** The longest wait between requests to a channel that keeps failing, so a camera that comes back shows up within seconds. */
export const SNAPSHOT_RETRY_MAX_MS = 10000;
/**
 * Failed requests in a row after which a channel has no signal. One failure
 * alone can be a single slow frame; the second, at least half a second
 * later, makes it a channel that isn't delivering.
 */
export const NO_SIGNAL_AFTER_FAILURES = 2;
/**
 * Failed requests in a row after which the kept URL is found again (and
 * again after as many more), in case the channel now serves its frames
 * elsewhere, e.g. another camera without a sub-stream.
 */
export const RESOLVE_AGAIN_AFTER_FAILURES = 4;
/**
 * A channel the device lists as offline starts as if this many requests had
 * failed already: it has no signal from the start and is retried slowly
 * (8 s, then 10 s), but still asked, since the list may be out of date.
 */
export const OFFLINE_START_FAILURES = 4;

/**
 * The URLs that may serve a channel's current frame, best first.
 *
 * Stream IDs are channel × 100 + 1 for the main stream and + 2 for the sub
 * stream. The sub stream falls back to the main one, for cameras without a
 * sub-stream. An IP camera behind an NVR is also served through
 * StreamingProxy, which Hikvision's web UI uses for those channels (on the
 * DS-7604NI it serves the same frame as Streaming). The bare channel ID,
 * which some old firmware used, comes last: the DS-7604NI answers it with
 * 400 badXmlContent.
 * @param {Pick<Channel, 'id'|'kind'>} channel
 * @param {SnapshotStream} stream
 * @returns {string[]}
 * @example
 * snapshotPaths({id: '3', kind: 'digital'}, 'sub')
 * // → ['/ISAPI/Streaming/channels/302/picture', '/ISAPI/Streaming/channels/301/picture',
 * //    '/ISAPI/ContentMgmt/StreamingProxy/channels/302/picture', '/ISAPI/Streaming/channels/3/picture']
 */
export function snapshotPaths(channel, stream) {
  const { id } = channel;
  const streamId = `${id}${stream === 'sub' ? '02' : '01'}`;
  const streamIds = stream === 'sub' ? [streamId, `${id}01`] : [streamId];
  return [
    ...streamIds.map(s => `/ISAPI/Streaming/channels/${s}/picture`),
    ...(channel.kind === 'digital' ? [`/ISAPI/ContentMgmt/StreamingProxy/channels/${streamId}/picture`] : []),
    `/ISAPI/Streaming/channels/${id}/picture`,
  ];
}

/**
 * How long to wait before asking a channel again after this many failed
 * requests in a row: nothing extra while frames arrive, then 0.5, 1, 2, 4,
 * 8 s and at most SNAPSHOT_RETRY_MAX_MS.
 * @param {number} failures - failed requests in a row
 * @returns {number} milliseconds; 0 when the last request succeeded
 */
export function snapshotRetryDelay(failures) {
  if (failures <= 0) return 0;
  return Math.min(SNAPSHOT_RETRY_MIN_MS * 2 ** (failures - 1), SNAPSHOT_RETRY_MAX_MS);
}

/**
 * Whether bytes are a JPEG: they start with its Start Of Image marker (FF D8).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isJpeg(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/**
 * Whether a URL simply doesn't serve frames, so the next one may: the
 * device answered "not here" (isFallbackError), or with something other
 * than an image.
 * @param {unknown} err
 * @returns {boolean}
 */
function servesNoFrames(err) {
  return isFallbackError(err) || err instanceof NotAnImageError;
}

/**
 * One channel's frames: finds the URL that serves them on the first request,
 * keeps it, and counts failed requests in a row, which decide how long to
 * wait before the next request (retryDelayMs) and whether the channel has
 * no signal.
 *
 * Every later request goes to the kept URL only, so a failing channel costs
 * one request each time. The URL is found again only after
 * RESOLVE_AGAIN_AFTER_FAILURES failures in a row. A URL where the device
 * answered, just not with a frame (503 for a camera that isn't there), is
 * kept like one that works: the next URLs would only answer the same way.
 *
 * @example
 * const source = new SnapshotSource(snapshotPaths(channel, 'sub'), (path, options) => Isapi.fetchSnapshot(config, path, options));
 * const blob = await source.next({ signal });
 */
export class SnapshotSource {
  /**
   * @param {string[]} paths - the URLs to try, best first (snapshotPaths)
   * @param {FetchSnapshot} fetchSnapshot - one request to one of them
   * @param {{offline?: boolean}} [init] - offline: the device lists the camera as
   *   disconnected, so start with no signal and slow retries (OFFLINE_START_FAILURES)
   */
  constructor(paths, fetchSnapshot, { offline = false } = {}) {
    if (paths.length === 0) throw new RangeError('A snapshot source needs at least one URL');
    /** @type {readonly string[]} */
    this.paths = paths;
    /** @type {FetchSnapshot} */
    this.fetchSnapshot = fetchSnapshot;
    /**
     * The URL every request goes to, once found; null until then, and again
     * each time it is to be found again.
     * @type {string|null}
     */
    this.path = null;
    /** Failed requests in a row. */
    this.failures = offline ? OFFLINE_START_FAILURES : 0;
  }

  /** Whether the channel has stopped delivering frames (or is listed offline and hasn't delivered one yet). */
  get noSignal() {
    return this.failures >= NO_SIGNAL_AFTER_FAILURES;
  }

  /** How long to wait before the next request, from the end of the last one; 0 after a frame. */
  get retryDelayMs() {
    return snapshotRetryDelay(this.failures);
  }

  /**
   * Fetch the channel's current frame.
   * @param {RequestOptions} [options] - e.g. the feed's abort signal
   * @returns {Promise<Blob>} image/jpeg
   * @throws {unknown} what the request failed with. When no URL has a frame,
   *   that is the first URL's answer: it is the stream that was asked for.
   */
  async next(options = {}) {
    try {
      const blob = this.path === null ? await this.resolve(options) : await this.fetchSnapshot(this.path, options);
      this.failures = 0;
      return blob;
    } catch (err) {
      // A request the caller cancelled says nothing about the channel
      if (!options.signal?.aborted) this.countFailure();
      throw err;
    }
  }

  /** @private */
  countFailure() {
    this.failures++;
    if (this.failures % RESOLVE_AGAIN_AFTER_FAILURES === 0) this.path = null;
  }

  /**
   * Try the URLs in order and keep the first that serves a frame, or where
   * the device answers in a way the next URL would too.
   * @private
   * @param {RequestOptions} options
   * @returns {Promise<Blob>}
   */
  async resolve(options) {
    /** @type {unknown} */
    let firstError;
    for (const path of this.paths) {
      try {
        const blob = await this.fetchSnapshot(path, options);
        this.path = path;
        return blob;
      } catch (err) {
        if (!servesNoFrames(err)) {
          // The device answered here (503: no camera, lowPrivilege) and would
          // elsewhere too. No answer at all (a timeout) shows nothing about
          // the URL, so it is tried again next time.
          if (err instanceof IsapiError) this.path = path;
          throw err;
        }
        firstError ??= err;
      }
    }
    // No URL serves frames: keep asking for the stream that was asked for, one request at a time
    this.path = this.paths[0];
    throw firstError;
  }
}

/**
 * What a snapshot feed reports to the page.
 * @typedef {object} SnapshotFeedHandlers
 * @property {number} intervalMs - minimum time between the starts of two requests while frames arrive
 * @property {(blob: Blob) => void} onFrame - a new frame
 * @property {(err: unknown) => void} [onError] - a request failed (after onNoSignal, if it changed)
 * @property {(noSignal: boolean) => void} [onNoSignal] - the channel started or stopped having no
 *   signal (SnapshotSource.noSignal). Called at the start too when it starts without signal.
 */

/**
 * Poll a channel's frames, one request at a time: the next request is
 * scheduled only after the previous one finishes, so a slow device never
 * builds up a queue of overlapping requests. While requests fail, the wait
 * grows (SnapshotSource.retryDelayMs) and a frame resets it.
 *
 * Stopping aborts the request in flight, so a channel or stream switch
 * doesn't leave the device serving a frame nobody will show. A rejected
 * login stops the polling: every further request would be refused too.
 * @param {SnapshotSource} source
 * @param {SnapshotFeedHandlers} handlers
 * @returns {() => void} stops polling
 */
export function pollSnapshots(source, { intervalMs, onFrame, onError, onNoSignal }) {
  let stopped = false;
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  let noSignal = source.noSignal;

  const reportSignal = () => {
    if (source.noSignal === noSignal) return;
    noSignal = source.noSignal;
    onNoSignal?.(noSignal);
  };

  const tick = async () => {
    const started = performance.now();
    try {
      const blob = await source.next({ signal: controller.signal });
      if (stopped) return;
      reportSignal();
      onFrame(blob);
    } catch (err) {
      if (stopped) return;
      reportSignal();
      onError?.(err);
      if (err instanceof AuthError) return;
    }
    // A handler may have stopped the feed
    if (stopped) return;
    const sinceStart = performance.now() - started;
    timer = setTimeout(tick, Math.max(intervalMs - sinceStart, source.retryDelayMs, 0));
  };

  if (noSignal) onNoSignal?.(true);
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  };
}
