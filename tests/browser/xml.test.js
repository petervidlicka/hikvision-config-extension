/**
 * XML helpers, in a real browser so DOMParser/XMLSerializer behave exactly
 * as they will in the extension.
 */
import { describe, expect, it } from 'vitest';
import { childText, findDescendant, parseXml, serializeXml, xmlPath } from '../../extension/lib/xml.js';

describe('xml helpers', () => {
  it('serializes with the declaration and empty elements as pairs', () => {
    const doc = parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<A xmlns="urn:x"><b xmlns=""></b><c/></A>');
    expect(serializeXml(doc)).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<A xmlns="urn:x"><b xmlns=""></b><c></c></A>');
  });

  it('rejects malformed XML', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/malformed/);
  });

  it('looks up elements regardless of namespace', () => {
    const root = parseXml('<A xmlns="urn:x"><B><c xmlns="">1</c></B></A>').documentElement;
    expect(childText(xmlPath(root, 'B'), 'c')).toBe('1');
    expect(findDescendant(root, 'c').textContent).toBe('1');
  });
});
