/**
 * XML helpers for Hikvision ISAPI documents.
 *
 * Config is edited in place on the document the device returned, so fields
 * this extension doesn't know about survive a save untouched. Lookups match
 * on local name because ISAPI documents use a default namespace
 * (http://www.hikvision.com/ver20/XMLSchema) and some firmware mixes in
 * elements with an empty namespace.
 */

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * Parse an ISAPI response.
 * @param {string} text
 * @returns {XMLDocument}
 * @throws {Error} when the device returned something that isn't XML
 */
export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Device returned malformed XML');
  }
  return doc;
}

/**
 * Serialize a document for a PUT in the style Hikvision firmware emits: an
 * XML declaration on its own line, and empty elements as `<a></a>` rather
 * than `<a/>`, so the output matches what the device and its own client send.
 * @param {XMLDocument} doc
 * @returns {string}
 */
export function serializeXml(doc) {
  const body = new XMLSerializer()
    .serializeToString(doc)
    .replace(/^<\?xml[^>]*\?>\s*/, '')
    .replace(/<([A-Za-z_][\w.:-]*)((?:\s+[^\s=>]+="[^"]*")*)\s*\/>/g, '<$1$2></$1>');
  return `${XML_DECLARATION}\n${body}`;
}

/** Direct children of `el` with the given local name. */
export function childElements(el, name) {
  return el ? Array.from(el.children).filter(c => c.localName === name) : [];
}

/** First direct child of `el` with the given local name, or null. */
export function childElement(el, name) {
  return childElements(el, name)[0] ?? null;
}

/**
 * Walk down a chain of child names.
 * @example xmlPath(root, 'MotionDetectionLayout', 'layout', 'RegionList')
 */
export function xmlPath(el, ...names) {
  for (const name of names) {
    el = childElement(el, name);
    if (!el) return null;
  }
  return el;
}

/** First descendant (any depth) with the given local name, or null. */
export function findDescendant(el, name) {
  return el?.getElementsByTagNameNS('*', name)[0] ?? null;
}

/** Trimmed text of a direct child, or null when the child is missing. */
export function childText(el, name) {
  const child = childElement(el, name);
  return child ? child.textContent.trim() : null;
}

/**
 * Set the text of an existing child. Returns false when the device didn't
 * send that field — we don't invent fields the firmware may not support.
 */
export function setChildText(el, name, value) {
  const child = childElement(el, name);
  if (!child) return false;
  child.textContent = String(value);
  return true;
}

/**
 * Append a new child element. Defaults to the parent's namespace so it
 * serializes without an xmlns attribute; pass `null` for an empty namespace.
 */
export function appendElement(parent, name, text, namespace = parent.namespaceURI) {
  const el = parent.ownerDocument.createElementNS(namespace, name);
  if (text !== undefined) el.textContent = String(text);
  parent.appendChild(el);
  return el;
}
