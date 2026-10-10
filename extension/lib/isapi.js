/**
 * Hikvision ISAPI client, called directly from the extension page.
 *
 * Extension pages with host permission aren't subject to CORS, so there's no
 * need to proxy through the service worker: responses stay binary (snapshots
 * become Blobs, not base64) and the password never travels over messaging.
 *
 * Depends on lib/digest-auth.js and lib/xml.js.
 */

import { AuthError, digestFetch, forgetRejectedCredentials } from './digest-auth.js';
import {
  SEARCH_PAGE_SIZE, buildCalendarXml, buildSearchXml, parseCalendar, parseSearchResult, toDeviceTime,
} from './playback.js';
import { childElements, childText, parseXml, serializeXml } from './xml.js';

/**
 * Rethrow auth failures so endpoint fallbacks don't retry with credentials
 * the device already rejected (each attempt counts towards its lockout).
 * @param {unknown} err
 */
export function rethrowAuthError(err) {
  if (err instanceof AuthError) throw err;
}

/** @typedef {import('./digest-auth.js').DeviceConfig} DeviceConfig */
/** @typedef {import('./playback.js').Recording} Recording */

/** Stop paging a recording search after this many results. */
const MAX_SEARCH_RESULTS = 2000;

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
   * digestFetch, plus the auth-failure hook.
   * @param {DeviceConfig} config
   * @param {string} method
   * @param {string} path
   * @param {string|null} [body]
   */
  async request(config, method, path, body = null) {
    try {
      return await digestFetch(config, method, path, body);
    } catch (err) {
      if (err instanceof AuthError) this.onAuthFailure?.(err);
      throw err;
    }
  },

  /**
   * GET an ISAPI resource as an XML document.
   * @param {DeviceConfig} config
   * @param {string} path
   * @returns {Promise<XMLDocument>}
   */
  async getXml(config, path) {
    const resp = await this.request(config, 'GET', path);
    return parseXml(String(resp.data));
  },

  /**
   * PUT an edited XML document back to the device.
   * @param {DeviceConfig} config
   * @param {string} path
   * @param {XMLDocument} doc
   */
  async putXml(config, path, doc) {
    await this.request(config, 'PUT', path, serializeXml(doc));
  },

  /**
   * Verify credentials and read the device's identity. An explicit user
   * action, so it may retry credentials the device rejected earlier.
   * @param {DeviceConfig} config
   * @returns {Promise<{deviceName: string|null, model: string|null, firmwareVersion: string|null}>}
   */
  async getDeviceInfo(config) {
    forgetRejectedCredentials(config);
    const root = (await this.getXml(config, '/ISAPI/System/deviceInfo')).documentElement;
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
        rethrowAuthError(err);
        // Try the next endpoint
      }
    }

    // Last resort: probe snapshots on the first 4 channels
    /** @type {Channel[]} */
    const probed = [];
    for (let id = 1; id <= 4; id++) {
      try {
        await this.request(config, 'GET', `/ISAPI/Streaming/channels/${id}01/picture`);
        probed.push({ id: String(id), name: '', kind: 'analog' });
      } catch (err) {
        rethrowAuthError(err);
        // No camera on this channel
      }
    }
    if (probed.length > 0) return probed;

    throw new Error('Could not discover channels. Check that cameras are connected to the NVR.');
  },

  /**
   * Fetch one JPEG frame. Stream IDs are channel × 100 + 1 for the main
   * (HD) stream and + 2 for the sub (SD) stream, which is smaller and faster.
   * Falls back to the main stream when a camera has no sub-stream, and to
   * the bare channel ID for firmware that uses that.
   * @param {DeviceConfig} config
   * @param {string} channelId
   * @param {'main'|'sub'} [stream]
   * @returns {Promise<Blob>}
   */
  async getSnapshot(config, channelId, stream = 'main') {
    const ids = stream === 'sub' ? [`${channelId}02`, `${channelId}01`] : [`${channelId}01`];
    ids.push(channelId);
    let lastError;
    for (const id of ids) {
      try {
        const resp = await this.request(config, 'GET', `/ISAPI/Streaming/channels/${id}/picture`);
        return new Blob([resp.data], { type: 'image/jpeg' });
      } catch (err) {
        rethrowAuthError(err);
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
   * limits, sensitivity steps, target types), or null if not available.
   * @param {DeviceConfig} config
   * @param {Pick<Channel, 'id'|'kind'>} channel
   * @returns {Promise<XMLDocument|null>}
   */
  async getMotionCapabilities(config, channel) {
    try {
      return await this.getXml(config, `${this.motionDetectionPath(channel)}/capabilities`);
    } catch (err) {
      rethrowAuthError(err);
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
      rethrowAuthError(err);
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
   * A still image from recorded video at a moment. Not part of documented
   * ISAPI, so only some firmware supports it; returns null when the device
   * doesn't answer with a JPEG.
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
        rethrowAuthError(err);
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
      rethrowAuthError(err);
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
      rethrowAuthError(err);
    }

    throw new Error('Event triggers not supported on this device or firmware');
  },
};
