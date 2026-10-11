/**
 * XML helpers for Hikvision ISAPI documents.
 *
 * Config is edited in place on the document the device returned, so fields
 * this extension doesn't know about survive a save untouched. Lookups match
 * on local name because the namespace varies by document, and within one:
 * most use http://www.hikvision.com/ver20/XMLSchema, motion and privacy-mask
 * documents use http://www.isapi.org/ver20/XMLSchema, list items can
 * redeclare the other one, some answers have none, and some firmware mixes in
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
  const doc = parseXmlOrNull(text);
  if (!doc) throw new Error('Device returned malformed XML');
  return doc;
}

/**
 * Parse an ISAPI response the caller can do without, e.g. an optional
 * capabilities document: a body that isn't XML gives null, not an error.
 * @param {string} text
 * @returns {XMLDocument|null}
 */
export function parseXmlOrNull(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length > 0 ? null : doc;
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

/**
 * Deep copy of a document, so edits can be discarded if a save fails.
 * @param {XMLDocument} doc
 * @returns {XMLDocument}
 */
export function cloneXml(doc) {
  return /** @type {XMLDocument} */ (doc.cloneNode(true));
}

/**
 * Direct children of `el` with the given local name.
 * @param {Element|null|undefined} el
 * @param {string} name
 * @returns {Element[]}
 */
export function childElements(el, name) {
  return el ? Array.from(el.children).filter(c => c.localName === name) : [];
}

/**
 * First direct child of `el` with the given local name, or null.
 * @param {Element|null|undefined} el
 * @param {string} name
 * @returns {Element|null}
 */
export function childElement(el, name) {
  return childElements(el, name)[0] ?? null;
}

/**
 * Walk down a chain of child names.
 * @param {Element|null|undefined} el
 * @param {...string} names
 * @returns {Element|null}
 * @example xmlPath(root, 'MotionDetectionLayout', 'layout', 'RegionList')
 */
export function xmlPath(el, ...names) {
  let current = el ?? null;
  for (const name of names) {
    current = childElement(current, name);
    if (!current) return null;
  }
  return current;
}

/**
 * First descendant (any depth) with the given local name, or null.
 * @param {Element|null|undefined} el
 * @param {string} name
 * @returns {Element|null}
 */
export function findDescendant(el, name) {
  return el?.getElementsByTagNameNS('*', name)[0] ?? null;
}

/**
 * Trimmed text of a direct child, or null when the child is missing.
 * @param {Element|null|undefined} el
 * @param {string} name
 * @returns {string|null}
 */
export function childText(el, name) {
  const child = childElement(el, name);
  return child ? (child.textContent ?? '').trim() : null;
}

/**
 * Set the text of an existing child. Returns false when the device didn't
 * send that field — we don't invent fields the firmware may not support.
 * @param {Element|null|undefined} el
 * @param {string} name
 * @param {string|number|boolean} value
 * @returns {boolean}
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
 * @param {Element} parent
 * @param {string} name
 * @param {string|number|boolean} [text]
 * @param {string|null} [namespace]
 * @returns {Element}
 */
export function appendElement(parent, name, text, namespace = parent.namespaceURI) {
  const el = parent.ownerDocument.createElementNS(namespace, name);
  if (text !== undefined) el.textContent = String(text);
  parent.appendChild(el);
  return el;
}
