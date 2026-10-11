/**
 * Asking a device about itself without logging in: whether it asks for a
 * Digest login the way Hikvision's ISAPI does, and whether it says it is a
 * Hikvision device and has been activated (GET /SDK/activateStatus, which
 * Hikvision's web UI asks before it shows its login page).
 *
 * A Digest challenge alone is a weak fingerprint: the DS-7604NI answers 401
 * Digest for any /ISAPI path, even one that doesn't exist, and so do routers,
 * NAS boxes and other brands' cameras that protect every page. Its realm is
 * an opaque id, not a model. /SDK/activateStatus is what tells them apart.
 *
 * These requests never carry credentials (not even ones the browser
 * remembers), so they can't count as failed logins, and each is bounded by
 * its own time limit, since most addresses a scan tries have nothing on them.
 * Bodies are parsed as plain text, so this also runs in the Node tests.
 *
 * Depends on lib/digest-auth.js (buildBaseUrl).
 */

import { buildBaseUrl } from './digest-auth.js';

/** Answered without a login by Hikvision devices, activated or not. */
export const ACTIVATE_STATUS_PATH = '/SDK/activateStatus';

/** What the Digest probe asks for; every /ISAPI path is behind the login. */
const DIGEST_PROBE_PATH = '/ISAPI/System/deviceInfo';

/**
 * Why logging in to a device that hasn't been activated fails, in words the
 * user can act on: until it is, it has no admin password, so none works.
 */
export const NOT_ACTIVATED_MESSAGE = 'This device hasn’t been activated yet — activate it with Hikvision SADP or its ' +
  'web page first, then connect with the admin password you set there';

/**
 * Where to reach a device.
 * @typedef {object} DeviceAddress
 * @property {string} host - IPv4 address or hostname
 * @property {number|string} [port] - HTTP port, 80 when left out
 */

/**
 * How long one request may take, and what cancels it.
 * @typedef {object} ProbeOptions
 * @property {number} timeoutMs - limit for the request, reading the answer included
 * @property {AbortSignal} [signal] - cancels it, e.g. when the user cancels a scan
 */

/**
 * What a device says at /SDK/activateStatus.
 * @typedef {object} ActivateStatus
 * @property {boolean|null} activated - false: nobody can log in until the device is activated
 *   (Hikvision SADP or its web page sets the admin password); null when the answer doesn't say
 */

/**
 * Read an /SDK/activateStatus answer: `<Activated>` true or false (in any
 * letter case), anything else unknown. Hikvision's web UI takes anything but
 * "true" as not activated; here unknown stays unknown, so a device is never
 * called not activated on a guess. Elements are matched by local name, so
 * any namespace or prefix works.
 * @param {string} text - response body
 * @returns {ActivateStatus|null} null unless the root element is ActivateStatus
 * @example
 * parseActivateStatus('<ActivateStatus xmlns="http://www.hikvision.com/ver20/XMLSchema"><Activated>false</Activated></ActivateStatus>')
 * // → {activated: false}
 */
export function parseActivateStatus(text) {
  const body = String(text ?? '').trim();
  if (!ACTIVATE_STATUS_ROOT.test(body)) return null;
  const flag = ACTIVATED_FIELD.exec(body)?.[1].trim().toLowerCase();
  return { activated: flag === 'true' ? true : flag === 'false' ? false : null };
}

/**
 * Whether something at this address answers an ISAPI request the way a
 * Hikvision device does without a login: 401 with a Digest challenge. A
 * candidate only; see checkActivation for telling a Hikvision apart.
 * @param {DeviceAddress} address
 * @param {ProbeOptions} options
 * @returns {Promise<boolean>} false also when nothing answered in time
 */
export async function asksForDigestLogin(address, options) {
  const answer = await getWithoutLogin(`${buildBaseUrl(address)}${DIGEST_PROBE_PATH}`, options, false);
  return answer?.status === 401 && /digest/i.test(answer.headers.get('www-authenticate') ?? '');
}

/**
 * Ask a device, without logging in, whether it is a Hikvision and has been
 * activated. Firmware without the endpoint, another brand's device, and no
 * answer in time all give null, so a caller must treat null as "don't know",
 * never as "not a Hikvision".
 * @param {DeviceAddress} address
 * @param {ProbeOptions} options
 * @returns {Promise<ActivateStatus|null>}
 * @example
 * await checkActivation({ host: '192.168.0.108', port: 80 }, { timeoutMs: 1200 });
 * // → {activated: true} from the DS-7604NI; null from firmware without the endpoint
 */
export async function checkActivation(address, options) {
  const answer = await getWithoutLogin(`${buildBaseUrl(address)}${ACTIVATE_STATUS_PATH}`, options, true);
  return answer?.status === 200 ? parseActivateStatus(answer.body) : null;
}

/* ── Internals ──────────────────────────────────────────────────────────── */

/** A document whose root element is ActivateStatus, after any XML declaration or comments. */
const ACTIVATE_STATUS_ROOT = /^(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?ActivateStatus[\s/>]/;

/** The text of its <Activated> element, in any namespace prefix. */
const ACTIVATED_FIELD = /<(?:[\w.-]+:)?Activated(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?Activated\s*>/;

/**
 * GET a URL without credentials (not even ones the browser remembers) or the
 * HTTP cache, within the time limit.
 * @param {string} url
 * @param {ProbeOptions} options
 * @param {boolean} readBody - read the body of a 200 answer, within the same limit
 * @returns {Promise<{status: number, headers: Headers, body: string}|null>} null when nothing
 *   answered in time (refused, unreachable or timed out) or the caller cancelled
 */
async function getWithoutLogin(url, { timeoutMs, signal }, readBody) {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  try {
    const resp = await fetch(url, { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
    const body = readBody && resp.status === 200 ? await resp.text() : '';
    return { status: resp.status, headers: resp.headers, body };
  } catch {
    // fetch fails only when nothing answered (or the answer was cut off), which is a
    // result here: most addresses a scan tries have nothing on them
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
