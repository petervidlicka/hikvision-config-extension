/**
 * Picture sizes without a device: reading a JPEG's size from its header, and
 * the size an NVR's squeezed still is shown at to have its camera's aspect.
 */
import { describe, expect, it } from 'vitest';
import { ASPECT_TOLERANCE, displaySize, jpegSize, sameSize } from '../../extension/lib/picture-size.js';

/**
 * The start of a 704×576 snapshot from the DS-7604NI (/ISAPI/Streaming/channels/101/picture),
 * up to and including its frame header: SOI, two quantization tables, SOF0.
 */
const DS7604_STILL_HEADER = Uint8Array.from(Buffer.from(
  '/9j/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8' +
  'fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAJAAsADASIAAhEBAxEB', 'base64'));

/**
 * A JPEG start with a frame header of the given size, after some other segments.
 * @param {number} width
 * @param {number} height
 * @param {{marker?: number, before?: number[]}} [options] - the frame header's marker (SOF0 by
 *   default), and bytes to put between the SOI and it
 */
const jpegStart = (width, height, { marker = 0xc0, before = [] } = {}) => new Uint8Array([
  0xff, 0xd8, ...before,
  0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
]);
/** A JFIF APP0 segment (16 bytes with its marker). */
const APP0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];

describe('jpegSize', () => {
  it('reads the size of the DS-7604NI’s still from its frame header', () => {
    expect(DS7604_STILL_HEADER.length).toBe(159);
    expect(jpegSize(DS7604_STILL_HEADER)).toEqual({ width: 704, height: 576 });
  });

  it('skips other segments, fill bytes and standalone markers, and reads progressive JPEGs', () => {
    expect(jpegSize(jpegStart(1920, 1088, { before: APP0 }))).toEqual({ width: 1920, height: 1088 });
    expect(jpegSize(jpegStart(1280, 720, { before: [0xff, 0xff, 0xff, 0xd0] }))).toEqual({ width: 1280, height: 720 });
    expect(jpegSize(jpegStart(2688, 1520, { marker: 0xc2 }))).toEqual({ width: 2688, height: 1520 });
  });

  it('doesn’t take a Huffman table for a frame header', () => {
    const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
    expect(jpegSize(jpegStart(640, 360, { before: dht }))).toEqual({ width: 640, height: 360 });
  });

  it('gives no size for something other than a JPEG, or bytes that end before the frame header', () => {
    expect(jpegSize(new TextEncoder().encode('<?xml version="1.0"?><ResponseStatus/>'))).toBeNull();
    expect(jpegSize(DS7604_STILL_HEADER.subarray(0, 145))).toBeNull(); // the frame header starts at byte 140
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull(); // scan data, no frame header
    expect(jpegSize(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(jpegSize(jpegStart(0, 576))).toBeNull();
  });
});

describe('sameSize', () => {
  it('compares widths and heights, and an unknown size is never the same', () => {
    expect(sameSize({ width: 704, height: 576 }, { width: 704, height: 576 })).toBe(true);
    expect(sameSize({ width: 704, height: 576 }, { width: 640, height: 360 })).toBe(false);
    expect(sameSize(null, { width: 704, height: 576 })).toBe(false);
    expect(sameSize(null, null)).toBe(false);
  });
});

describe('displaySize', () => {
  const mainStream = { width: 2688, height: 1520 };

  it('stretches an NVR’s squeezed 704×576 still back to its camera’s 16:9, keeping every row', () => {
    const size = displaySize({ width: 704, height: 576 }, mainStream);
    expect(size?.height).toBe(576);
    expect(size?.width).toBeCloseTo(576 * 2688 / 1520, 6);
  });

  it('makes a picture too wide for its stream taller, keeping every column', () => {
    expect(displaySize({ width: 1920, height: 1080 }, { width: 1600, height: 1200 })).toEqual({ width: 1920, height: 1440 });
  });

  it('leaves a picture that has its stream’s aspect, give or take rounding, as it is', () => {
    expect(displaySize({ width: 1920, height: 1088 }, mainStream)).toBeNull(); // the NVR's full-size still
    expect(displaySize({ width: 1280, height: 720 }, mainStream)).toBeNull(); // a stored picture
    expect(displaySize({ width: 2688, height: 1520 }, mainStream)).toBeNull(); // a camera's own
    const justOff = (1 + ASPECT_TOLERANCE + 0.001) * 2688 / 1520;
    expect(displaySize({ width: Math.round(1000 * justOff), height: 1000 }, mainStream)).not.toBeNull();
  });

  it('leaves the picture as it is when either size is unknown', () => {
    expect(displaySize({ width: 704, height: 576 }, undefined)).toBeNull();
    expect(displaySize({ width: 704, height: 576 }, null)).toBeNull();
    expect(displaySize({ width: 0, height: 0 }, mainStream)).toBeNull(); // an <img> without a picture
    expect(displaySize({ width: 704, height: 576 }, { width: 0, height: 1520 })).toBeNull();
  });
});
