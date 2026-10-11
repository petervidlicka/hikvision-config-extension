/**
 * ResponseStatus parsing in every shape devices send, the user-facing
 * messages built from it, the shared endpoint-fallback policy, and what a
 * device says about a rejected login.
 */
import { describe, expect, it } from 'vitest';
import { AuthError } from '../../extension/lib/digest-auth.js';
import {
  IsapiError, NetworkError, TimeoutError, isFallbackError, parseLoginStatus, parseResponseStatus,
} from '../../extension/lib/errors.js';

/** Bodies captured from the DS-7604NI (V4.75.206) and its /SDK/ endpoints. */
const HIKVISION_NOT_SUPPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<requestURL>/ISAPI/System/Video/inputs/channels</requestURL>
<statusCode>4</statusCode>
<statusString>Invalid Operation</statusString>
<subStatusCode>notSupport</subStatusCode>
</ResponseStatus>
`;
const HIKVISION_BAD_CONTENT = `<?xml version="1.0" encoding="UTF-8" ?>
<ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<requestURL>/ISAPI/Event/triggers/VMD-3</requestURL>
<statusCode>6</statusCode>
<statusString>Invalid XML Content</statusString>
<subStatusCode>badXmlContent</subStatusCode>
<subStatusString>Tag 16 is invalid (two root tags)</subStatusString>
</ResponseStatus>
`;
const PSIA_BAD_CONTENT = `<?xml version="1.0" encoding="UTF-8" ?>
<ResponseStatus version="1.0" xmlns="urn:psialliance-org">
<requestURL>/SDK/play/101/004</requestURL>
<statusCode>6</statusCode>
<statusString>Invalid XML Content</statusString>
</ResponseStatus>
`;

/**
 * @param {number} httpStatus
 * @param {string} [body]
 */
const errorFor = (httpStatus, body = '') =>
  new IsapiError({ method: 'GET', path: '/ISAPI/x', httpStatus, status: parseResponseStatus(body) });

/** A minimal hikvision.com-style body for a subStatusCode. */
const statusBody = (statusCode, subStatusCode) =>
  `<ResponseStatus xmlns="http://www.hikvision.com/ver20/XMLSchema"><statusCode>${statusCode}</statusCode><subStatusCode>${subStatusCode}</subStatusCode></ResponseStatus>`;

describe('parseResponseStatus', () => {
  it('reads hikvision.com bodies, including the detail some firmware adds', () => {
    expect(parseResponseStatus(HIKVISION_NOT_SUPPORT)).toEqual({
      statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport', subStatusString: null,
    });
    expect(parseResponseStatus(HIKVISION_BAD_CONTENT)?.subStatusString).toBe('Tag 16 is invalid (two root tags)');
  });

  it('reads isapi.org and prefixed namespaces by local name', () => {
    const isapiOrg = '<ResponseStatus version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">' +
      '<statusCode>7</statusCode><statusString>Reboot Required</statusString><subStatusCode>rebootRequired</subStatusCode></ResponseStatus>';
    expect(parseResponseStatus(isapiOrg)).toMatchObject({ statusCode: 7, subStatusCode: 'rebootRequired' });

    const prefixed = '<?xml version="1.0"?>\n<!-- device -->\n<hik:ResponseStatus xmlns:hik="http://www.hikvision.com/ver20/XMLSchema">' +
      '<hik:statusCode>4</hik:statusCode><hik:subStatusCode>lowPrivilege</hik:subStatusCode></hik:ResponseStatus>';
    expect(parseResponseStatus(prefixed)).toMatchObject({ statusCode: 4, subStatusCode: 'lowPrivilege' });
  });

  it('reads PSIA bodies, which have no subStatusCode', () => {
    expect(parseResponseStatus(PSIA_BAD_CONTENT)).toEqual({
      statusCode: 6, statusString: 'Invalid XML Content', subStatusCode: null, subStatusString: null,
    });
  });

  it('reads the JSON form, flat or wrapped', () => {
    expect(parseResponseStatus('{"statusCode": 4, "statusString": "Invalid Operation", "subStatusCode": "notSupport", "errorCode": 1073741825}'))
      .toEqual({ statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport', subStatusString: null });
    expect(parseResponseStatus('{"ResponseStatus": {"statusCode": "2", "subStatusCode": "deviceBusy"}}'))
      .toMatchObject({ statusCode: 2, subStatusCode: 'deviceBusy' });
  });

  it('decodes character references in text', () => {
    const body = '<ResponseStatus><statusCode>3</statusCode><subStatusString>a &lt; b &amp; &#x63;&#100;</subStatusString></ResponseStatus>';
    expect(parseResponseStatus(body)?.subStatusString).toBe('a < b & cd');
  });

  it('returns null for anything that isn’t a ResponseStatus', () => {
    expect(parseResponseStatus('')).toBeNull();
    expect(parseResponseStatus('<html><body><h1>404 Not Found</h1></body></html>')).toBeNull();
    expect(parseResponseStatus('<PrivacyMask><enabled>true</enabled></PrivacyMask>')).toBeNull();
    expect(parseResponseStatus('<ResponseStatus/>')).toBeNull();
    expect(parseResponseStatus('{"truncated": ')).toBeNull();
    expect(parseResponseStatus('{"other": 1}')).toBeNull();
  });
});

describe('IsapiError', () => {
  it('keeps the device’s codes and the request', () => {
    const err = new IsapiError({ method: 'PUT', path: '/ISAPI/Event/triggers/VMD-3', httpStatus: 400, status: parseResponseStatus(HIKVISION_BAD_CONTENT) });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: 'IsapiError', method: 'PUT', path: '/ISAPI/Event/triggers/VMD-3', httpStatus: 400,
      statusCode: 6, statusString: 'Invalid XML Content', subStatusCode: 'badXmlContent',
      subStatusString: 'Tag 16 is invalid (two root tags)', reason: 'badXmlContent',
    });
  });

  it('explains common reasons in plain words, with the device’s detail', () => {
    expect(errorFor(403, statusBody(4, 'lowPrivilege')).message).toMatch(/doesn’t have permission/);
    expect(errorFor(403, HIKVISION_NOT_SUPPORT).message).toMatch(/doesn’t support this/);
    expect(errorFor(503, statusBody(2, 'deviceBusy')).message).toMatch(/busy/);
    expect(errorFor(400, HIKVISION_BAD_CONTENT).message)
      .toBe('The device rejected the settings that were sent as invalid. Reload the settings and try again. Details: Tag 16 is invalid (two root tags).');
  });

  it('infers the reason from the statusCode when firmware sends no subStatusCode', () => {
    const err = errorFor(400, PSIA_BAD_CONTENT);
    expect(err.subStatusCode).toBeNull();
    expect(err.reason).toBe('badXmlContent');
    expect(err.message).toMatch(/rejected the settings/);
  });

  it('falls back to the device’s statusString, then to the HTTP status', () => {
    expect(errorFor(403, '<ResponseStatus><statusCode>4</statusCode><statusString>Weird Thing</statusString><subStatusCode>weirdThing</subStatusCode></ResponseStatus>').message)
      .toBe('The device answered “Weird Thing” (weirdThing).');
    expect(errorFor(404, '<html>Not Found</html>').message).toMatch(/HTTP 404/);
    expect(errorFor(418).message).toBe('The device answered with an error (HTTP 418).');
  });
});

describe('isFallbackError', () => {
  it('moves on only when the device answered "not here"', () => {
    expect(isFallbackError(errorFor(404))).toBe(true);
    expect(isFallbackError(errorFor(403, HIKVISION_NOT_SUPPORT))).toBe(true);
    expect(isFallbackError(errorFor(403, statusBody(4, 'invalidOperation')))).toBe(true);
    expect(isFallbackError(errorFor(403, '<html>Forbidden</html>'))).toBe(true);
    expect(isFallbackError(errorFor(400, HIKVISION_BAD_CONTENT))).toBe(true);
    expect(isFallbackError(errorFor(400, PSIA_BAD_CONTENT))).toBe(true);
    expect(isFallbackError(errorFor(400, statusBody(6, 'badParameters')))).toBe(true);
    // A write the device refuses inside an HTTP 200 (checkWriteResponse), e.g. a DELETE it can't do
    expect(isFallbackError(errorFor(200, HIKVISION_NOT_SUPPORT))).toBe(true);
    expect(isFallbackError(errorFor(200, statusBody(4, 'invalidOperation')))).toBe(true);
  });

  it('stops on anything that would fail the same way again', () => {
    const address = '10.0.0.1:80';
    expect(isFallbackError(errorFor(403, statusBody(4, 'lowPrivilege')))).toBe(false);
    expect(isFallbackError(errorFor(503, statusBody(2, 'serviceUnavailable')))).toBe(false);
    expect(isFallbackError(errorFor(503, statusBody(2, 'deviceBusy')))).toBe(false);
    expect(isFallbackError(errorFor(500, statusBody(3, 'deviceError')))).toBe(false);
    expect(isFallbackError(errorFor(400, statusBody(5, 'badXmlFormat')))).toBe(false);
    expect(isFallbackError(errorFor(200, HIKVISION_BAD_CONTENT))).toBe(false);
    expect(isFallbackError(errorFor(200, statusBody(4, 'lowPrivilege')))).toBe(false);
    expect(isFallbackError(new AuthError())).toBe(false);
    expect(isFallbackError(new TimeoutError({ method: 'GET', path: '/a', address, timeoutMs: 5000 }))).toBe(false);
    expect(isFallbackError(new NetworkError({ method: 'GET', path: '/a', address }))).toBe(false);
    expect(isFallbackError(new DOMException('stopped', 'AbortError'))).toBe(false);
    expect(isFallbackError(new Error('Device returned malformed XML'))).toBe(false);
  });
});

describe('NetworkError and TimeoutError', () => {
  it('name the address, and a timeout is a kind of network failure', () => {
    const timeout = new TimeoutError({ method: 'GET', path: '/ISAPI/System/deviceInfo', address: '192.168.0.8:80', timeoutMs: 8000 });
    expect(timeout).toBeInstanceOf(NetworkError);
    expect(timeout.message).toBe('No response from the device at 192.168.0.8:80 within 8 s. Check that it is reachable and try again.');
    expect(new NetworkError({ method: 'GET', path: '/a', address: '192.168.0.8:80' }).message).toMatch(/^Couldn’t reach the device at 192\.168\.0\.8:80\./);
  });
});

describe('login status', () => {
  /** The DS-7604NI's answer to a userCheck it accepts (V4.75.206). */
  const ACCEPTED = '<?xml version="1.0" encoding="UTF-8" ?>\n<userCheck>\n<statusValue>200</statusValue>\n' +
    '<statusString>OK</statusString>\n<isDefaultPassword>false</isDefaultPassword>\n<isRiskPassword>false</isRiskPassword>\n' +
    '<isActivated>true</isActivated>\n</userCheck>';
  /** The 401 page the DS-7604NI sends, with or without credentials. */
  const HTML_401 = '<!DOCTYPE html>\n<head>\n    <title>Unauthorized</title>\n</head>\n<body>\n' +
    '<h2>Access Error: 401 -- Unauthorized</h2>\n<pre></pre>\n</body>\n</html>\n';

  it('reads the lock, the time until it lifts and the attempts left, in any namespace or prefix', () => {
    expect(parseLoginStatus('<?xml version="1.0"?><userCheck version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">' +
      '<statusValue>401</statusValue><statusString>Unauthorized</statusString><lockStatus>lock</lockStatus>' +
      '<unlockTime>1790</unlockTime><retryLoginTime>0</retryLoginTime></userCheck>'))
      .toEqual({ statusValue: 401, subStatusCode: undefined, locked: true, unlockSeconds: 1790, attemptsLeft: 0 });
    expect(parseLoginStatus('<h:userCheck xmlns:h="urn:x"><h:statusValue>401</h:statusValue><h:lockStatus>unlock</h:lockStatus>' +
      '<h:retryLoginTime>4</h:retryLoginTime></h:userCheck>'))
      .toMatchObject({ statusValue: 401, locked: false, unlockSeconds: undefined, attemptsLeft: 4 });
  });

  it('reads the verdict of an accepted userCheck and the reason in a ResponseStatus', () => {
    expect(parseLoginStatus(ACCEPTED)).toMatchObject({ statusValue: 200, locked: undefined, attemptsLeft: undefined });
    expect(parseLoginStatus(HIKVISION_NOT_SUPPORT)).toMatchObject({ statusValue: undefined, subStatusCode: 'notSupport' });
  });

  it('finds nothing in an HTML page, an empty body or XML without login fields', () => {
    expect(parseLoginStatus(HTML_401)).toBeNull();
    expect(parseLoginStatus('<html><body><statusValue>401</statusValue></body></html>')).toBeNull();
    expect(parseLoginStatus('')).toBeNull();
    expect(parseLoginStatus('<DeviceInfo><deviceName>NVR</deviceName></DeviceInfo>')).toBeNull();
  });

  it('turns it into the message the user sees', () => {
    expect(new AuthError().message).toBe('Device rejected the username or password');
    expect(new AuthError({ locked: true, unlockSeconds: 30 }).message)
      .toBe('The device has temporarily locked logins from this computer — try again in 1 min');
    expect(new AuthError({ locked: true }).message)
      .toBe('The device has temporarily locked logins from this computer — try again later');
    expect(new AuthError({ locked: false, attemptsLeft: 1 }).message)
      .toBe('Wrong user name or password — 1 attempt left before the device locks this computer out');
    expect(new AuthError({ attemptsLeft: 0 }).message)
      .toBe('Wrong user name or password — no attempts left before the device locks this computer out');
  });
});
