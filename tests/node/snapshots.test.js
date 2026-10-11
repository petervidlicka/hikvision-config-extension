/**
 * Live snapshots without a device: the URLs a channel's frames may come
 * from, finding one and keeping it, the wait after failed requests, and the
 * polling loop on fake timers, against a camera that sends a new picture
 * every time and an NVR that repeats a cached one for a second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../extension/lib/digest-auth.js';
import { IsapiError, NotAnImageError, TimeoutError } from '../../extension/lib/errors.js';
import { jpegSize } from '../../extension/lib/picture-size.js';
import { SnapshotPacer } from '../../extension/lib/snapshot-pacer.js';
import {
  DEFAULT_FULL_SIZE, NO_SIGNAL_AFTER_FAILURES, OFFLINE_START_FAILURES, RESOLVE_AGAIN_AFTER_FAILURES, SNAPSHOT_RETRY_MAX_MS,
  SnapshotSource, fullSizePicturePath, fullSizeUpgrade, isJpeg, pollSnapshots, snapshotPaths, snapshotRetryDelay,
} from '../../extension/lib/snapshots.js';

/** An error answer as the DS-7604NI gives it. */
const answer = (httpStatus, subStatusCode) =>
  new IsapiError({ method: 'GET', path: '/x', httpStatus, status: { statusCode: null, statusString: null, subStatusCode, subStatusString: null } });
const notHere = () => answer(403, 'notSupport');
const noCamera = () => answer(503, 'serviceUnavailable');
let frameSeq = 0;
/** A JPEG's start marker and a counter: a new picture every call, like a camera. */
const frame = () => new Uint8Array([0xff, 0xd8, ++frameSeq >> 8, frameSeq & 0xff]);
/**
 * The start of a JPEG of a given size, up to its frame header, and a counter
 * so each is a new picture.
 * @param {number} width
 * @param {number} height
 */
const sizedFrame = (width, height) => () => new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
  0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, ++frameSeq >> 8, frameSeq & 0xff,
]);
/** The DS-7604NI's plain still, the same on both streams. */
const nvrStill = sizedFrame(704, 576);
/** The DS-7604NI's still when asked for a size. */
const nvrFullStill = sizedFrame(1920, 1088);
/** The single view's pacing. */
const singleViewPacer = () => new SnapshotPacer({ intervalMs: 200, repeatStepMs: 150 });

/**
 * A fake device: `answers` maps a path to what it answers (a function, so
 * tests can change it), anything else is "not here". Records each request.
 */
function fakeDevice(answers) {
  const calls = [];
  /** @type {(path: string, options: object) => Promise<Uint8Array>} */
  const fetchSnapshot = async (path, options) => {
    calls.push(path);
    options.signal?.throwIfAborted();
    const result = answers[path]?.() ?? notHere();
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, fetchSnapshot };
}

describe('snapshot URLs', () => {
  it('lists the stream asked for, the main stream, StreamingProxy for IP cameras, then the bare ID', () => {
    expect(snapshotPaths({ id: '1', kind: 'analog' }, 'main')).toEqual([
      '/ISAPI/Streaming/channels/101/picture', '/ISAPI/Streaming/channels/1/picture',
    ]);
    expect(snapshotPaths({ id: '3', kind: 'digital' }, 'sub')).toEqual([
      '/ISAPI/Streaming/channels/302/picture',
      '/ISAPI/Streaming/channels/301/picture',
      '/ISAPI/ContentMgmt/StreamingProxy/channels/302/picture',
      '/ISAPI/Streaming/channels/3/picture',
    ]);
    expect(snapshotPaths({ id: '12', kind: 'digital' }, 'main')).toEqual([
      '/ISAPI/Streaming/channels/1201/picture',
      '/ISAPI/ContentMgmt/StreamingProxy/channels/1201/picture',
      '/ISAPI/Streaming/channels/12/picture',
    ]);
  });

  it('recognises a JPEG by its start marker', () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpeg(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(false);
    expect(isJpeg(new Uint8Array([0xff]))).toBe(false);
  });

  it('waits ever longer after failed requests, up to a limit', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(snapshotRetryDelay)).toEqual([0, 500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(snapshotRetryDelay(100)).toBe(SNAPSHOT_RETRY_MAX_MS);
  });
});

describe('SnapshotSource', () => {
  const paths = snapshotPaths({ id: '3', kind: 'digital' }, 'sub');

  it('keeps the first URL that serves a frame', async () => {
    const device = fakeDevice({ '/ISAPI/ContentMgmt/StreamingProxy/channels/302/picture': frame });
    const source = new SnapshotSource(paths, device.fetchSnapshot);
    await source.next();
    await source.next();
    expect(device.calls).toEqual([...paths.slice(0, 3), paths[2]]);
    expect(source.path).toBe(paths[2]);
  });

  it('passes over a URL that answers with something other than an image', async () => {
    const device = fakeDevice({
      [paths[0]]: () => new NotAnImageError({ method: 'GET', path: paths[0], contentType: 'text/html' }),
      [paths[1]]: frame,
    });
    await new SnapshotSource(paths, device.fetchSnapshot).next();
    expect(device.calls).toEqual(paths.slice(0, 2));
  });

  it('keeps a URL where the device answered without a frame, so a failing channel costs one request', async () => {
    const device = fakeDevice({ [paths[0]]: noCamera });
    const source = new SnapshotSource(paths, device.fetchSnapshot);
    for (let i = 0; i < 3; i++) await expect(source.next()).rejects.toMatchObject({ httpStatus: 503 });
    expect(device.calls).toEqual(Array(3).fill(paths[0]));
    expect(source.failures).toBe(3);
  });

  it('asks for the stream asked for when no URL has frames, and throws its answer', async () => {
    const device = fakeDevice({});
    const source = new SnapshotSource(paths, device.fetchSnapshot);
    const err = await source.next().catch(e => e);
    expect(err).toMatchObject({ httpStatus: 403, subStatusCode: 'notSupport' });
    expect(device.calls).toEqual(paths);
    await expect(source.next()).rejects.toBeInstanceOf(IsapiError);
    expect(device.calls.slice(paths.length)).toEqual([paths[0]]);
  });

  it('looks for the URL again after a timeout, which says nothing about it', async () => {
    const timeout = new TimeoutError({ method: 'GET', path: paths[0], address: 'h:80', timeoutMs: 5000 });
    let answerFirst = () => timeout;
    const device = fakeDevice({ [paths[0]]: () => answerFirst(), [paths[1]]: frame });
    const source = new SnapshotSource(paths, device.fetchSnapshot);
    await expect(source.next()).rejects.toBe(timeout);
    expect(source.path).toBeNull();
    answerFirst = notHere;
    await source.next();
    expect(device.calls).toEqual([paths[0], paths[0], paths[1]]);
  });

  it('finds the URL again after several failures in a row, and resets on a frame', async () => {
    let first = frame;
    const device = fakeDevice({ [paths[0]]: () => first(), [paths[1]]: frame });
    const source = new SnapshotSource(paths, device.fetchSnapshot);
    await source.next();
    first = notHere;
    for (let i = 0; i < RESOLVE_AGAIN_AFTER_FAILURES; i++) await expect(source.next()).rejects.toBeInstanceOf(IsapiError);
    expect(source.path).toBeNull();
    expect(source.noSignal).toBe(true);
    await source.next();
    expect(device.calls.slice(-2)).toEqual(paths.slice(0, 2));
    expect([source.path, source.failures, source.noSignal]).toEqual([paths[1], 0, false]);
  });

  it('has no signal after a few failures, or from the start when listed offline', async () => {
    const device = fakeDevice({ [paths[0]]: noCamera });
    const source = new SnapshotSource(paths, device.fetchSnapshot);
    for (let i = 1; i <= NO_SIGNAL_AFTER_FAILURES; i++) {
      expect(source.noSignal).toBe(false);
      await source.next().catch(() => {});
    }
    expect(source.noSignal).toBe(true);

    const offline = new SnapshotSource(paths, device.fetchSnapshot, { offline: true });
    expect([offline.noSignal, offline.failures]).toEqual([true, OFFLINE_START_FAILURES]);
  });

  it('doesn’t count a request the caller cancelled', async () => {
    const device = fakeDevice({ [paths[0]]: frame });
    const source = new SnapshotSource(paths, device.fetchSnapshot);
    const controller = new AbortController();
    controller.abort();
    await expect(source.next({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.failures).toBe(0);
  });
});

describe('full-size stills', () => {
  const nvrCamera = { id: '1', kind: 'digital' };
  const [plain] = snapshotPaths(nvrCamera, 'main');
  const sized = '/ISAPI/Streaming/channels/101/picture?videoResolutionWidth=2688&videoResolutionHeight=1520';
  const mainStream = { width: 2688, height: 1520 };

  /**
   * A main-stream SnapshotSource for a channel with fullSizeUpgrade, and what it decided.
   * @param {{id: string, kind: 'analog'|'digital'}} channel
   * @param {ReturnType<typeof fakeDevice>} device
   * @param {{streamSize: {width: number, height: number}|undefined}} [options] - the main stream's size, if known
   */
  const mainSource = (channel, device, options = { streamSize: mainStream }) => {
    const { streamSize } = options;
    const decided = [];
    const source = new SnapshotSource(snapshotPaths(channel, 'main'), device.fetchSnapshot, {
      upgrade: fullSizeUpgrade({ channel, streamSize, fetchSnapshot: device.fetchSnapshot, remember: path => decided.push(path) }),
    });
    return { source, decided };
  };

  it('asks for the main stream’s own size', () => {
    expect(fullSizePicturePath('1', mainStream)).toBe(sized);
    expect(fullSizePicturePath('12', DEFAULT_FULL_SIZE))
      .toBe('/ISAPI/Streaming/channels/1201/picture?videoResolutionWidth=1920&videoResolutionHeight=1080');
  });

  it('switches an NVR’s IP camera to its full-size still, and keeps asking only that', async () => {
    const device = fakeDevice({ [plain]: nvrStill, [sized]: nvrFullStill });
    const { source, decided } = mainSource(nvrCamera, device);
    expect(jpegSize(await source.next())).toEqual({ width: 1920, height: 1088 });
    await source.next();
    expect(device.calls).toEqual([plain, sized, sized]);
    expect(decided).toEqual([sized]);
    expect([source.path, source.paths[0]]).toEqual([sized, sized]);
  });

  it('asks for 1920×1080 when the stream size isn’t known', async () => {
    const fallback = fullSizePicturePath('1', DEFAULT_FULL_SIZE);
    const device = fakeDevice({ [plain]: nvrStill, [fallback]: nvrFullStill });
    const { source, decided } = mainSource(nvrCamera, device, { streamSize: undefined });
    await source.next();
    expect(decided).toEqual([fallback]);
  });

  it('keeps the plain still when the sized one is refused, not an image, or no bigger', async () => {
    const answers = [
      () => answer(400, 'badParameters'),
      () => answer(404, null),
      () => answer(403, 'lowPrivilege'),
      () => new NotAnImageError({ method: 'GET', path: sized, contentType: 'text/html' }),
      nvrStill, // firmware that ignores the size
    ];
    for (const sizedAnswer of answers) {
      const device = fakeDevice({ [plain]: nvrStill, [sized]: sizedAnswer });
      const { source, decided } = mainSource(nvrCamera, device);
      expect(jpegSize(await source.next())).toEqual({ width: 704, height: 576 });
      await source.next();
      expect(device.calls).toEqual([plain, sized, plain]);
      expect(decided).toEqual([null]);
    }
  });

  it('decides nothing when the sized request gets no answer or a busy one, and serves the plain still meanwhile', async () => {
    const answers = [
      () => new TimeoutError({ method: 'GET', path: sized, address: 'h:80', timeoutMs: 10000 }),
      () => answer(503, 'serviceUnavailable'), // the camera dropped for a moment
      () => new IsapiError({ method: 'GET', path: sized, httpStatus: 503, status: null }),
      () => new IsapiError({ method: 'GET', path: sized, httpStatus: 403, status: { statusCode: 2, statusString: 'Device Busy', subStatusCode: null, subStatusString: null } }),
      () => answer(500, 'deviceError'),
    ];
    for (const sizedAnswer of answers) {
      const device = fakeDevice({ [plain]: nvrStill, [sized]: sizedAnswer });
      const { source, decided } = mainSource(nvrCamera, device);
      expect(jpegSize(await source.next())).toEqual({ width: 704, height: 576 });
      // This feed keeps the plain still; nothing is remembered, so the channel's next feed looks again
      await source.next();
      expect(device.calls).toEqual([plain, sized, plain]);
      expect([decided, source.path, source.failures]).toEqual([[], plain, 0]);
    }
  });

  it('looks with the first frame after the channel recovers, also when the URL was kept from a failure', async () => {
    let starting = true;
    const device = fakeDevice({ [plain]: () => (starting ? noCamera() : nvrStill()), [sized]: nvrFullStill });
    const { source, decided } = mainSource(nvrCamera, device);
    // A camera still starting: the device answers 503, and the plain URL is kept
    await expect(source.next()).rejects.toBeInstanceOf(IsapiError);
    await expect(source.next()).rejects.toBeInstanceOf(IsapiError);
    expect([source.path, source.noSignal]).toEqual([plain, true]);
    starting = false;
    expect(jpegSize(await source.next())).toEqual({ width: 1920, height: 1088 });
    await source.next();
    expect(device.calls).toEqual([plain, plain, plain, sized, sized]);
    expect([decided, source.path, source.failures]).toEqual([[sized], sized, 0]);
  });

  it('looks once a camera listed offline delivers its first frame', async () => {
    let online = false;
    const device = fakeDevice({ [plain]: () => (online ? nvrStill() : noCamera()), [sized]: nvrFullStill });
    const decided = [];
    const source = new SnapshotSource(snapshotPaths(nvrCamera, 'main'), device.fetchSnapshot, {
      offline: true,
      upgrade: fullSizeUpgrade({ channel: nvrCamera, streamSize: mainStream, fetchSnapshot: device.fetchSnapshot, remember: path => decided.push(path) }),
    });
    await expect(source.next()).rejects.toBeInstanceOf(IsapiError);
    online = true;
    expect(jpegSize(await source.next())).toEqual({ width: 1920, height: 1088 });
    expect([device.calls, decided]).toEqual([[plain, plain, sized], [sized]]);
  });

  it('looks again after a pause cut it short', async () => {
    const controller = new AbortController();
    const device = fakeDevice({
      [plain]: nvrStill,
      // The feed pauses while the first sized request is in flight
      [sized]: () => {
        if (controller.signal.aborted) return nvrFullStill();
        controller.abort();
        return controller.signal.reason;
      },
    });
    const { source, decided } = mainSource(nvrCamera, device);
    await expect(source.next({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect([decided, source.failures]).toEqual([[], 0]);
    // Resumed: the plain URL, then the sized one again
    expect(jpegSize(await source.next())).toEqual({ width: 1920, height: 1088 });
    expect(device.calls).toEqual([plain, sized, plain, sized]);
    expect(decided).toEqual([sized]);
  });

  it('asks a camera’s main stream for a size only when its stills are the same size on both streams', async () => {
    const camera = { id: '1', kind: 'analog' };
    const [sub] = snapshotPaths(camera, 'sub');

    // A camera: its main-stream still is full size already
    let device = fakeDevice({ [plain]: sizedFrame(2688, 1520), [sub]: sizedFrame(640, 360) });
    let { source, decided } = mainSource(camera, device);
    expect(jpegSize(await source.next())).toEqual({ width: 2688, height: 1520 });
    expect([device.calls, decided]).toEqual([[plain, sub], [null]]);

    // A camera without a sub stream
    device = fakeDevice({ [plain]: sizedFrame(2688, 1520) });
    ({ source, decided } = mainSource(camera, device));
    await source.next();
    expect([device.calls, decided]).toEqual([[plain, sub], [null]]);

    // A sub stream busy for a moment shows nothing about it: the next feed looks again
    device = fakeDevice({ [plain]: sizedFrame(2688, 1520), [sub]: noCamera });
    ({ source, decided } = mainSource(camera, device));
    await source.next();
    expect([device.calls, decided]).toEqual([[plain, sub], []]);

    // An analog channel serving the same small still on both streams, like the DS-7604NI's IP cameras
    device = fakeDevice({ [plain]: nvrStill, [sub]: nvrStill, [sized]: nvrFullStill });
    ({ source, decided } = mainSource(camera, device));
    expect(jpegSize(await source.next())).toEqual({ width: 1920, height: 1088 });
    expect([device.calls, decided]).toEqual([[plain, sub, sized], [sized]]);
  });

  it('only upgrades the plain main-stream URL, and only a frame whose size it can read', async () => {
    // Served at StreamingProxy only: there is no sized form of that URL
    const proxy = '/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture';
    let device = fakeDevice({ [proxy]: nvrStill });
    let { source, decided } = mainSource(nvrCamera, device);
    await source.next();
    expect([device.calls, decided]).toEqual([[plain, proxy], []]);

    device = fakeDevice({ [plain]: frame });
    ({ source, decided } = mainSource(nvrCamera, device));
    await source.next();
    expect([device.calls, decided]).toEqual([[plain], []]);
  });

  it('tries the full-size URL first when the URL is to be found again', async () => {
    let sizedAnswer = nvrFullStill;
    const device = fakeDevice({ [plain]: nvrStill, [sized]: () => sizedAnswer() });
    const { source } = mainSource(nvrCamera, device);
    await source.next();
    sizedAnswer = () => answer(403, 'notSupport');
    for (let i = 0; i < RESOLVE_AGAIN_AFTER_FAILURES; i++) await expect(source.next()).rejects.toBeInstanceOf(IsapiError);
    const before = device.calls.length;
    await source.next();
    expect(device.calls.slice(before)).toEqual([sized, plain]);
    expect(source.path).toBe(plain);
  });
});

/**
 * A device that takes `latencyMs` to answer each request with a picture:
 * a new one every time (a camera), or with `refreshMs`, the same cached
 * still until it is refreshed, like the DS-7604NI (about once a second).
 * Runs on fake time; counts requests and the different pictures it sent.
 * @param {{latencyMs: number, refreshMs?: number}} behaviour
 */
function pictureDevice({ latencyMs, refreshMs }) {
  const start = Date.now();
  let calls = 0;
  let answered = 0;
  const sent = new Set();
  /** @type {(path: string, options: {signal?: AbortSignal}) => Promise<Uint8Array>} */
  const fetchSnapshot = async (path, { signal }) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, latencyMs));
    signal?.throwIfAborted();
    answered++;
    // The still is refreshed 0.5 s after the device starts, then every refreshMs
    const n = refreshMs ? Math.floor((Date.now() - start + refreshMs / 2) / refreshMs) : calls;
    sent.add(n);
    return new Uint8Array([0xff, 0xd8, n >> 8, n & 0xff]);
  };
  return { fetchSnapshot, calls: () => calls, answered: () => answered, picturesSent: () => sent.size };
}

describe('pollSnapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const paths = snapshotPaths({ id: '2', kind: 'analog' }, 'sub');

  it('shows each picture of an NVR’s cached still once, from fewer requests than polling every 200 ms', async () => {
    // The DS-7604NI: a request takes ~190 ms, the still changes once a second
    const nvr = pictureDevice({ latencyMs: 190, refreshMs: 1000 });
    const pacer = singleViewPacer();
    let frames = 0;
    let repeats = 0;
    const stop = pollSnapshots(new SnapshotSource(paths, nvr.fetchSnapshot), {
      pacer,
      onFrame: () => frames++,
      onRepeat: () => repeats++,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    stop();

    // Every picture the device sent was shown, once; every other answer was a repeat
    expect(nvr.picturesSent()).toBe(11);
    expect(frames).toBe(nvr.picturesSent());
    expect(repeats).toBe(nvr.answered() - frames);
    expect(pacer.framesPerSecond(performance.now())).toBeCloseTo(1, 1);
    // Polling every 200 ms would have asked 50 times (each request takes 190 ms), 5 per picture
    expect(nvr.calls()).toBeLessThan(0.75 * 50);
    expect(nvr.calls() / frames).toBeLessThan(3.5);
  });

  it('keeps asking a camera every interval: a new picture every time isn’t slowed down', async () => {
    const camera = pictureDevice({ latencyMs: 50 });
    const pacer = singleViewPacer();
    let frames = 0;
    const stop = pollSnapshots(new SnapshotSource(paths, camera.fetchSnapshot), { pacer, onFrame: () => frames++ });
    await vi.advanceTimersByTimeAsync(9_990);
    stop();
    // At 0, 0.2, … 9.8 s, each answered 50 ms later
    expect(camera.calls()).toBe(50);
    expect(frames).toBe(50);
    expect(pacer.framesPerSecond(performance.now())).toBe(5);
  });

  it('asks a failing channel once per tick, ever less often, and recovers', async () => {
    let answerFirst = noCamera;
    const device = fakeDevice({ [paths[0]]: () => answerFirst() });
    const events = [];
    const stop = pollSnapshots(new SnapshotSource(paths, device.fetchSnapshot), {
      pacer: singleViewPacer(),
      onFrame: () => events.push('frame'),
      onError: err => events.push(err.httpStatus),
      onNoSignal: lost => events.push(lost ? 'no signal' : 'signal'),
    });

    /** Requests made at each step of fake time. */
    const requestsAfter = async (ms) => {
      const before = device.calls.length;
      await vi.advanceTimersByTimeAsync(ms);
      return device.calls.length - before;
    };
    expect(await requestsAfter(0)).toBe(0); // the first request went out at the start
    expect(device.calls).toEqual([paths[0]]);
    expect(await requestsAfter(499)).toBe(0);
    expect(await requestsAfter(1)).toBe(1); // 0.5 s after the 1st failure
    expect(await requestsAfter(999)).toBe(0);
    expect(await requestsAfter(1)).toBe(1); // 1 s after the 2nd
    expect(await requestsAfter(2000)).toBe(1); // 2 s after the 3rd
    expect(await requestsAfter(4000)).toBe(1); // 4 s after the 4th
    expect(device.calls).toEqual(Array(5).fill(paths[0]));
    expect(events).toEqual([503, 'no signal', 503, 503, 503, 503]);

    // The camera is back: the next retry (8 s later) gets a frame, then frames come every interval
    answerFirst = frame;
    expect(await requestsAfter(7999)).toBe(0);
    expect(await requestsAfter(1)).toBe(1);
    expect(events.slice(-2)).toEqual(['signal', 'frame']);
    expect(await requestsAfter(200)).toBe(1);
    expect(await requestsAfter(200)).toBe(1);
    stop();
    expect(await requestsAfter(10000)).toBe(0);
  });

  it('starts a channel listed offline with no signal, asks at once, then slowly', async () => {
    const device = fakeDevice({ [paths[0]]: noCamera });
    const events = [];
    const stop = pollSnapshots(new SnapshotSource(paths, device.fetchSnapshot, { offline: true }), {
      pacer: new SnapshotPacer({ intervalMs: 500, repeatStepMs: 500 }),
      onFrame: () => events.push('frame'),
      onNoSignal: lost => events.push(lost ? 'no signal' : 'signal'),
    });
    expect(events).toEqual(['no signal']);
    await vi.advanceTimersByTimeAsync(7999);
    expect(device.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(device.calls).toHaveLength(2);
    stop();
  });

  it('stops after a rejected login, and aborts the request in flight when stopped', async () => {
    const device = fakeDevice({ [paths[0]]: () => new AuthError(null) });
    pollSnapshots(new SnapshotSource(paths, device.fetchSnapshot), { pacer: singleViewPacer(), onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(60000);
    expect(device.calls).toHaveLength(1);

    /** @type {AbortSignal|undefined} */
    let signal;
    const hanging = new SnapshotSource(paths, (path, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const stop = pollSnapshots(hanging, { pacer: singleViewPacer(), onFrame: () => {} });
    stop();
    expect(signal?.aborted).toBe(true);
  });
});
