/**
 * Hikvision ISAPI client, called directly from the extension page.
 *
 * Extension pages with host permission aren't subject to CORS, so there's no
 * need to proxy through the service worker: responses stay binary (snapshots
 * become Blobs, not base64) and the password never travels over messaging.
 *
 * Every request has a time limit (TIMEOUT_MS), and endpoint fallbacks follow
 * one policy (isFallbackError in lib/errors.js): move on only when the device
 * answered "not here", stop on anything that would fail the same way again.
 *
 * Depends on lib/digest-auth.js, lib/errors.js and lib/xml.js.
 */

import { AuthError, digestFetch, forgetRejectedCredentials } from './digest-auth.js';
import {
  IsapiError, STATUS_OK, STATUS_REBOOT_REQUIRED, TimeoutError, isFallbackError, parseResponseStatus,
} from './errors.js';
import {
  SEARCH_PAGE_SIZE, buildCalendarXml, buildSearchXml, parseCalendar, parsePictureResult, parseSearchResult, toDeviceTime,
} from './playback.js';
import { childElements, childText, parseXml, serializeXml } from './xml.js';

/** @typedef {import('./digest-auth.js').DeviceConfig} DeviceConfig */
/** @typedef {import('./digest-auth.js').DigestResponse} DigestResponse */
/** @typedef {import('./digest-auth.js').RequestOptions} RequestOptions */
/** @typedef {import('./playback.js').Recording} Recording */
/** @typedef {import('./playback.js').StoredPicture} StoredPicture */

/** Stop paging a recording search after this many results. */
const MAX_SEARCH_RESULTS = 2000;

/**
 * How long each kind of request may take before it fails with TimeoutError.
 * Generous next to what a healthy device needs (a snapshot takes 0.1–0.6 s
 * on the DS-7604NI), but short enough that a wrong IP address or a stalled
 * request shows up as an error instead of a hang. Hikvision's own clients
 * bound their requests too (web UI 30 s, iVMS 3–30 s to connect).
 */
export const TIMEOUT_MS = Object.freeze({
  /** Connect: the whole deviceInfo request, including the Digest challenge round trip */
  connect: 8000,
  /** One JPEG: a frame that times out just lets a live feed move on to the next */
  picture: 5000,
  /** Other reads */
  read: 10000,
  /** POST: recording and picture searches, where the device searches its disks */
  search: 20000,
  /** PUT and DELETE: the device may take a while to apply a change */
  write: 20000,
});

/**
 * Time limit for a request whose caller doesn't set one.
 * @param {string} method
 * @param {string} path
 * @returns {number} milliseconds
 */
export function defaultTimeoutMs(method, path) {
  switch (method.toUpperCase()) {
    case 'GET': return path.includes('/picture') ? TIMEOUT_MS.picture : TIMEOUT_MS.read;
    case 'POST': return TIMEOUT_MS.search;
    default: return TIMEOUT_MS.write;
  }
}

/**
 * What a successful write reports. `rebootRequired` means the device stored
 * the change but applies it only after a reboot (ResponseStatus statusCode
 * 7), which the user must be told, or the save looks like it did nothing.
 * @typedef {{rebootRequired: boolean}} WriteResult
 */

/**
 * Check the ResponseStatus a device returns for a write. HTTP 200 alone isn't
 * success: like Hikvision's web UI, only statusCode 1 (OK) and 7 (OK, reboot
 * required) count, and anything else fails. A body without a ResponseStatus
 * (some firmware sends none) counts as OK.
 * @param {string} method
 * @param {string} path
 * @param {DigestResponse} resp
 * @returns {WriteResult}
 * @throws {IsapiError} when the status reports a failure
 */
export function checkWriteResponse(method, path, resp) {
  const status = parseResponseStatus(typeof resp.data === 'string' ? resp.data : '');
  if (!status) return { rebootRequired: false };
  if (status.statusCode === STATUS_REBOOT_REQUIRED) return { rebootRequired: true };
  if (status.statusCode === STATUS_OK || (status.statusCode === null && status.subStatusCode === 'ok')) {
    return { rebootRequired: false };
  }
  throw new IsapiError({ method, path, httpStatus: resp.status, status });
}

/**
 * A camera channel. `kind` says which URL family configures it: "analog"
 * for cameras wired to the device, "digital" for IP cameras behind an NVR.
 * @typedef {{id: string, name: string, kind: 'analog'|'digital'}} Channel
 */

/**
 * Ways to read the channel list, in the order firmware tends to support them.
 * @type {{path: string, tag: string, kind: Channel['kind']}[]}
 */
const CHANNEL_ENDPOINTS = [
  { path: '/ISAPI/System/Video/inputs/channels', tag: 'VideoInputChannel', kind: 'analog' },
  { path: '/ISAPI/ContentMgmt/InputProxy/channels', tag: 'InputProxyChannel', kind: 'digital' },
  { path: '/ISAPI/Streaming/channels', tag: 'StreamingChannel', kind: 'analog' },
];

export const Isapi = {
  /**
   * Called once per AuthError. The UI uses this to stop polling and return
   * to the login form.
   * @type {((err: AuthError) => void) | null}
   */
  onAuthFailure: null,

  /**
   * digestFetch, plus the auth-failure hook and a time limit by request kind
   * (defaultTimeoutMs) unless the caller sets one.
   * @param {DeviceConfig} config
   * @param {string} method
   * @param {string} path
   * @param {string|null} [body]
   * @param {RequestOptions} [options]
   * @returns {Promise<DigestResponse>}
   */
  async request(config, method, path, body = null, options = {}) {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs(method, path);
    try {
      return await digestFetch(config, method, path, body, { ...options, timeoutMs });
    } catch (err) {
      if (err instanceof AuthError) this.onAuthFailure?.(err);
      throw err;
    }
  },

  /**
   * GET an ISAPI resource as an XML document.
   * @param {DeviceConfig} config
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<XMLDocument>}
   */
  async getXml(config, path, options = {}) {
    const resp = await this.request(config, 'GET', path, null, options);
    return parseXml(String(resp.data));
  },

  /**
   * PUT an edited XML document back to the device.
   * @param {DeviceConfig} config
   * @param {string} path
   * @param {XMLDocument} doc
   * @param {RequestOptions} [options]
   * @returns {Promise<WriteResult>} whether the change needs a reboot to take effect
   * @throws {IsapiError} also when the device answers 200 with a failure status
   */
  async putXml(config, path, doc, options = {}) {
    const resp = await this.request(config, 'PUT', path, serializeXml(doc), options);
    return checkWriteResponse('PUT', path, resp);
  },

  /**
   * DELETE a resource, e.g. every stored privacy mask region before writing
   * the new list (the device merges a PUT into what it has, by region id).
   * @param {DeviceConfig} config
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<WriteResult>}
   * @throws {IsapiError} also when the device answers 200 with a failure status
   */
  async deleteResource(config, path, options = {}) {
    const resp = await this.request(config, 'DELETE', path, null, options);
    return checkWriteResponse('DELETE', path, resp);
  },

  /**
   * Verify credentials and read the device's identity. An explicit user
   * action, so it may retry credentials the device rejected earlier.
   * @param {DeviceConfig} config
   * @returns {Promise<{deviceName: string|null, model: string|null, firmwareVersion: string|null}>}
   */
  async getDeviceInfo(config) {
    forgetRejectedCredentials(config);
    const root = (await this.getXml(config, '/ISAPI/System/deviceInfo', { timeoutMs: TIMEOUT_MS.connect })).documentElement;
    return {
      deviceName: childText(root, 'deviceName'),
      model: childText(root, 'model'),
      firmwareVersion: childText(root, 'firmwareVersion'),
    };
  },

  /**
   * List camera channels. Firmware versions differ in which endpoint is
   * accessible, so try several, then fall back to probing snapshots.
   *
   * `kind` says which URL family configures the channel: "analog" for
   * cameras wired to the device, "digital" for IP cameras behind an NVR
   * (see videoInputBase).
   * @param {DeviceConfig} config
   * @returns {Promise<Channel[]>}
   */
  async getChannels(config) {
    for (const ep of CHANNEL_ENDPOINTS) {
      try {
        const root = (await this.getXml(config, ep.path)).documentElement;
        let channels = childElements(root, ep.tag).map(el => ({
          id: childText(el, 'id') ?? '',
          name: childText(el, 'name') || childText(el, 'channelName') || '',
          kind: ep.kind,
        }));

        if (ep.tag === 'StreamingChannel') {
          // IDs 101/102 are camera 1 main/sub stream, 201/202 camera 2, ...
          const seen = new Set();
          channels = channels
            .map(ch => ({ ...ch, id: String(Math.floor(parseInt(ch.id, 10) / 100)) }))
            .filter(ch => !seen.has(ch.id) && seen.add(ch.id));
        }

        channels = channels.filter(ch => /^\d+$/.test(ch.id));
        if (channels.length > 0) return channels;
      } catch (err) {
        if (!isFallbackError(err)) throw err;
      }
    }

    // Last resort: probe snapshots on the first 4 channels. Any error answer
    // means no camera there (an empty channel answers 503 on the DS-7604NI);
    // no answer at all, or a rejected login, ends the probing.
    /** @type {Channel[]} */
    const probed = [];
    for (let id = 1; id <= 4; id++) {
      try {
        await this.request(config, 'GET', `/ISAPI/Streaming/channels/${id}01/picture`);
        probed.push({ id: String(id), name: '', kind: 'analog' });
      } catch (err) {
        if (!(err instanceof IsapiError)) throw err;
      }
    }
    if (probed.length > 0) return probed;

    throw new Error('Could not discover channels. Check that cameras are connected to the NVR.');
  },

  /**
   * Fetch one JPEG frame. Stream IDs are channel × 100 + 1 for the main
   * (HD) stream and + 2 for the sub (SD) stream, which is smaller and faster.
   * Falls back to the main stream when a camera has no sub-stream, and to
   * the bare channel ID for firmware that uses that. A busy device, an
   * unavailable camera (503) or a timeout ends the attempt for this frame
   * rather than trying every URL each time.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {'main'|'sub'} [stream]
   * @param {RequestOptions} [options] - e.g. the live feed's abort signal
   * @returns {Promise<Blob>}
   */
  async getSnapshot(config, channelId, stream = 'main', options = {}) {
    const ids = stream === 'sub' ? [`${channelId}02`, `${channelId}01`] : [`${channelId}01`];
    ids.push(channelId);
    let lastError;
    for (const id of ids) {
      try {
        const resp = await this.request(config, 'GET', `/ISAPI/Streaming/channels/${id}/picture`, null, options);
        return new Blob([resp.data], { type: 'image/jpeg' });
      } catch (err) {
        if (!isFallbackError(err)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  },

  /**
   * Base path for a channel's video-input settings. IP cameras behind an NVR
   * are configured through InputProxy, as in Hikvision's own web UI; some
   * NVRs also answer on the analog path, but that isn't guaranteed.
   * @param {Pick<Channel, 'id'|'kind'>} channel
   * @returns {string}
   */
  videoInputBase(channel) {
    return channel.kind === 'digital'
      ? `/ISAPI/ContentMgmt/InputProxy/channels/${channel.id}/video`
      : `/ISAPI/System/Video/inputs/channels/${channel.id}`;
  },

  /** @param {Pick<Channel, 'id'|'kind'>} channel */
  motionDetectionPath(channel) {
    return `${this.videoInputBase(channel)}/motionDetection`;
  },

  /**
   * Motion detection capabilities (allowed region types, region and corner
   * limits, sensitivity steps, target types), or null if the device doesn't
   * have them.
   * @param {DeviceConfig} config
   * @param {Pick<Channel, 'id'|'kind'>} channel
   * @returns {Promise<XMLDocument|null>}
   */
  async getMotionCapabilities(config, channel) {
    try {
      return await this.getXml(config, `${this.motionDetectionPath(channel)}/capabilities`);
    } catch (err) {
      if (!isFallbackError(err)) throw err;
      return null;
    }
  },

  /**
   * Load the privacy mask config. Returns the path it came from so the save
   * goes back to the same resource.
   * @param {DeviceConfig} config
   * @param {Pick<Channel, 'id'|'kind'>} channel
   * @returns {Promise<{doc: XMLDocument, path: string}>}
   */
  async getPrivacyMask(config, channel) {
    const base = `${this.videoInputBase(channel)}/privacyMask`;
    try {
      return { doc: await this.getXml(config, base), path: base };
    } catch (err) {
      // Only when the device has no such resource: a busy device or a
      // timeout must surface, not silently load the regions-only document
      if (!isFallbackError(err)) throw err;
      const path = `${base}/regions`;
      return { doc: await this.getXml(config, path), path };
    }
  },

  /**
   * All recordings of a channel's main stream in a time range, following the
   * device's paging until it reports it's done.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {Date} start
   * @param {Date} end
   * @returns {Promise<Recording[]>} sorted by start time
   */
  async searchRecordings(config, channelId, start, end) {
    const searchId = crypto.randomUUID();
    /** @type {Recording[]} */
    const recordings = [];
    for (let position = 0; position < MAX_SEARCH_RESULTS; position += SEARCH_PAGE_SIZE) {
      const body = buildSearchXml({ searchId, trackId: `${channelId}01`, start, end, position });
      const resp = await this.request(config, 'POST', '/ISAPI/ContentMgmt/search', body);
      const page = parseSearchResult(parseXml(String(resp.data)));
      recordings.push(...page.recordings);
      if (page.status !== 'MORE' || page.recordings.length === 0) break;
    }
    return recordings.sort((a, b) => a.start.getTime() - b.start.getTime());
  },

  /**
   * Days of a month that have recordings on a channel.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {number} year
   * @param {number} month - 1–12
   * @returns {Promise<number[]>}
   */
  async getRecordingDays(config, channelId, year, month) {
    const resp = await this.request(config, 'POST',
      `/ISAPI/ContentMgmt/record/tracks/${channelId}01/dailyDistribution`, buildCalendarXml(year, month));
    return parseCalendar(parseXml(String(resp.data)));
  },

  /**
   * Pictures on a channel's picture track (track …03) in a time range.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {Date} start
   * @param {Date} end
   * @returns {Promise<StoredPicture[]>} sorted by time
   */
  async searchPictures(config, channelId, start, end) {
    const searchId = crypto.randomUUID();
    /** @type {StoredPicture[]} */
    const pictures = [];
    for (let position = 0; position < MAX_SEARCH_RESULTS; position += SEARCH_PAGE_SIZE) {
      const body = buildSearchXml({ searchId, trackId: `${channelId}03`, start, end, position });
      const resp = await this.request(config, 'POST', '/ISAPI/ContentMgmt/search', body);
      const page = parsePictureResult(parseXml(String(resp.data)));
      pictures.push(...page.pictures);
      if (page.status !== 'MORE' || page.pictures.length === 0) break;
    }
    return pictures.sort((a, b) => a.time.getTime() - b.time.getTime());
  },

  /**
   * Fetch a stored picture by the URI a picture search returned. Only URIs
   * on the connected device are followed.
   * @param {DeviceConfig} config
   * @param {string} uri
   * @returns {Promise<Blob>}
   */
  async getStoredPicture(config, uri) {
    const url = new URL(uri);
    if (url.hostname !== config.host || url.protocol !== 'http:') {
      throw new Error('Picture is not on the connected device');
    }
    const resp = await this.request(config, 'GET', url.pathname + url.search);
    return new Blob([/** @type {ArrayBuffer} */ (resp.data)], { type: 'image/jpeg' });
  },

  /**
   * Whether the device really serves stills from recordings. Some firmware
   * accepts the starttime parameter but ignores it and returns the live
   * image, so ask for a moment long before any recording: a device that
   * honours the time can't return an image for it.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @returns {Promise<boolean>}
   */
  async ignoresRecordedFrameTime(config, channelId) {
    try {
      return (await this.getRecordedFrame(config, channelId, new Date(2000, 0, 1))) !== null;
    } catch (err) {
      // A device that ignores the time answers as fast as a live snapshot
      if (err instanceof TimeoutError) return false;
      throw err;
    }
  },

  /**
   * A still image from recorded video at a moment. Not part of documented
   * ISAPI, so only some firmware supports it; returns null when the device
   * doesn't answer with a JPEG (any error answer counts as "no frame").
   * No answer at all, or a rejected login, still throws. Check
   * ignoresRecordedFrameTime() first.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {Date} time
   * @returns {Promise<Blob|null>}
   */
  async getRecordedFrame(config, channelId, time) {
    const at = encodeURIComponent(toDeviceTime(time));
    const paths = [
      `/ISAPI/ContentMgmt/StreamingProxy/channels/${channelId}01/picture?starttime=${at}`,
      `/ISAPI/Streaming/channels/${channelId}01/picture?starttime=${at}`,
    ];
    for (const path of paths) {
      try {
        const resp = await this.request(config, 'GET', path);
        const bytes = new Uint8Array(/** @type {ArrayBuffer} */ (resp.data));
        if (bytes[0] === 0xff && bytes[1] === 0xd8) return new Blob([bytes], { type: 'image/jpeg' });
      } catch (err) {
        if (!(err instanceof IsapiError)) throw err;
      }
    }
    return null;
  },

  /** @param {string} channelId */
  eventTriggerPath(channelId) {
    return `/ISAPI/Event/triggers/VMD-${channelId}`;
  },

  /**
   * Load the motion-detection (VMD) event trigger for a channel. If the
   * per-trigger endpoint isn't available, pick it out of the full trigger
   * list into a document of its own, so a save only ever sends this trigger.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @returns {Promise<XMLDocument>}
   */
  async getEventTrigger(config, channelId) {
    try {
      return await this.getXml(config, this.eventTriggerPath(channelId));
    } catch (err) {
      if (!isFallbackError(err)) throw err;
    }

    try {
      const list = (await this.getXml(config, '/ISAPI/Event/triggers')).documentElement;
      const trigger = childElements(list, 'EventTrigger').find(t =>
        childText(t, 'eventType') === 'VMD' &&
        (childText(t, 'videoInputChannelID') === String(channelId) ||
          childText(t, 'id') === `VMD-${channelId}`));
      if (trigger) {
        const doc = document.implementation.createDocument(trigger.namespaceURI, null, null);
        doc.appendChild(doc.importNode(trigger, true));
        return doc;
      }
    } catch (err) {
      if (!isFallbackError(err)) throw err;
    }

    throw new Error('Event triggers not supported on this device or firmware');
  },
};
