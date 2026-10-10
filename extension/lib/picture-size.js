/**
 * How big a snapshot is, and the size to show it at so it has its camera's
 * real aspect.
 *
 * An NVR like the DS-7604NI serves a 704×576 still (4CIF) of a camera whose
 * streams are 16:9 (2688×1520 main, 640×360 sub): the whole picture, squeezed
 * to 1.22:1, so shown at its own pixel aspect everything looks 44 % too
 * tall. The camera's real aspect is its main stream's (the sub stream may
 * itself be a squeezed 4:3 size), which /ISAPI/Streaming/channels lists
 * (see readMainStreamSizes in lib/channels.js).
 *
 * Pure: reads bytes and numbers only, so everything here runs without a
 * device or a page.
 */

/** @typedef {import('./config-xml.js').Size} Size */

/**
 * How far a picture's aspect may be from its stream's before it is shown at
 * the stream's instead: 3 %. Rounding makes real sizes differ a little (the
 * NVR's full-size still is 1920×1088, 0.2 % off 16:9; a stored 1280×720
 * picture of a 2688×1520 stream 0.5 %), and stretching those would only blur
 * them. A squeezed 4CIF still is 31 % off.
 */
export const ASPECT_TOLERANCE = 0.03;

/**
 * JPEG markers that start a frame header (SOF0–SOF15, without DHT, JPG and
 * DAC, which share the range): the header holds the picture's size.
 */
const FRAME_HEADER_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Markers that stand alone, without a length: TEM and RST0–RST7. */
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
/** Start Of Scan and End Of Image: past these there is no frame header to find. */
const SCAN_OR_END_MARKERS = new Set([0xda, 0xd9]);

/**
 * A JPEG's size in pixels, read from its frame header without decoding the
 * picture (the DS-7604NI's is at byte 140).
 * @param {Uint8Array} bytes - a whole JPEG, or at least its start up to the frame header
 * @returns {Size|null} null when the bytes aren't a JPEG or end before its frame header
 * @example
 * jpegSize(snapshotBytes) // → {width: 704, height: 576}
 */
export function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    // A marker may be padded with any number of FF bytes
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (STANDALONE_MARKERS.has(marker)) {
      i += 2;
      continue;
    }
    if (SCAN_OR_END_MARKERS.has(marker)) return null;
    if (FRAME_HEADER_MARKERS.has(marker)) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    // Any other segment: its length counts its own two bytes, not the marker's
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

/**
 * Whether two sizes are the same, e.g. an NVR's main-stream and sub-stream
 * stills (the DS-7604NI serves the same 704×576 still for both).
 * @param {Size|null} a
 * @param {Size|null} b
 * @returns {boolean} false when either is unknown
 */
export function sameSize(a, b) {
  return a !== null && b !== null && a.width === b.width && a.height === b.height;
}

/**
 * The size to show a picture at so it has its camera's real aspect: the
 * stream's, when the picture's own differs from it by more than
 * ASPECT_TOLERANCE. The squeezed side is stretched, rather than the other
 * shrunk, so no row or column of the picture is lost: a 704×576 still of a
 * 16:9 camera is shown 1018.6×576, not 704×396.
 * @param {Size} picture - the picture's own size in pixels
 * @param {Size|null|undefined} stream - the size of the channel's main stream; unknown when missing
 * @returns {Size|null} null when the picture already has the stream's aspect, or either size is unknown
 * @example
 * displaySize({width: 704, height: 576}, {width: 2688, height: 1520}) // → {width: 1018.6…, height: 576}
 * displaySize({width: 1920, height: 1088}, {width: 2688, height: 1520}) // → null
 */
export function displaySize(picture, stream) {
  if (!stream || !isSize(picture) || !isSize(stream)) return null;
  const aspect = stream.width / stream.height;
  const own = picture.width / picture.height;
  if (Math.abs(own / aspect - 1) <= ASPECT_TOLERANCE) return null;
  return own < aspect
    ? { width: picture.height * aspect, height: picture.height }
    : { width: picture.width, height: picture.width / aspect };
}

/**
 * Whether a size has a width and a height to compute an aspect from: an
 * <img> without a picture has 0×0.
 * @param {Size} size
 * @returns {boolean}
 */
function isSize(size) {
  return size.width > 0 && size.height > 0 && Number.isFinite(size.width) && Number.isFinite(size.height);
}
