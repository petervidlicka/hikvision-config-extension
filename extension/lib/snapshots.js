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
 * page can say so rather than spin or show a frozen frame as live. While
 * frames arrive, a SnapshotPacer (lib/snapshot-pacer.js) drops repeats of the
 * last one and times the requests to how often the device really has a new
 * one (pollSnapshots).
 *
 * An NVR's main-stream ("HD") still is often no bigger than its sub-stream
 * one; asked for a size, it serves a full-size still instead. Whether a
 * channel's does is found out once (fullSizeUpgrade).
 *
 * The fetching itself is passed in (lib/isapi.js binds it to a device), so
 * everything here runs without a device or a page.
 *
 * Depends on lib/digest-auth.js, lib/errors.js, lib/picture-size.js and
 * lib/snapshot-pacer.js.
 */

import { AuthError } from './digest-auth.js';
import { IsapiError, NetworkError, NotAnImageError, isFallbackError } from './errors.js';
import { jpegSize, sameSize } from './picture-size.js';

/** @typedef {import('./snapshot-pacer.js').SnapshotPacer} SnapshotPacer */

/** @typedef {import('./channels.js').Channel} Channel */
/** @typedef {import('./config-xml.js').Size} Size */
/** @typedef {import('./digest-auth.js').RequestOptions} RequestOptions */

/**
 * Which of a channel's streams to show: "main" (HD) or "sub" (SD), the
 * smaller and faster one.
 * @typedef {'main'|'sub'} SnapshotStream
 */

/**
 * One frame as the device sent it: the bytes of a JPEG. Kept as bytes rather
 * than a Blob so a feed can tell a repeat of the last frame without reading
 * it back.
 * @typedef {Uint8Array<ArrayBuffer>} JpegBytes
 */

/**
 * One request for one frame at one URL. Rejects with the device's answer
 * (IsapiError), NotAnImageError, or the request's own errors.
 * @typedef {(path: string, options: RequestOptions) => Promise<JpegBytes>} FetchSnapshot
 */

/**
 * A frame and the URL it came from.
 * @typedef {{path: string, jpeg: JpegBytes}} FoundFrame
 */

/**
 * A better URL than the one SnapshotSource found, looked for once after it
 * found one (see fullSizeUpgrade): given that URL and its frame, it may make
 * requests of its own, and returns a frame from the better URL to keep
 * instead, or null to keep the one found.
 * @typedef {(found: FoundFrame, options: RequestOptions) => Promise<FoundFrame|null>} SnapshotUpgrade
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
 * The size to ask for a full-size still when the channel's main stream size
 * isn't known. The DS-7604NI serves 1920×1088 for any size other than its
 * 704×576 default.
 */
export const DEFAULT_FULL_SIZE = Object.freeze({ width: 1920, height: 1080 });

/**
 * The main-stream snapshot URL that asks for a size: an NVR whose plain
 * still is 704×576 then sends a full-size one (the DS-7604NI sends 1920×1088
 * whatever size is asked, 2688×1520 included, about 280–345 KB instead of
 * 66 KB, refreshed about once a second too). Still a /picture URL, so it is
 * read as bytes and gets the full-size time limit (see lib/isapi.js).
 * @param {string} channelId
 * @param {Size} size - what to ask for: the channel's main stream size
 * @returns {string}
 * @example
 * fullSizePicturePath('1', {width: 2688, height: 1520})
 * // → '/ISAPI/Streaming/channels/101/picture?videoResolutionWidth=2688&videoResolutionHeight=1520'
 */
export function fullSizePicturePath(channelId, size) {
  return `/ISAPI/Streaming/channels/${channelId}01/picture` +
    `?videoResolutionWidth=${Math.round(size.width)}&videoResolutionHeight=${Math.round(size.height)}`;
}

/**
 * Look for a channel's full-size still once its plain main-stream URL serves
 * frames: an upgrade for the single view's SnapshotSource ("HD").
 *
 * The plain still is often not full size on an NVR: the DS-7604NI serves the
 * same 704×576 still on the main and the sub stream. Asked for a size
 * (fullSizePicturePath, with the main stream's own size so a device that
 * honours it isn't asked to scale down), it sends a full-size one. A camera's
 * own main-stream still is full size already, and firmware without the size
 * parameters may refuse them, so they are only tried where the plain still
 * is likely a copy of the small one: on an IP camera behind an NVR (kind
 * "digital"), or where the main and sub stream stills are the same size.
 *
 * The outcome is passed to `remember`: the full-size URL when it sent a
 * bigger still, or null when the plain URL is to be kept (a camera with
 * different main and sub stills, or without a sub stream; or the sized
 * request answered with an error, something other than an image, or a still
 * no bigger than the plain one). A request that got no answer decides
 * nothing, and the plain URL serves meanwhile.
 * @param {object} init
 * @param {Pick<Channel, 'id'|'kind'>} init.channel
 * @param {Size|undefined} init.streamSize - the main stream's size (Channel.mainStreamSize);
 *   DEFAULT_FULL_SIZE when unknown
 * @param {FetchSnapshot} init.fetchSnapshot
 * @param {(path: string|null) => void} init.remember - the full-size URL, or null for the plain one
 * @returns {SnapshotUpgrade}
 * @example
 * new SnapshotSource(snapshotPaths(channel, 'main'), fetchSnapshot, {
 *   upgrade: fullSizeUpgrade({ channel, streamSize: channel.mainStreamSize, fetchSnapshot, remember }),
 * });
 */
export function fullSizeUpgrade({ channel, streamSize, fetchSnapshot, remember }) {
  const [plainPath] = snapshotPaths(channel, 'main');
  const [subPath] = snapshotPaths(channel, 'sub');
  return async (found, options) => {
    const plain = jpegSize(found.jpeg);
    // Only the plain main-stream URL has a sized form
    if (found.path !== plainPath || plain === null) return null;

    if (channel.kind !== 'digital') {
      const sub = await askOnce(fetchSnapshot, subPath, options);
      if (sub === null) return null;
      if (sub === 'refused' || !sameSize(jpegSize(sub), plain)) {
        remember(null);
        return null;
      }
    }

    const path = fullSizePicturePath(channel.id, streamSize ?? DEFAULT_FULL_SIZE);
    const full = await askOnce(fetchSnapshot, path, options);
    if (full === null) return null;
    const size = full === 'refused' ? null : jpegSize(full);
    if (full === 'refused' || size === null || size.width * size.height <= plain.width * plain.height) {
      remember(null);
      return null;
    }
    remember(path);
    return { path, jpeg: full };
  };
}

/**
 * One request of fullSizeUpgrade's: the frame; 'refused' when the device
 * answered without one (an error status, or something other than an image);
 * null when nothing answered (a timeout or network failure), which decides
 * nothing.
 * @param {FetchSnapshot} fetchSnapshot
 * @param {string} path
 * @param {RequestOptions} options
 * @returns {Promise<JpegBytes|'refused'|null>}
 * @throws {unknown} an abort, a rejected login, or anything unexpected
 */
async function askOnce(fetchSnapshot, path, options) {
  try {
    return await fetchSnapshot(path, options);
  } catch (err) {
    if (options.signal?.aborted) throw err;
    if (err instanceof IsapiError || err instanceof NotAnImageError) return 'refused';
    if (err instanceof NetworkError) return null;
    throw err;
  }
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
 * An `upgrade` (e.g. fullSizeUpgrade) runs once, after the first URL that
 * serves frames is found, and may swap it for a better one.
 *
 * @example
 * const source = new SnapshotSource(snapshotPaths(channel, 'sub'), (path, options) => Isapi.fetchSnapshot(config, path, options));
 * const jpeg = await source.next({ signal });
 */
export class SnapshotSource {
  /**
   * @param {string[]} paths - the URLs to try, best first (snapshotPaths)
   * @param {FetchSnapshot} fetchSnapshot - one request to one of them
   * @param {{offline?: boolean, upgrade?: SnapshotUpgrade|null}} [init] - offline: the device
   *   lists the camera as disconnected, so start with no signal and slow retries
   *   (OFFLINE_START_FAILURES); upgrade: a better URL to look for once a URL serves frames
   */
  constructor(paths, fetchSnapshot, { offline = false, upgrade = null } = {}) {
    if (paths.length === 0) throw new RangeError('A snapshot source needs at least one URL');
    /** @type {readonly string[]} */
    this.paths = paths;
    /** @type {FetchSnapshot} */
    this.fetchSnapshot = fetchSnapshot;
    /**
     * Still to run: cleared once it has looked, and kept for the next
     * resolve when it was cut short (the feed paused, say).
     * @type {SnapshotUpgrade|null}
     */
    this.upgrade = upgrade;
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
   * @returns {Promise<JpegBytes>}
   * @throws {unknown} what the request failed with. When no URL has a frame,
   *   that is the first URL's answer: it is the stream that was asked for.
   */
  async next(options = {}) {
    try {
      const jpeg = this.path === null ? await this.resolve(options) : await this.fetchSnapshot(this.path, options);
      this.failures = 0;
      return jpeg;
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
   * Find the URL to keep (findPath), then let the upgrade, if any is still
   * to run, swap it for a better one. A better URL is tried first from then
   * on, also when the URL is to be found again. An upgrade cut short (the
   * feed paused or stopped) runs again with the next request.
   * @private
   * @param {RequestOptions} options
   * @returns {Promise<JpegBytes>}
   */
  async resolve(options) {
    const jpeg = await this.findPath(options);
    const upgrade = this.upgrade;
    if (!upgrade || this.path === null) return jpeg;
    let better;
    try {
      better = await upgrade({ path: this.path, jpeg }, options);
    } catch (err) {
      // Find the URL again next time, then look again
      this.path = null;
      throw err;
    }
    this.upgrade = null;
    if (!better) return jpeg;
    this.paths = [better.path, ...this.paths.filter(path => path !== better.path)];
    this.path = better.path;
    return better.jpeg;
  }

  /**
   * Try the URLs in order and keep the first that serves a frame, or where
   * the device answers in a way the next URL would too.
   * @private
   * @param {RequestOptions} options
   * @returns {Promise<JpegBytes>}
   */
  async findPath(options) {
    /** @type {unknown} */
    let firstError;
    for (const path of this.paths) {
      try {
        const jpeg = await this.fetchSnapshot(path, options);
        this.path = path;
        return jpeg;
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
 * How a snapshot feed is paced, and what it reports to the page.
 * @typedef {object} SnapshotFeedHandlers
 * @property {SnapshotPacer} pacer - which answers are new frames, and when to send the next
 *   request while they arrive; one per feed (it remembers the last frame)
 * @property {(blob: Blob) => void} onFrame - a new frame, as an image/jpeg Blob
 * @property {() => void} [onRepeat] - the device answered with the same frame as last time,
 *   which isn't passed on
 * @property {(err: unknown) => void} [onError] - a request failed (after onNoSignal, if it changed)
 * @property {(noSignal: boolean) => void} [onNoSignal] - the channel started or stopped having no
 *   signal (SnapshotSource.noSignal). Called at the start too when it starts without signal.
 */

/**
 * Poll a channel's frames, one request at a time: the next request is
 * scheduled only after the previous one finishes, so a slow device never
 * builds up a queue of overlapping requests. While frames arrive, the pacer
 * drops repeats and says when to ask next (SnapshotPacer.delayMs, counted
 * from the start of the request before). While requests fail, the wait
 * grows (SnapshotSource.retryDelayMs) and a frame resets it.
 *
 * Stopping aborts the request in flight, so a channel or stream switch
 * doesn't leave the device serving a frame nobody will show. A rejected
 * login stops the polling: every further request would be refused too.
 * @param {SnapshotSource} source
 * @param {SnapshotFeedHandlers} handlers
 * @returns {() => void} stops polling
 */
export function pollSnapshots(source, { pacer, onFrame, onRepeat, onError, onNoSignal }) {
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
      const jpeg = await source.next({ signal: controller.signal });
      if (stopped) return;
      reportSignal();
      // A repeat isn't decoded and drawn again, nor counted as a frame
      if (pacer.record(jpeg, performance.now())) onFrame(new Blob([jpeg], { type: 'image/jpeg' }));
      else onRepeat?.();
    } catch (err) {
      if (stopped) return;
      reportSignal();
      onError?.(err);
      if (err instanceof AuthError) return;
    }
    // A handler may have stopped the feed
    if (stopped) return;
    const sinceStart = performance.now() - started;
    timer = setTimeout(tick, Math.max(pacer.delayMs - sinceStart, source.retryDelayMs, 0));
  };

  if (noSignal) onNoSignal?.(true);
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  };
}
