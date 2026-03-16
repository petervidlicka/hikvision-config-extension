/**
 * Service worker for the Hikvision Config Tool Chrome extension.
 *
 * Handles all NVR communication (Digest auth + ISAPI) so the UI page
 * never needs to worry about authentication or CORS.
 */

importScripts('lib/digest-auth.js');

/* ── XML helpers (pure-JS, no DOMParser needed for service worker) ──────── */

/**
 * Lightweight XML-to-object parser that works in service workers
 * (where DOMParser is unavailable). Handles the simple XML structures
 * returned by Hikvision ISAPI endpoints.
 */
function xmlToObj(xmlStr) {
  // Strip XML declaration and processing instructions
  xmlStr = xmlStr.replace(/<\?[^?]*\?>/g, '').trim();

  function parseNode(str) {
    const obj = {};
    // Match opening tags with content: <TagName ...>content</TagName>
    // or self-closing: <TagName ... />
    const tagRe = /<([a-zA-Z][\w.-]*)(?:\s[^>]*)?\s*\/>/g;
    const pairRe = /<([a-zA-Z][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let hasChildren = false;
    let match;

    // Self-closing tags → empty string value
    while ((match = tagRe.exec(str)) !== null) {
      hasChildren = true;
      const key = match[1];
      addToObj(obj, key, '');
    }

    // Paired tags
    // We need a smarter approach for nested same-name tags:
    // Walk through the string finding top-level tags only
    const topTags = findTopLevelTags(str);
    for (const tag of topTags) {
      hasChildren = true;
      const inner = tag.content;
      // Check if inner content has child elements
      const hasChildElements = /<[a-zA-Z][\w.-]*[\s>]/.test(inner);
      const value = hasChildElements ? parseNode(inner) : inner.trim();
      addToObj(obj, tag.name, value);
    }

    if (!hasChildren) {
      return str.trim();
    }
    return obj;
  }

  /**
   * Find top-level XML element tags in a string (not nested ones).
   */
  function findTopLevelTags(str) {
    const results = [];
    let i = 0;
    while (i < str.length) {
      // Find next '<'
      const openBracket = str.indexOf('<', i);
      if (openBracket === -1) break;

      // Skip comments, CDATA, processing instructions
      if (str.startsWith('<!--', openBracket)) {
        i = str.indexOf('-->', openBracket);
        if (i === -1) break;
        i += 3;
        continue;
      }
      if (str.startsWith('<![CDATA[', openBracket)) {
        i = str.indexOf(']]>', openBracket);
        if (i === -1) break;
        i += 3;
        continue;
      }

      // Skip closing tags at this level (shouldn't happen in well-formed input)
      if (str[openBracket + 1] === '/') {
        i = str.indexOf('>', openBracket) + 1;
        continue;
      }

      // Find the tag name
      const nameMatch = str.slice(openBracket).match(/^<([a-zA-Z][\w.-]*)/);
      if (!nameMatch) {
        i = openBracket + 1;
        continue;
      }
      const tagName = nameMatch[1];

      // Check for self-closing
      const closeBracket = str.indexOf('>', openBracket);
      if (closeBracket === -1) break;

      if (str[closeBracket - 1] === '/') {
        // Self-closing tag
        results.push({ name: tagName, content: '' });
        i = closeBracket + 1;
        continue;
      }

      // Find the matching closing tag, accounting for nesting
      let depth = 1;
      let searchPos = closeBracket + 1;
      const openRe = new RegExp(`<${tagName}[\\s>/]`, 'g');
      const closeRe = new RegExp(`</${tagName}>`, 'g');

      let contentEnd = -1;
      while (depth > 0 && searchPos < str.length) {
        openRe.lastIndex = searchPos;
        closeRe.lastIndex = searchPos;
        const nextOpen = openRe.exec(str);
        const nextClose = closeRe.exec(str);

        if (!nextClose) {
          // Malformed XML, skip
          depth = 0;
          contentEnd = -1;
          break;
        }

        if (nextOpen && nextOpen.index < nextClose.index) {
          // Check it's not inside a comment or self-closing
          const beforeClose = str.lastIndexOf('>', nextOpen.index);
          depth++;
          searchPos = nextOpen.index + tagName.length + 1;
        } else {
          depth--;
          if (depth === 0) {
            contentEnd = nextClose.index;
            i = nextClose.index + tagName.length + 3; // skip </tagName>
          } else {
            searchPos = nextClose.index + tagName.length + 3;
          }
        }
      }

      if (contentEnd === -1) {
        i = closeBracket + 1;
        continue;
      }

      const content = str.slice(closeBracket + 1, contentEnd);
      results.push({ name: tagName, content });
    }
    return results;
  }

  function addToObj(obj, key, value) {
    if (obj[key] !== undefined) {
      if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
      obj[key].push(value);
    } else {
      obj[key] = value;
    }
  }

  // Strip the root element wrapper and parse its contents
  const rootMatch = xmlStr.match(/^<([a-zA-Z][\w.-]*)(?:\s[^>]*)?>/) ;
  if (!rootMatch) return {};
  const rootName = rootMatch[1];
  const rootCloseIdx = xmlStr.lastIndexOf(`</${rootName}>`);
  if (rootCloseIdx === -1) return {};
  const innerXml = xmlStr.slice(xmlStr.indexOf('>', 0) + 1, rootCloseIdx);
  return parseNode(innerXml);
}

/**
 * Return the local name of the XML root element.
 */
function xmlRootName(xmlStr) {
  const m = xmlStr.match(/<([a-zA-Z][\w.-]*)/);
  return m ? m[1] : '';
}

/* ── Message handler (replaces Express routes) ──────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    sendResponse({ success: false, error: err.message || String(err) });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'testConnection': return testConnection(msg.config);
    case 'getChannels':    return getChannels(msg.config);
    case 'getSnapshot':    return getSnapshot(msg.config, msg.channelId);
    case 'getMotionDetection':  return getMotionDetection(msg.config, msg.channelId);
    case 'putMotionDetection':  return putMotionDetection(msg.config, msg.channelId, msg.xml);
    case 'getPrivacyMask':      return getPrivacyMask(msg.config, msg.channelId);
    case 'putPrivacyMask':      return putPrivacyMask(msg.config, msg.channelId, msg.xml);
    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

/* ── ISAPI handlers ─────────────────────────────────────────────────────── */

async function testConnection(config) {
  const resp = await digestFetch(config, 'GET', '/ISAPI/System/deviceInfo');
  const device = xmlToObj(resp.data);
  return { success: true, device };
}

async function getChannels(config) {
  // Try multiple endpoints — firmware versions vary on which ones are accessible
  const endpoints = [
    { path: '/ISAPI/System/Video/inputs/channels', key: 'VideoInputChannel' },
    { path: '/ISAPI/ContentMgmt/InputProxy/channels', key: 'InputProxyChannel' },
    { path: '/ISAPI/Streaming/channels', key: 'StreamingChannel' },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await digestFetch(config, 'GET', ep.path);
      const parsed = xmlToObj(resp.data);
      let channels = parsed[ep.key];
      if (!channels) channels = [];
      if (!Array.isArray(channels)) channels = [channels];

      // StreamingChannel has both main/sub per camera — deduplicate to unique input channels
      if (ep.key === 'StreamingChannel') {
        const seen = new Set();
        channels = channels.filter(ch => {
          // Channel IDs: 101/102 = cam 1 main/sub, 201/202 = cam 2, etc.
          const inputId = ch.id ? String(Math.floor(parseInt(ch.id) / 100)) : ch.id;
          if (seen.has(inputId)) return false;
          seen.add(inputId);
          ch.id = inputId;
          ch.name = ch.channelName || `Channel ${inputId}`;
          return true;
        });
      }

      if (channels.length > 0) {
        return { success: true, channels };
      }
    } catch {
      // Try next endpoint
    }
  }

  // Last resort: probe for channels by attempting snapshots on IDs 1-4
  // (DS-7604 has 4 channels)
  const probed = [];
  for (let id = 1; id <= 4; id++) {
    try {
      await digestFetch(config, 'GET', `/ISAPI/Streaming/channels/${id}01/picture`);
      probed.push({ id: String(id), name: `Channel ${id}` });
    } catch {
      // Channel doesn't exist or no camera connected
    }
  }

  if (probed.length > 0) {
    return { success: true, channels: probed };
  }

  throw new Error('Could not discover channels. Check that cameras are connected to the NVR.');
}

async function getSnapshot(config, channelId) {
  const streamId = `${channelId}01`;
  try {
    const resp = await digestFetch(config, 'GET', `/ISAPI/Streaming/channels/${streamId}/picture`);
    // Convert ArrayBuffer to base64 data URL for transfer over messaging
    const bytes = new Uint8Array(resp.data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    return { success: true, dataUrl: `data:image/jpeg;base64,${base64}` };
  } catch {
    // Fallback URL format
    const resp = await digestFetch(config, 'GET', `/ISAPI/Streaming/channels/${channelId}/picture`);
    const bytes = new Uint8Array(resp.data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    return { success: true, dataUrl: `data:image/jpeg;base64,${base64}` };
  }
}

async function getMotionDetection(config, channelId) {
  const resp = await digestFetch(config, 'GET', `/ISAPI/System/Video/inputs/channels/${channelId}/motionDetection`);
  const motionDetection = xmlToObj(resp.data);
  return { success: true, motionDetection, rawXml: resp.data };
}

async function putMotionDetection(config, channelId, xml) {
  const resp = await digestFetch(config, 'PUT', `/ISAPI/System/Video/inputs/channels/${channelId}/motionDetection`, xml);
  return { success: true, response: resp.data };
}

async function getPrivacyMask(config, channelId) {
  try {
    const resp = await digestFetch(config, 'GET', `/ISAPI/System/Video/inputs/channels/${channelId}/privacyMask`);
    const parsed = xmlToObj(resp.data);
    const root = xmlRootName(resp.data);
    const privacyMask = root === 'PrivacyMask' ? parsed : (parsed.PrivacyMask || parsed.privacyMask || parsed);
    return { success: true, privacyMask, rawXml: resp.data };
  } catch {
    // Try alternative endpoint
    const resp = await digestFetch(config, 'GET', `/ISAPI/System/Video/inputs/channels/${channelId}/privacyMask/regions`);
    const parsed = xmlToObj(resp.data);
    return { success: true, privacyMask: parsed, rawXml: resp.data };
  }
}

async function putPrivacyMask(config, channelId, xml) {
  const resp = await digestFetch(config, 'PUT', `/ISAPI/System/Video/inputs/channels/${channelId}/privacyMask`, xml);
  return { success: true, response: resp.data };
}
