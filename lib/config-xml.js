/**
 * Read and edit the ISAPI config documents behind each tool.
 *
 * Every apply* function edits the document the device returned and changes
 * only the fields the UI controls. Anything else — firmware-specific fields,
 * notification methods we don't expose, disabled mask slots — is sent back
 * exactly as received. Coordinates here are raw device units; mapping to
 * canvas pixels is the UI's job.
 *
 * Depends on lib/xml.js.
 */

/* ── Motion detection ───────────────────────────────────────────────────── */

/**
 * @typedef {{x: number, y: number}} DevicePoint
 * @typedef {object} MotionConfig
 * @property {boolean} enabled
 * @property {number|null} sensitivity
 * @property {boolean} dynamicAnalysis
 * @property {boolean} detectHuman
 * @property {boolean} detectVehicle
 * @property {DevicePoint[][]} regions - polygons, device coordinates
 */

/** Read the RegionCoordinates points under an element. */
function readCoordinates(el) {
  return childElements(childElement(el, 'RegionCoordinatesList'), 'RegionCoordinates').map(c => ({
    x: parseInt(childText(c, 'positionX'), 10) || 0,
    y: parseInt(childText(c, 'positionY'), 10) || 0,
  }));
}

/**
 * Read a MotionDetection document.
 * @param {XMLDocument} doc
 * @returns {MotionConfig}
 */
function readMotionConfig(doc) {
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');
  const sensitivity = parseInt(childText(layout, 'sensitivityLevel'), 10);

  // Firmware stores the detection target either as TargetDetection blocks
  // (top level or under the layout) or as a layout <targetType>, e.g. "human"
  const targets = {};
  for (const parent of [root, layout]) {
    for (const t of childElements(childElement(parent, 'TargetDetection'), 'detectionTarget')) {
      targets[childText(t, 'targetType')] = childText(t, 'enabled') === 'true';
    }
  }
  for (const type of (childText(layout, 'targetType') || '').split(',')) {
    if (type.trim()) targets[type.trim()] = true;
  }

  return {
    enabled: childText(root, 'enabled') === 'true',
    sensitivity: Number.isNaN(sensitivity) ? null : sensitivity,
    dynamicAnalysis: findDescendant(root, 'enableDynamicAnalysis')?.textContent.trim() === 'true',
    detectHuman: targets.human ?? false,
    detectVehicle: targets.vehicle ?? false,
    regions: childElements(xmlPath(layout, 'layout', 'RegionList'), 'Region')
      .map(readCoordinates)
      .filter(points => points.length >= 3),
  };
}

/**
 * Write motion settings into the device's MotionDetection document.
 *
 * Matches what Hikvision's own client sends: regionType switched to
 * "region" (the device ignores RegionList in grid mode), gridMap zeroed, and
 * each <Region> in an empty namespace (`<Region xmlns="">`).
 *
 * @param {XMLDocument} doc - edited in place
 * @param {{enabled: boolean, sensitivity: number, dynamicAnalysis: boolean, regions: DevicePoint[][]}} config
 */
function applyMotionConfig(doc, config) {
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');

  setChildText(root, 'enabled', config.enabled);
  if (!setChildText(layout, 'sensitivityLevel', config.sensitivity)) {
    const sens = findDescendant(root, 'sensitivityLevel');
    if (sens) sens.textContent = String(config.sensitivity);
  }

  const regionType = findDescendant(root, 'regionType');
  if (regionType) regionType.textContent = 'region';

  const gridMap = findDescendant(root, 'gridMap');
  if (gridMap) gridMap.textContent = '0'.repeat(gridMap.textContent.length);

  // Only touch the field if this firmware has it
  const dynamic = findDescendant(root, 'enableDynamicAnalysis');
  if (dynamic) dynamic.textContent = String(config.dynamicAnalysis);

  let regionList = findDescendant(root, 'RegionList');
  if (!regionList) {
    const layoutInner = childElement(layout, 'layout');
    if (!layoutInner) {
      throw new Error('This device did not return a motion region layout, so regions cannot be saved');
    }
    regionList = appendElement(layoutInner, 'RegionList');
  }
  regionList.replaceChildren();
  regionList.setAttribute('size', String(config.regions.length));

  config.regions.forEach((points, i) => {
    const region = appendElement(regionList, 'Region', undefined, null);
    appendElement(region, 'id', i + 1, null);
    const coordList = appendElement(region, 'RegionCoordinatesList', undefined, null);
    for (const p of points) {
      const coord = appendElement(coordList, 'RegionCoordinates', undefined, null);
      appendElement(coord, 'positionX', Math.round(p.x), null);
      appendElement(coord, 'positionY', Math.round(p.y), null);
    }
  });
}

/* ── Privacy mask ───────────────────────────────────────────────────────── */

/** The region list, whether the document is a PrivacyMask or the bare list. */
function privacyRegionList(doc) {
  const root = doc.documentElement;
  return root.localName === 'PrivacyMaskRegionList' ? root : childElement(root, 'PrivacyMaskRegionList');
}

/**
 * Read a PrivacyMask (or PrivacyMaskRegionList) document. Only enabled
 * regions are returned; disabled slots stay in the document for the save.
 * `screen` is the coordinate space the device declares, when it does.
 * @param {XMLDocument} doc
 * @returns {{enabled: boolean, screen: {width: number, height: number}|null, regions: DevicePoint[][]}}
 */
function readPrivacyMask(doc) {
  const root = doc.documentElement;
  const size = childElement(root, 'normalizedScreenSize');
  const width = parseInt(childText(size, 'normalizedScreenWidth'), 10);
  const height = parseInt(childText(size, 'normalizedScreenHeight'), 10);
  return {
    enabled: childText(root, 'enabled') === 'true',
    screen: width > 0 && height > 0 ? { width, height } : null,
    regions: childElements(privacyRegionList(doc), 'PrivacyMaskRegion')
      .filter(r => childText(r, 'enabled') === 'true')
      .map(readCoordinates)
      .filter(points => points.length >= 2),
  };
}

/** Replace a region's coordinates with the four corners of a rectangle. */
function writeRectangle(regionEl, rect) {
  let list = childElement(regionEl, 'RegionCoordinatesList');
  if (!list) list = appendElement(regionEl, 'RegionCoordinatesList');
  list.replaceChildren();
  const corners = [[rect.x1, rect.y1], [rect.x2, rect.y1], [rect.x2, rect.y2], [rect.x1, rect.y2]];
  for (const [x, y] of corners) {
    const coord = appendElement(list, 'RegionCoordinates');
    appendElement(coord, 'positionX', Math.round(x));
    appendElement(coord, 'positionY', Math.round(y));
  }
}

/**
 * Write privacy mask rectangles into the device's document. Rectangles fill
 * the device's existing region slots in order; leftover slots are disabled
 * rather than deleted, and new slots are added only when needed.
 *
 * @param {XMLDocument} doc - edited in place
 * @param {{enabled: boolean, rects: {x1: number, y1: number, x2: number, y2: number}[]}} config
 */
function applyPrivacyMask(doc, config) {
  const root = doc.documentElement;
  setChildText(root, 'enabled', config.enabled);

  let list = privacyRegionList(doc);
  if (!list) list = appendElement(root, 'PrivacyMaskRegionList');
  const slots = childElements(list, 'PrivacyMaskRegion');

  config.rects.forEach((rect, i) => {
    let region = slots[i];
    if (!region) {
      region = appendElement(list, 'PrivacyMaskRegion');
      appendElement(region, 'id', i + 1);
      appendElement(region, 'enabled', 'true');
    }
    setChildText(region, 'enabled', true);
    writeRectangle(region, rect);
  });

  for (const unused of slots.slice(config.rects.length)) {
    setChildText(unused, 'enabled', false);
  }
}

/* ── Event trigger notifications ────────────────────────────────────────── */

/** The <EventTriggerNotification> elements of a trigger. */
function triggerNotifications(doc) {
  return childElements(
    childElement(doc.documentElement, 'EventTriggerNotificationList'),
    'EventTriggerNotification');
}

/**
 * Notification methods ("record", "center", "email", ...) enabled on a trigger.
 * @param {XMLDocument} doc
 * @returns {Set<string>}
 */
function readNotificationMethods(doc) {
  return new Set(triggerNotifications(doc).map(n => childText(n, 'notificationMethod')));
}

/**
 * Turn the given notification methods on or off on an EventTrigger document.
 * Methods not listed in `managed` (FTP, extra alarm outputs, ...) are left
 * as they are, and existing entries keep their settings (which channel to
 * record, which output port to trigger). New entries follow the device's
 * conventions: NVRs address channels with dyn* fields and ids like "record-1".
 *
 * @param {XMLDocument} doc - edited in place
 * @param {object} options
 * @param {string[]} options.managed - methods the UI controls
 * @param {Set<string>} options.enabled - which of those should be on
 * @param {string} options.channelId - for new "record" entries
 */
function applyNotificationMethods(doc, { managed, enabled, channelId }) {
  const root = doc.documentElement;
  // Address the channel the same way(s) the trigger itself does
  const channelFields = [
    childElement(root, 'videoInputChannelID') && 'videoInputID',
    childElement(root, 'dynVideoInputChannelID') && 'dynVideoInputID',
  ].filter(Boolean);
  if (channelFields.length === 0) channelFields.push('videoInputID');
  let list = childElement(root, 'EventTriggerNotificationList');
  if (!list) list = appendElement(root, 'EventTriggerNotificationList');

  for (const method of managed) {
    const existing = triggerNotifications(doc).filter(n => childText(n, 'notificationMethod') === method);

    if (!enabled.has(method)) {
      existing.forEach(n => n.remove());
      continue;
    }
    if (existing.length > 0) continue;

    const n = appendElement(list, 'EventTriggerNotification');
    if (method === 'record') {
      appendElement(n, 'id', `record-${channelId}`);
      appendElement(n, 'notificationMethod', method);
      appendElement(n, 'notificationRecurrence', 'beginning');
      channelFields.forEach(field => appendElement(n, field, channelId));
    } else if (method === 'IO') {
      appendElement(n, 'id', 'IO-1');
      appendElement(n, 'notificationMethod', method);
      appendElement(n, 'outputIOPortID', 1);
    } else {
      appendElement(n, 'id', method);
      appendElement(n, 'notificationMethod', method);
    }
  }
}
