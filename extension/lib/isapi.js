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
 * Depends on lib/config-xml.js, lib/digest-auth.js, lib/errors.js and lib/xml.js.
 */

import { applyPrivacyMask, readAlarmOutputs, readLightAudioChannels, readMotionTriggerCap } from './config-xml.js';
import {
  AuthError, digestFetch, forgetDigestSessions, forgetRejectedCredentials, rejectCredentials,
} from './digest-auth.js';
import {
  IsapiError, STATUS_OK, STATUS_REBOOT_REQUIRED, TimeoutError, WriteRollbackError, isFallbackError, parseLoginStatus,
  parseResponseStatus,
} from './errors.js';
import {
  buildCalendarXml, buildSearchXml, parseCalendar, parsePictures, parseRecordings, parseSearchPage, searchMatchKey, toDeviceTime,
} from './playback.js';
import {
  childElement, childElements, childText, cloneXml, findDescendant, parseXml, parseXmlOrNull, serializeXml,
} from './xml.js';

/** @typedef {import('./config-xml.js').AlarmOutput} AlarmOutput */
/** @typedef {import('./config-xml.js').DeviceRect} DeviceRect */
/** @typedef {import('./config-xml.js').EventActionSupport} EventActionSupport */
/** @typedef {import('./config-xml.js').UnusedPrivacySlots} UnusedPrivacySlots */
/** @typedef {import('./digest-auth.js').DeviceConfig} DeviceConfig */
/** @typedef {import('./digest-auth.js').DigestResponse} DigestResponse */
/** @typedef {import('./digest-auth.js').RequestOptions} RequestOptions */
/** @typedef {import('./playback.js').Recording} Recording */
/** @typedef {import('./playback.js').StoredPicture} StoredPicture */

/**
 * Stop paging one search after this many requests. At up to 50 matches a
 * page that is 2000 matches, far more than one day holds; the bound only
 * guards against firmware that keeps answering "MORE".
 */
export const MAX_SEARCH_REQUESTS = 40;

/**
 * How long each kind of request may take before it fails with TimeoutError.
 * Generous next to what a healthy device needs (a snapshot takes 0.1–0.6 s
 * on the DS-7604NI), but short enough that a wrong IP address or a stalled
 * request shows up as an error instead of a hang. Hikvision's own clients
 * bound their requests too (web UI 30 s, iVMS 3–30 s to connect).
 */
export const TIMEOUT_MS = Object.freeze({
  /** Connect: each of its requests (userCheck, deviceInfo), including the Digest challenge round trip */
  connect: 8000,
  /** One sub-stream (SD) JPEG: a frame that times out just lets a live feed move on to the next */
  picture: 5000,
  /**
   * One full-size JPEG: a main-stream (HD) frame, a stored picture or a still
   * from a recording. The limit covers downloading it too, and an 8 MP frame
   * of about 1.5 MB takes about 6 s over a 2 Mbps remote link.
   */
  fullPicture: 10000,
  /** Other reads */
  read: 10000,
  /** POST: recording and picture searches, where the device searches its disks */
  search: 20000,
  /** PUT and DELETE: the device may take a while to apply a change */
  write: 20000,
});

/** The explicit login check of Hikvision's web UI and SDK (see Isapi.checkLogin). */
const USER_CHECK_PATH = '/ISAPI/Security/userCheck';

/** A sub-stream (SD) snapshot: stream ID channel × 100 + 2. */
const SUB_STREAM_PICTURE = /\/Streaming\/channels\/\d+02\/picture(?:\?|$)/;

/**
 * Time limit for a request whose caller doesn't set one.
 * @param {string} method
 * @param {string} path
 * @returns {number} milliseconds
 */
export function defaultTimeoutMs(method, path) {
  switch (method.toUpperCase()) {
    case 'GET':
      if (!path.includes('/picture')) return TIMEOUT_MS.read;
      return SUB_STREAM_PICTURE.test(path) ? TIMEOUT_MS.picture : TIMEOUT_MS.fullPicture;
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
 * Whether a failed DELETE means the device can't delete this resource at
 * all: a "not here" answer under the shared policy (isFallbackError), or a
 * method the resource doesn't allow (HTTP 405, methodNotAllowed). Nothing
 * was deleted then, so a save can go ahead another way.
 * @param {unknown} err
 * @returns {boolean}
 */
function cannotDelete(err) {
  return isFallbackError(err) ||
    (err instanceof IsapiError && (err.httpStatus === 405 || err.reason === 'methodNotAllowed'));
}

/**
 * A camera channel. `kind` says which URL family configures it: "analog"
 * for cameras wired to the device, "digital" for IP cameras behind an NVR.
 * `ipAddress` is an IP camera's own address, when the NVR lists it: it ties
 * the channel to that camera's alarm output (see resolveEventActions).
 * @typedef {{id: string, name: string, kind: 'analog'|'digital', ipAddress?: string}} Channel
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
   * Verify credentials (checkLogin) and read the device's identity. An
   * explicit user action, so it may retry credentials the device rejected
   * earlier. It starts from a fresh challenge, so a wrong password costs
   * one login attempt, not two.
   * @param {DeviceConfig} config
   * @returns {Promise<{deviceName: string|null, model: string|null, firmwareVersion: string|null}>}
   * @throws {AuthError} also when the device has locked this computer out (`locked`), or with the attempts left
   */
  async getDeviceInfo(config) {
    forgetRejectedCredentials(config);
    forgetDigestSessions(config);
    await this.checkLogin(config);
    const root = (await this.getXml(config, '/ISAPI/System/deviceInfo', { timeoutMs: TIMEOUT_MS.connect })).documentElement;
    return {
      deviceName: childText(root, 'deviceName'),
      model: childText(root, 'model'),
      firmwareVersion: childText(root, 'firmwareVersion'),
    };
  },

  /**
   * Log in explicitly, as Hikvision's web UI (in Digest mode) and SDK do,
   * with GET /ISAPI/Security/userCheck. A rejected login there can come with
   * an explanation that other requests' HTML 401 pages lack: whether the
   * device has locked this computer out and for how long, or how many
   * attempts are left (see AuthError). Firmware without userCheck ("not
   * here", see isFallbackError) leaves the check to the next request; the
   * device checks the login before it looks at the path, so getting that far
   * means it accepted the credentials.
   * @param {DeviceConfig} config
   * @returns {Promise<void>}
   * @throws {AuthError} the device rejected the login, also when it says so in a 200 answer (older firmware)
   */
  async checkLogin(config) {
    let resp;
    try {
      resp = await this.request(config, 'GET', USER_CHECK_PATH, null, { timeoutMs: TIMEOUT_MS.connect });
    } catch (err) {
      if (isFallbackError(err)) return;
      throw err;
    }
    const status = parseLoginStatus(String(resp.data));
    if (status?.statusValue !== undefined && status.statusValue !== 200) {
      const err = rejectCredentials(config, status);
      this.onAuthFailure?.(err);
      throw err;
    }
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
        /** @type {Channel[]} */
        let channels = childElements(root, ep.tag).map(el => {
          const ipAddress = childText(childElement(el, 'sourceInputPortDescriptor'), 'ipAddress');
          return {
            id: childText(el, 'id') ?? '',
            name: childText(el, 'name') || childText(el, 'channelName') || '',
            kind: ep.kind,
            ...(ipAddress ? { ipAddress } : {}),
          };
        });

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
   *
   * When no URL has the frame, the first URL's error is the one thrown: it
   * is the stream the user asked for. The bare channel ID is only a guess,
   * and the DS-7604NI answers it with 400 badXmlContent, which would explain
   * nothing.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {'main'|'sub'} [stream]
   * @param {RequestOptions} [options] - e.g. the live feed's abort signal
   * @returns {Promise<Blob>}
   */
  async getSnapshot(config, channelId, stream = 'main', options = {}) {
    const ids = stream === 'sub' ? [`${channelId}02`, `${channelId}01`] : [`${channelId}01`];
    ids.push(channelId);
    /** @type {unknown} */
    let firstError;
    for (const id of ids) {
      try {
        const resp = await this.request(config, 'GET', `/ISAPI/Streaming/channels/${id}/picture`, null, options);
        return new Blob([resp.data], { type: 'image/jpeg' });
      } catch (err) {
        if (!isFallbackError(err)) throw err;
        firstError ??= err;
      }
    }
    throw firstError;
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
   *
   * Optional: the editor works with default limits without them, so any
   * error answer, or a body that isn't XML, gives null rather than failing
   * the Motion tab. Not only "not here" answers: the DS-7604NI answers 503
   * serviceUnavailable every time for capability resources it doesn't serve.
   * No answer at all, or a rejected login, still throws.
   * @param {DeviceConfig} config
   * @param {Pick<Channel, 'id'|'kind'>} channel
   * @returns {Promise<XMLDocument|null>}
   */
  async getMotionCapabilities(config, channel) {
    let resp;
    try {
      resp = await this.request(config, 'GET', `${this.motionDetectionPath(channel)}/capabilities`);
    } catch (err) {
      if (!(err instanceof IsapiError)) throw err;
      return null;
    }
    return parseXmlOrNull(String(resp.data));
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
   * Save privacy masks the way the device's own web UI does: DELETE every
   * stored region ({path}/regions), then PUT the document holding exactly
   * the new regions. Two requests because the DS-7604NI merges a PUT into
   * its stored regions by id — a region left out stays stored — and masks a
   * region whatever its own <enabled>, so neither leaving a mask out nor
   * disabling it removes it.
   *
   * If the PUT fails after the DELETE succeeded, the document as loaded is
   * PUT back so the camera isn't left without masks, and the PUT's error is
   * thrown.
   *
   * Firmware that can't DELETE the regions (a "not here" answer, e.g.
   * cameras with fixed mask slots) gets a single PUT instead, which keeps
   * every slot and disables and empties the unused ones, as this extension
   * saved before. The failed DELETE changed nothing, and on such firmware
   * disabling a slot is the only way to remove a mask, so failing the save
   * would only leave the user unable to change masks at all. A bare
   * PrivacyMaskRegionList (getPrivacyMask's fallback to {base}/regions) goes
   * back to its own path the same way, without a DELETE.
   *
   * @param {DeviceConfig} config
   * @param {string} path - where getPrivacyMask loaded the document from
   * @param {XMLDocument} original - the document as loaded; not modified
   * @param {{enabled: boolean, rects: DeviceRect[]}} mask - device units, e.g. from canvasRectToPrivacy
   * @returns {Promise<{doc: XMLDocument, result: WriteResult}>} the document the device now has, and whether it needs a reboot
   * @throws {WriteRollbackError} when restoring the loaded masks after a failed PUT failed too
   * @throws {IsapiError|NetworkError|AuthError} the request that failed, when the device was left as it was
   */
  async savePrivacyMask(config, path, original, mask) {
    /** @param {UnusedPrivacySlots} unused */
    const edited = unused => {
      const doc = cloneXml(original);
      applyPrivacyMask(doc, { ...mask, unused });
      return doc;
    };
    /** One PUT that disables leftover slots: for when regions can't be deleted first */
    const putInPlace = async () => {
      const doc = edited('disable');
      return { doc, result: await this.putXml(config, path, doc) };
    };

    if (original.documentElement.localName === 'PrivacyMaskRegionList') return putInPlace();

    let deleted;
    try {
      deleted = await this.deleteResource(config, `${path}/regions`);
    } catch (err) {
      if (!cannotDelete(err)) throw err;
      return putInPlace();
    }

    const doc = edited('remove');
    try {
      const result = await this.putXml(config, path, doc);
      return { doc, result: { rebootRequired: deleted.rebootRequired || result.rebootRequired } };
    } catch (err) {
      await this.restorePrivacyMask(config, path, original, err);
      throw err;
    }
  },

  /**
   * PUT the masks as loaded back after a save cleared them but failed to
   * write the new ones.
   * @param {DeviceConfig} config
   * @param {string} path
   * @param {XMLDocument} original
   * @param {unknown} saveError - why the save failed
   * @returns {Promise<void>}
   * @throws {WriteRollbackError} when the restore fails too
   */
  async restorePrivacyMask(config, path, original, saveError) {
    try {
      await this.putXml(config, path, original);
    } catch (rollbackError) {
      const reason = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
      throw new WriteRollbackError(
        `${reason(saveError)}. Putting the previous privacy masks back failed too (${reason(rollbackError)}), ` +
        'so the camera may have no privacy masks now. Save them again.',
        { cause: saveError, rollbackError });
    }
  },

  /**
   * Every match of one search, following the device's paging. The DS-7604NI
   * sends at most 64 matches a page however many maxResults asks for, and its
   * numOfMatches means different things on different tracks, so each page
   * starts where the matches received so far end. Paging stops when the
   * device says it's done, or when a page brings nothing new: an empty page,
   * or only repeats from firmware that ignores the position.
   * @param {DeviceConfig} config
   * @param {string} trackId - e.g. "101" for channel 1's main stream, "103" for its pictures
   * @param {Date} start
   * @param {Date} end
   * @returns {Promise<Element[]>} searchMatchItem elements without repeats, in the order received
   */
  async searchMatches(config, trackId, start, end) {
    const searchId = crypto.randomUUID();
    /** @type {Map<string, Element>} */
    const matches = new Map();
    let position = 0;
    for (let request = 0; request < MAX_SEARCH_REQUESTS; request++) {
      const body = buildSearchXml({ searchId, trackId, start, end, position });
      const resp = await this.request(config, 'POST', '/ISAPI/ContentMgmt/search', body);
      const page = parseSearchPage(parseXml(String(resp.data)));
      const known = matches.size;
      for (const match of page.matches) {
        const key = searchMatchKey(match);
        if (!matches.has(key)) matches.set(key, match);
      }
      if (page.status !== 'MORE' || matches.size === known) break;
      position += page.matches.length;
    }
    return [...matches.values()];
  },

  /**
   * All recordings of a channel's main stream in a time range.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {Date} start
   * @param {Date} end
   * @returns {Promise<Recording[]>} sorted by start time
   */
  async searchRecordings(config, channelId, start, end) {
    const matches = await this.searchMatches(config, `${channelId}01`, start, end);
    return parseRecordings(matches).sort((a, b) => a.start.getTime() - b.start.getTime());
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
    const matches = await this.searchMatches(config, `${channelId}03`, start, end);
    return parsePictures(matches).sort((a, b) => a.time.getTime() - b.time.getTime());
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
   * Where to save a loaded trigger: the resource its own <id> names, so a
   * trigger picked out of the full list goes back to the trigger it is, even
   * if its id isn't VMD-{channel}. Normally the same as eventTriggerPath.
   * @param {XMLDocument} doc - the trigger as loaded
   * @param {string} channelId - for a document without an <id>
   * @returns {string}
   */
  eventTriggerSavePath(doc, channelId) {
    const id = childText(doc.documentElement, 'id');
    return id ? `/ISAPI/Event/triggers/${encodeURIComponent(id)}` : this.eventTriggerPath(channelId);
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
      const id = String(channelId);
      const trigger = childElements(list, 'EventTrigger').find(t =>
        childText(t, 'eventType') === 'VMD' &&
        (childText(t, 'videoInputChannelID') === id ||
          childText(t, 'dynVideoInputChannelID') === id ||
          childText(t, 'id') === `VMD-${id}`));
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

  /**
   * What the device offers for motion-event actions: which actions its
   * triggersCap flags for motion, its alarm outputs, and which channels'
   * cameras have a white light or speaker it can switch. These describe the
   * hardware, not settings, so they're read once per device and kept until
   * clearDeviceCache() (on disconnect).
   *
   * Each is optional: a device without the resource just offers less (see
   * resolveEventActions). A failed load, or one where the device answered
   * an error other than "not here" (e.g. busy) or a body that isn't XML,
   * isn't kept, so the next load asks again.
   * @param {DeviceConfig} config
   * @returns {Promise<EventActionSupport>}
   * @throws {NetworkError|AuthError} when the device didn't answer or rejected the login
   */
  getEventActionSupport(config) {
    const key = deviceKey(config);
    const cached = eventActionSupport.get(key);
    if (cached) return cached.then(entry => entry.support);

    const loading = loadEventActionSupport(config);
    eventActionSupport.set(key, loading);
    /** Forget a load that shouldn't be reused; the caller still sees its outcome */
    const forget = () => {
      if (eventActionSupport.get(key) === loading) eventActionSupport.delete(key);
    };
    loading.then(entry => { if (entry.provisional) forget(); }, forget);
    return loading.then(entry => entry.support);
  },

  /**
   * Forget everything read about devices' hardware (getEventActionSupport),
   * e.g. on disconnect, so reconnecting reads it afresh.
   */
  clearDeviceCache() {
    eventActionSupport.clear();
  },
};

/**
 * getEventActionSupport results per device, with whether one is only good
 * for the load that read it.
 * @type {Map<string, Promise<{support: EventActionSupport, provisional: boolean}>>}
 */
const eventActionSupport = new Map();

/**
 * A device and user, for per-device caches.
 * @param {DeviceConfig} config
 */
function deviceKey(config) {
  return `${config.host}:${config.port}|${config.username}`;
}

/**
 * Read what getEventActionSupport returns. `provisional` is set when the
 * device answered one of the requests with an error other than "not here",
 * or with a body that isn't XML: it was treated as absent for this load only.
 * @param {DeviceConfig} config
 * @returns {Promise<{support: EventActionSupport, provisional: boolean}>}
 */
async function loadEventActionSupport(config) {
  let provisional = false;
  /**
   * GET a resource the actions can do without: its body, or null when the
   * device answered with an error. No answer at all still throws.
   * @param {string} path
   * @returns {Promise<string|null>}
   */
  const optional = async (path) => {
    try {
      return String((await Isapi.request(config, 'GET', path)).data);
    } catch (err) {
      if (!(err instanceof IsapiError)) throw err;
      if (!isFallbackError(err)) provisional = true;
      return null;
    }
  };
  /**
   * An optional XML resource, or null. A body that isn't XML (empty, or some
   * firmware's HTML page) is treated like a busy answer: absent, for this load.
   * @param {string} path
   */
  const optionalXml = async (path) => {
    const body = await optional(path);
    const doc = body === null ? null : parseXmlOrNull(body);
    if (body !== null && doc === null) provisional = true;
    return doc;
  };

  const triggerCap = readMotionTriggerCap(await optionalXml('/ISAPI/Event/triggersCap'));
  /**
   * Channels an NVR lists for its cameras' lights or speakers.
   * @param {string} resource - "whiteLightAlarm" or "AudioAlarm"
   * @param {'WhiteLightAlarmList'|'AudioAlarmList'} listName
   */
  const lightAudioChannels = async (resource, listName) => {
    const body = await optional(`/ISAPI/Event/triggers/notifications/channels/${resource}?format=json`);
    return readLightAudioChannels(body === null ? null : jsonOrNull(body), listName);
  };
  /** @type {Promise<Set<string>>} */
  const none = Promise.resolve(new Set());

  const [alarmOutputs, whiteLightChannels, audioChannels] = await Promise.all([
    triggerCap === null || triggerCap.isSupportIO ? readAlarmOutputList(optionalXml) : Promise.resolve([]),
    triggerCap?.isSupportWhiteLightOut ? lightAudioChannels('whiteLightAlarm', 'WhiteLightAlarmList') : none,
    triggerCap?.isSupportAudioOut ? lightAudioChannels('AudioAlarm', 'AudioAlarmList') : none,
  ]);
  return { support: { triggerCap, alarmOutputs, whiteLightChannels, audioChannels }, provisional };
}

/**
 * The alarm outputs an event can switch, read the way Hikvision's web UI
 * reads them: one merged list when outputs/capabilities mentions IOType
 * (each port then says whether it's the device's own or an IP camera's, as
 * on the DS-7604NI); otherwise the device's own outputs plus its IP
 * cameras' (IOProxy).
 * @param {(path: string) => Promise<XMLDocument|null>} optionalXml
 * @returns {Promise<AlarmOutput[]>}
 */
async function readAlarmOutputList(optionalXml) {
  const caps = await optionalXml('/ISAPI/System/IO/outputs/capabilities');
  const merged = findDescendant(caps?.documentElement, 'IOType') !== null;
  const [own, proxied] = await Promise.all([
    optionalXml('/ISAPI/System/IO/outputs'),
    merged ? null : optionalXml('/ISAPI/ContentMgmt/IOProxy/outputs'),
  ]);
  return [
    ...(own ? readAlarmOutputs(own, merged ? null : 'local') : []),
    ...(proxied ? readAlarmOutputs(proxied, 'digital') : []),
  ];
}

/**
 * Parse a JSON answer, or null when it isn't JSON: firmware that doesn't
 * know ?format=json may answer in XML, which holds no list we can use.
 * @param {string} text
 * @returns {unknown}
 */
function jsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}
