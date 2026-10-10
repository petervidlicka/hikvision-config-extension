/**
 * Shapes on the picture as fractions of its size: the same shape on canvases
 * of different sizes, and the pixel checks the drawing tools make.
 */
import { describe, expect, it } from 'vitest';
import {
  hasArea, isSimplePolygon, pixelDistance, pointInPolygon, rectContains, rectFromCorners, rectToPixels, toPixels,
} from '../../extension/lib/shapes.js';

/** Frame sizes the canvas takes on the DS-7604NI: live still, HD still, stored picture. */
const SD = { width: 704, height: 576 };
const HD = { width: 1920, height: 1088 };
const STORED = { width: 1280, height: 720 };

describe('shapes on the picture', () => {
  it('lands on the same part of any canvas', () => {
    const point = { x: 0.25, y: 0.75 };
    expect(toPixels(point, SD)).toEqual({ x: 176, y: 432 });
    expect(toPixels(point, HD)).toEqual({ x: 480, y: 816 });
    expect(toPixels(point, STORED)).toEqual({ x: 320, y: 540 });

    const rect = { x: 0.5, y: 0, w: 0.5, h: 0.25 };
    expect(rectToPixels(rect, SD)).toEqual({ x: 352, y: 0, w: 352, h: 144 });
    expect(rectToPixels(rect, HD)).toEqual({ x: 960, y: 0, w: 960, h: 272 });
  });

  it('measures distances in the canvas’s pixels', () => {
    const a = { x: 0.1, y: 0.1 };
    const b = { x: 0.1 + 3 / 704, y: 0.1 + 4 / 576 };
    expect(pixelDistance(a, b, SD)).toBeCloseTo(5, 9);
    // The same two points are further apart on a canvas with more pixels
    expect(pixelDistance(a, b, HD)).toBeGreaterThan(pixelDistance(a, b, SD));
    expect(pixelDistance(a, a, HD)).toBe(0);
  });

  it('spans a drag whichever way it went', () => {
    const expected = { x: 0.2, y: 0.1, w: 0.4, h: 0.3 };
    for (const [start, end] of [
      [{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.4 }],
      [{ x: 0.6, y: 0.4 }, { x: 0.2, y: 0.1 }],
      [{ x: 0.6, y: 0.1 }, { x: 0.2, y: 0.4 }],
    ]) {
      const rect = rectFromCorners(start, end);
      for (const key of ['x', 'y', 'w', 'h']) expect(rect[key]).toBeCloseTo(expected[key], 12);
    }
  });

  it('finds the rectangle under a point, edges included', () => {
    const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(rectContains(rect, { x: 0.5, y: 0.5 })).toBe(true);
    expect(rectContains(rect, { x: 0.25, y: 0.75 })).toBe(true);
    expect(rectContains(rect, { x: 0.2, y: 0.5 })).toBe(false);
    expect(rectContains(rect, { x: 0.5, y: 0.8 })).toBe(false);
  });

  it('finds the polygon under a point, in fractions as in pixels', () => {
    // A triangle with its point at the top right, and a concave L
    const triangle = [{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }];
    expect(pointInPolygon({ x: 0.8, y: 0.8 }, triangle)).toBe(true);
    expect(pointInPolygon({ x: 0.2, y: 0.2 }, triangle)).toBe(false);
    const ell = [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.7 }, { x: 1, y: 0.7 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect(pointInPolygon({ x: 0.1, y: 0.1 }, ell)).toBe(true);
    expect(pointInPolygon({ x: 0.8, y: 0.85 }, ell)).toBe(true);
    expect(pointInPolygon({ x: 0.8, y: 0.3 }, ell)).toBe(false);

    // Stretching to any canvas doesn't change the answer
    for (const size of [SD, HD, STORED]) {
      const inPixels = ell.map(p => toPixels(p, size));
      expect(pointInPolygon(toPixels({ x: 0.8, y: 0.85 }, size), inPixels)).toBe(true);
      expect(pointInPolygon(toPixels({ x: 0.8, y: 0.3 }, size), inPixels)).toBe(false);
    }
  });

  describe('outlines that meet themselves', () => {
    /** Points from [x, y] pairs */
    const corners = (...pairs) => pairs.map(([x, y]) => ({ x, y }));

    it('accepts simple outlines, convex or not', () => {
      expect(isSimplePolygon(corners([0, 0], [10, 0], [10, 10], [0, 10]))).toBe(true);
      expect(isSimplePolygon(corners([0, 0], [10, 0], [5, 8]))).toBe(true);
      // The DS-7604NI's stored region on channel 1, in device units
      expect(isSimplePolygon(corners([651, 684], [751, 701], [952, 544], [850, 147], [616, 486]))).toBe(true);
      // An L, and a star-like concave outline
      expect(isSimplePolygon(corners([0, 0], [3, 0], [3, 7], [10, 7], [10, 10], [0, 10]))).toBe(true);
      expect(isSimplePolygon(corners([5, 0], [6, 4], [10, 5], [6, 6], [5, 10], [4, 6], [0, 5], [4, 4]))).toBe(true);
    });

    it('accepts edges on one line that don’t meet, which Hikvision’s own check refuses', () => {
      // A U standing on two feet along y = 0
      expect(isSimplePolygon(corners([0, 0], [3, 0], [3, 6], [7, 6], [7, 0], [10, 0], [10, 10], [0, 10]))).toBe(true);
      // A comb whose teeth end on one line
      expect(isSimplePolygon(corners([0, 0], [2, 0], [2, 5], [4, 5], [4, 0], [6, 0], [6, 5], [8, 5], [8, 0], [10, 0], [10, 10], [0, 10])))
        .toBe(true);
    });

    it('refuses edges that cross, including across the closing edge', () => {
      expect(isSimplePolygon(corners([0, 0], [10, 10], [10, 0], [0, 10]))).toBe(false); // bow-tie
      expect(isSimplePolygon(corners([0, 0], [10, 0], [0, 10], [10, 10]))).toBe(false); // the closing edge crosses the second
      expect(isSimplePolygon(corners([0, 0], [10, 0], [10, 10], [2, -5], [0, 10]))).toBe(false);
      // In fractions of the picture, as drawn
      expect(isSimplePolygon(corners([0.1, 0.1], [0.4, 0.4], [0.4, 0.1], [0.1, 0.4]))).toBe(false);
    });

    it('refuses an outline that touches itself or runs back along itself', () => {
      // A corner on another edge
      expect(isSimplePolygon(corners([0, 0], [10, 0], [10, 10], [5, 0], [0, 10]))).toBe(false);
      // Two corners in the same place (a pinch)
      expect(isSimplePolygon(corners([0, 0], [5, 5], [10, 0], [10, 10], [5, 5], [0, 10]))).toBe(false);
      // Edges on one line that overlap
      expect(isSimplePolygon(corners([0, 0], [6, 0], [6, 4], [3, 4], [3, 0], [10, 0], [10, 10], [0, 10]))).toBe(false);
      // A spike folding straight back, and corners all on one line
      expect(isSimplePolygon(corners([0, 0], [10, 0], [10, 10], [10, 5], [0, 10]))).toBe(false);
      expect(isSimplePolygon(corners([0, 0], [5, 0], [10, 0]))).toBe(false);
      expect(isSimplePolygon(corners([0, 0], [4, 0], [10, 0], [7, 0]))).toBe(false);
    });

    it('ignores a corner repeated straight after itself, but needs three distinct corners', () => {
      expect(isSimplePolygon(corners([0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 0]))).toBe(true);
      expect(isSimplePolygon(corners([0, 0], [10, 0], [10, 0]))).toBe(false);
      expect(isSimplePolygon([])).toBe(false);
    });

    it('tells an outline with no area from one whose edges cross', () => {
      // Corners all on one line, or all on one spot: not simple, and no area either
      for (const flat of [corners([0, 0], [5, 0], [10, 0]), corners([0, 0], [4, 4], [10, 10], [7, 7]),
        corners([0, 0], [0, 0], [0, 0], [0, 0]), corners([3, 3]), []]) {
        expect([isSimplePolygon(flat), hasArea(flat)]).toEqual([false, false]);
      }
      // A bow-tie, even one whose halves cancel out, and a spike on a square have an area
      expect(hasArea(corners([0, 0], [10, 10], [10, 0], [0, 10]))).toBe(true);
      expect(hasArea(corners([0, 0], [10, 0], [10, 10], [10, 5], [0, 10]))).toBe(true);
      expect(hasArea(corners([0, 0], [0, 0], [10, 0], [10, 0], [5, 1]))).toBe(true);
    });

    it('gives the same answer in any units', () => {
      const bowTie = corners([0.1, 0.1], [0.4, 0.4], [0.4, 0.1], [0.1, 0.4]);
      const ell = corners([0, 0], [0.3, 0], [0.3, 0.7], [1, 0.7], [1, 1], [0, 1]);
      for (const size of [SD, HD, STORED]) {
        expect(isSimplePolygon(bowTie.map(p => toPixels(p, size)))).toBe(false);
        expect(isSimplePolygon(ell.map(p => toPixels(p, size)))).toBe(true);
      }
    });
  });
});
