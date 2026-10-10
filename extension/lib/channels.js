/**
 * Read a device's camera channel lists, and whether each camera is online.
 *
 * A device lists its cameras in up to two documents: its analog inputs
 * (VideoInputChannel, /ISAPI/System/Video/inputs/channels) and the IP
 * cameras it records (InputProxyChannel, /ISAPI/ContentMgmt/InputProxy/channels).
 * A hybrid DVR has both. Hikvision's web UI and SDK always read both and list
 * the analog inputs first, then the IP cameras, so this does the same
 * (mergeChannelLists). Firmware with neither list still lists its streams
 * (StreamingChannel, /ISAPI/Streaming/channels), each naming the analog
 * input or IP camera it streams (readStreamingChannels).
 *
 * Whether an IP camera is connected comes from a third document
 * (InputProxyChannelStatus, /ISAPI/ContentMgmt/InputProxy/channels/status),
 * and the size of each camera's picture from the stream list (its main
 * stream's resolution, see readMainStreamSizes). Fetching all of these is up
 * to lib/isapi.js; everything here is pure.
 *
 * Depends on lib/xml.js.
 */

import { childElement, childElements, childText } from './xml.js';

/** @typedef {import('./config-xml.js').Size} Size */

/**
 * A camera channel.
 * @typedef {object} Channel
 * @property {string} id - the channel number the device's URLs use, e.g. "1"
 * @property {string} name - the name set on the device; may be empty
 * @property {'analog'|'digital'} kind - which URL family configures the channel:
 *   "analog" for cameras wired to the device, "digital" for IP cameras behind an
 *   NVR (see Isapi.videoInputBase)
 * @property {string} [ipAddress] - an IP camera's own address, when the NVR lists it:
 *   it ties the channel to that camera's alarm output (see resolveEventActions)
 * @property {boolean} [online] - false when the device reports the camera
 *   disconnected (an IP camera) or its input switched off (an analog one);
 *   missing when the device doesn't say, which counts as online
 * @property {Size} [mainStreamSize] - the resolution of the camera's main stream as the
 *   device lists it (e.g. 2688×1520): the camera's real picture aspect, which an NVR's
 *   squeezed 704×576 still is shown at, and the size to ask an NVR for a full-size
 *   still (see lib/picture-size.js, fullSizeUpgrade in lib/snapshots.js); missing when unknown
 */

/** The element each of the device's own channel lists holds its channels in. */
const LIST_TAGS = /** @type {const} */ ({ analog: 'VideoInputChannel', digital: 'InputProxyChannel' });

/**
 * Read one of the device's own channel lists: the analog inputs or the IP
 * cameras. Entries without a numeric id are left out, since no channel URL
 * could use them.
 * @param {Element} root - the VideoInputChannelList or InputProxyChannelList element
 * @param {Channel['kind']} kind - "analog" for the VideoInputChannel list, "digital" for InputProxyChannel
 * @returns {Channel[]}
 */
export function readChannelList(root, kind) {
  return childElements(root, LIST_TAGS[kind])
    .map(el => {
      const ipAddress = childText(childElement(el, 'sourceInputPortDescriptor'), 'ipAddress');
      const online = inputEnabled(el);
      return {
        id: childText(el, 'id') ?? '',
        name: childText(el, 'name') || childText(el, 'channelName') || '',
        kind,
        ...(ipAddress ? { ipAddress } : {}),
        ...(online === undefined ? {} : { online }),
      };
    })
    .filter(hasNumericId);
}

/**
 * Read the stream list of firmware that has no channel list. A channel has
 * several streams (101 and 102 are channel 1's main and sub stream, 201
 * channel 2's main stream), so each channel is listed once, under the name of
 * its first stream.
 *
 * Which channel a stream belongs to, and so which URLs configure it, comes
 * from the input its <Video> names (see streamInput): an NVR's IP camera
 * names <dynVideoInputChannelID>, an analog input <videoInputChannelID>.
 * Listing an NVR's cameras as analog would send their settings to the analog
 * URLs, which an NVR need not have.
 *
 * A stream's <channelName> may be only its own number ("101" on the
 * DS-7604NI) rather than the camera's name, so a name that is only digits is
 * left out and the channel is shown by its number (see channelLabel in
 * src/ui.js).
 * @param {Element} root - the StreamingChannelList element
 * @returns {Channel[]}
 * @example
 * // <StreamingChannel><id>101</id><channelName>101</channelName>
 * //   <Video><dynVideoInputChannelID>1</dynVideoInputChannelID></Video></StreamingChannel>
 * readStreamingChannels(list) // → [{id: '1', name: '', kind: 'digital'}]
 */
export function readStreamingChannels(root) {
  /** @type {Map<string, Channel>} */
  const channels = new Map();
  for (const el of childElements(root, 'StreamingChannel')) {
    const streamId = childText(el, 'id') ?? '';
    const { id, kind } = streamInput(el, streamId);
    if (channels.has(id)) continue;
    channels.set(id, { id, name: streamCameraName(el, streamId), kind });
  }
  return [...channels.values()].filter(hasNumericId);
}

/**
 * The input elements a stream's <Video> may name, with the kind of channel
 * each marks, as the web UI writes them (<dynVideoInputChannelID> for a
 * channel above the analog count). A stream naming both is taken for an IP camera.
 */
const STREAM_INPUT_TAGS = /** @type {const} */ ([
  ['digital', 'dynVideoInputChannelID'],
  ['analog', 'videoInputChannelID'],
]);

/**
 * The channel a stream belongs to and its kind. The input the stream names
 * is the channel number the per-channel URLs take; a stream naming none (or
 * no number) counts by its id (channel × 100 + stream), as an analog input
 * unless it named an IP camera's input.
 * @param {Element} el - a StreamingChannel element
 * @param {string} streamId - its <id>
 * @returns {{id: string, kind: Channel['kind']}}
 */
function streamInput(el, streamId) {
  const video = childElement(el, 'Video');
  const named = STREAM_INPUT_TAGS.find(([, tag]) => childElement(video, tag));
  const kind = named?.[0] ?? 'analog';
  const input = named ? childText(video, named[1]) ?? '' : '';
  const id = /^\d+$/.test(input) ? String(Number(input)) : String(Math.floor(parseInt(streamId, 10) / 100));
  return { id, kind };
}

/**
 * A stream's camera name, leaving out one that only numbers the stream: the
 * stream's own id, or any name that is only digits.
 * @param {Element} el - a StreamingChannel element
 * @param {string} streamId - its <id>
 * @returns {string} empty when the stream has no name of its own
 */
function streamCameraName(el, streamId) {
  return [childText(el, 'name'), childText(el, 'channelName')]
    .find(name => name && name !== streamId && !/^\d+$/.test(name)) ?? '';
}

/**
 * The channels of a device that may have both analog inputs and IP cameras:
 * the analog inputs first, then the IP cameras, as Hikvision's web UI and
 * SDK list them. On a hybrid DVR the IP cameras are numbered after the analog
 * inputs, so ids don't repeat. Should an IP camera's id repeat an analog
 * input's anyway, the analog entry is kept and the IP camera left out: a
 * device answering both lists with the same channels then still gets the list
 * it got when only the first answer was used.
 * @param {Channel[]} analog
 * @param {Channel[]} digital
 * @returns {Channel[]}
 * @example
 * mergeChannelLists([{id: '1', name: '', kind: 'analog'}], [{id: '1', …}, {id: '5', …}])
 * // → analog 1, then digital 5
 */
export function mergeChannelLists(analog, digital) {
  const analogIds = new Set(analog.map(ch => ch.id));
  return [...analog, ...digital.filter(ch => !analogIds.has(ch.id))];
}

/**
 * Read which IP cameras the NVR is connected to, by channel id. Like the
 * web UI, only <online> counts. Entries without a true or false there are
 * left out: the device didn't say.
 * @param {Element} root - the InputProxyChannelStatusList element
 * @returns {Map<string, boolean>} channel id → online
 */
export function readChannelStatus(root) {
  /** @type {Map<string, boolean>} */
  const online = new Map();
  for (const el of childElements(root, 'InputProxyChannelStatus')) {
    const id = childText(el, 'id');
    const value = childText(el, 'online');
    if (id && (value === 'true' || value === 'false')) online.set(id, value === 'true');
  }
  return online;
}

/**
 * Mark each IP camera online or offline as the NVR's status says, matching
 * by channel id rather than by position (the status list may leave a channel
 * out). Analog inputs keep what their own list said (see readChannelList).
 * @param {Channel[]} channels
 * @param {Map<string, boolean>} status - from readChannelStatus
 * @returns {Channel[]}
 */
export function applyChannelStatus(channels, status) {
  return channels.map(ch => {
    const online = ch.kind === 'digital' ? status.get(ch.id) : undefined;
    return online === undefined ? ch : { ...ch, online };
  });
}

/**
 * Read the resolution of each channel's main stream from the stream list
 * (StreamingChannel, /ISAPI/Streaming/channels): stream {id}01's
 * Video/videoResolutionWidth and videoResolutionHeight. The main stream
 * rather than the sub stream, because a sub stream is often a 4:3 size such
 * as 704×576 on a 16:9 camera, itself squeezed. An NVR lists every IP
 * camera's streams here (the DS-7604NI: 2688×1520 main, 640×360 sub).
 * @param {Element} root - the StreamingChannelList element
 * @returns {Map<string, Size>} channel id → its main stream's size; channels without one are left out
 * @example
 * readMainStreamSizes(list) // → Map {'1' => {width: 2688, height: 1520}, '2' => …}
 */
export function readMainStreamSizes(root) {
  /** @type {Map<string, Size>} */
  const sizes = new Map();
  for (const el of childElements(root, 'StreamingChannel')) {
    const streamId = childText(el, 'id') ?? '';
    if (!/^\d+01$/.test(streamId)) continue;
    const video = childElement(el, 'Video');
    const width = Number(childText(video, 'videoResolutionWidth'));
    const height = Number(childText(video, 'videoResolutionHeight'));
    if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
      sizes.set(String(Number(streamId.slice(0, -2))), { width, height });
    }
  }
  return sizes;
}

/**
 * Give each channel its main stream's size, by channel id.
 * @param {Channel[]} channels
 * @param {Map<string, Size>} sizes - from readMainStreamSizes
 * @returns {Channel[]} channels missing from `sizes` are returned as they were
 */
export function applyStreamSizes(channels, sizes) {
  return channels.map(ch => {
    const mainStreamSize = sizes.get(ch.id);
    return mainStreamSize ? { ...ch, mainStreamSize } : ch;
  });
}

/**
 * Whether an analog input is switched on (<videoInputEnabled>). IP cameras
 * don't have the field; their state comes from the status list instead.
 * @param {Element} el - a VideoInputChannel or InputProxyChannel element
 * @returns {boolean|undefined} undefined when the element doesn't say
 */
function inputEnabled(el) {
  const enabled = childText(el, 'videoInputEnabled');
  return enabled === 'true' ? true : enabled === 'false' ? false : undefined;
}

/** @param {Channel} ch */
function hasNumericId(ch) {
  return /^\d+$/.test(ch.id);
}
