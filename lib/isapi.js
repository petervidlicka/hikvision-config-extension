/**
 * Hikvision ISAPI client, called directly from the extension page.
 *
 * Extension pages with host permission aren't subject to CORS, so there's no
 * need to proxy through the service worker: responses stay binary (snapshots
 * become Blobs, not base64) and the password never travels over messaging.
 *
 * Depends on lib/digest-auth.js and lib/xml.js.
 */

/**
 * Rethrow auth failures so endpoint fallbacks don't retry with credentials
 * the device already rejected (each attempt counts towards its lockout).
 */
function rethrowAuthError(err) {
  if (err instanceof AuthError) throw err;
}

const Isapi = {
  /**
   * Called once per AuthError. The UI uses this to stop polling and return
   * to the login form.
   * @type {((err: AuthError) => void) | null}
   */
  onAuthFailure: null,

  /** digestFetch, plus the auth-failure hook. */
  async request(config, method, path, body = null) {
    try {
      return await digestFetch(config, method, path, body);
    } catch (err) {
      if (err instanceof AuthError) this.onAuthFailure?.(err);
      throw err;
    }
  },

  /** GET an ISAPI resource as an XML document. */
  async getXml(config, path) {
    const resp = await this.request(config, 'GET', path);
    return parseXml(resp.data);
  },

  /** PUT an edited XML document back to the device. */
  async putXml(config, path, doc) {
    await this.request(config, 'PUT', path, serializeXml(doc));
  },

  /**
   * Verify credentials and read the device's identity. An explicit user
   * action, so it may retry credentials the device rejected earlier.
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
   * @returns {Promise<{id: string, name: string, kind: 'analog'|'digital'}[]>}
   */
  async getChannels(config) {
    const endpoints = [
      { path: '/ISAPI/System/Video/inputs/channels', tag: 'VideoInputChannel', kind: 'analog' },
      { path: '/ISAPI/ContentMgmt/InputProxy/channels', tag: 'InputProxyChannel', kind: 'digital' },
      { path: '/ISAPI/Streaming/channels', tag: 'StreamingChannel', kind: 'analog' },
    ];

    for (const ep of endpoints) {
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
   * Fetch one JPEG frame from the channel's main stream.
   * @returns {Promise<Blob>}
   */
  async getSnapshot(config, channelId) {
    let resp;
    try {
      resp = await this.request(config, 'GET', `/ISAPI/Streaming/channels/${channelId}01/picture`);
    } catch (err) {
      rethrowAuthError(err);
      // Some firmware uses the bare channel ID
      resp = await this.request(config, 'GET', `/ISAPI/Streaming/channels/${channelId}/picture`);
    }
    return new Blob([resp.data], { type: 'image/jpeg' });
  },

  /**
   * Base path for a channel's video-input settings. IP cameras behind an NVR
   * are configured through InputProxy, as in Hikvision's own web UI; some
   * NVRs also answer on the analog path, but that isn't guaranteed.
   * @param {{id: string, kind: 'analog'|'digital'}} channel
   */
  videoInputBase(channel) {
    return channel.kind === 'digital'
      ? `/ISAPI/ContentMgmt/InputProxy/channels/${channel.id}/video`
      : `/ISAPI/System/Video/inputs/channels/${channel.id}`;
  },

  motionDetectionPath(channel) {
    return `${this.videoInputBase(channel)}/motionDetection`;
  },

  /**
   * Motion detection capabilities (allowed region types, region and corner
   * limits, sensitivity steps, target types), or null if not available.
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

  eventTriggerPath(channelId) {
    return `/ISAPI/Event/triggers/VMD-${channelId}`;
  },

  /**
   * Load the motion-detection (VMD) event trigger for a channel. If the
   * per-trigger endpoint isn't available, pick it out of the full trigger
   * list into a document of its own, so a save only ever sends this trigger.
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
