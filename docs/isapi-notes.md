# ISAPI notes

What this extension learned about configuring Hikvision devices over ISAPI:
how Hikvision's own clients do it, and what a real NVR answered. The code
that relies on each fact is named next to it (`lib/…` is `extension/lib/`,
`src/…` is `extension/src/`).

## Sources

- **Hikvision's web UI**, served by the NVR from `/doc/script/` (web version
  V4.0.1 build 231207, WebComponents plugin V3.0.7.500), mainly
  `config/event/eventMotion.js`, `config/drawTools.js`,
  `config/image/privacyMask.js`, `download.js` and `isapi/websdk.js`. The UI
  needs the Windows plugin to draw regions, which is why it only works in
  Internet Explorer.
- **iVMS-4200** (macOS) and its HCNetSDK libraries, read as strings and
  disassembly. iVMS talks to devices over Hikvision's private SDK protocol
  (port 8000), not ISAPI, so it shows behaviour rather than URLs.
- **The test device**: a DS-7604NI-K1/4P NVR, firmware V4.75.206 build
  240119, with four IP cameras (DS-2CD2347G2H-LIU on channels 1 and 2,
  DS-2CD2346G2-ISU/SL with relay, white light and speaker on channels 3 and
  4). "The DS-7604NI" below means this device: facts about it were read from
  it, and the write tests were made on channel 3, with every setting restored
  afterwards. Other models and firmware may differ; where the extension
  depends on such a fact, it falls back to what the web UI does.

The committed test fixtures named `*-nvr` are captures from this device, with
serial numbers and device ids removed; the others are synthetic, and each
says why it exists.

Contents: [Finding devices](#finding-devices-network-scan) ·
[Logins and lockout](#logins-and-lockout) ·
[Errors, write results and time limits](#errors-write-results-and-time-limits) ·
[Channels](#channels-analog-vs-ip-digital) ·
[Live snapshots](#live-snapshots) · [Motion detection](#motion-detection) ·
[Privacy masks](#privacy-masks) · [Event actions](#event-actions) ·
[Playback](#playback) · [Open questions](#open-questions)

## Finding devices (network scan)

Hikvision's own tools find devices with SADP (UDP multicast), which an
extension can't send, so the scan probes likely /24 subnets over HTTP
(`lib/network-scan.js`, `lib/device-probe.js`).

A device that answers an unauthenticated `GET /ISAPI/System/deviceInfo`
with 401 and a Digest challenge is a candidate. That alone is a weak
fingerprint: the DS-7604NI answers 401 Digest for any `/ISAPI` path, even one
that doesn't exist, its realm is an opaque 24-digit hex id rather than a
model, and routers, NAS boxes and other brands' cameras that protect every
page answer the same way. So each candidate is then asked
`GET /SDK/activateStatus`, also without credentials, as the web UI's login
page does before it shows (`getDeviceActiveStat`). The DS-7604NI answers
200 without a login:

```xml
<ActivateStatus version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<Activated>true</Activated>
</ActivateStatus>
```

- Root element `ActivateStatus` (by local name): a confirmed Hikvision, and
  `<Activated>` says whether it has been activated.
- Anything else (404, another body, no answer in time): the candidate stays
  listed as a possible Hikvision device. Older firmware may not have the
  endpoint, so it is never dropped.
- `Activated` false: the card says to activate it with SADP or its web page
  first. Until then it has no admin password, so no login works. Unverified:
  whether a device that isn't activated answers deviceInfo with 401 Digest at
  all, so such a device may not be found.

The scan never sends credentials (`credentials: 'omit'`), so a probe can't
count as a failed login. Connect asks the same question after a rejected
login the device didn't explain (no lock, no attempts left): when the device
says it isn't activated, the message says to activate it instead of asking
for another password.

Each address is tried on port 80 and on 8080, the usual alternative for a
device whose web port was moved, and the card shows the port it answered on
(an address that answers on both is listed once, on the port that confirmed
it, else on 80). The optional host permission `http://*/*` the scan asks for
covers both: a match pattern without a port matches every port. Both ports
go through the one pool of 48 probes, and an address with nothing on it costs
a whole probe timeout (1.2 s) per port. Measured with the test mock, a subnet
with nothing on it takes 11 timeouts (about 13 s) instead of 6 (about 7 s).
Subnets are tried in order (the last-used host's, then 192.168.0, .1, .2,
10.0.0, 10.0.1, then the defaults of AVM Fritz!Box 192.168.178, Asus
192.168.50, MikroTik 192.168.88 and many ISP routers 192.168.100), and the
scan stops after the first subnet with a device. So the extra time only falls
on subnets without one, and a scan that finds nothing anywhere takes about
2 minutes (before: five subnets on one port, about 36 s). The pool isn't
grown to win the time back, since that is what kept Chrome's socket pool and
the OS ARP queue from overflowing, which made real devices miss their timeout.
The whole subnet is tried on port 80 before 8080, so two connections to one
address never wait on the same ARP lookup.

## Logins and lockout

The device locks a computer (by IP address) out after a few failed logins,
typically for about 30 minutes, and while it is locked the right password is
refused too, also for iVMS and the web UI on that computer. The threshold
isn't readable on the DS-7604NI (`/ISAPI/Security/illegalLoginLock` answers
403 `notSupport`), so "a few" and "about 30 minutes" are general knowledge,
not measured.

On V4.75 every 401 carries a fresh nonce with `stale="FALSE"`, so a 401 for
an expired nonce and one for a wrong password look the same; only answering
the new challenge tells them apart, and that answer is another failed login
if the password is wrong. The device accepts a nonce it issued again later,
also on another connection, with a rising `nc`. So `digestFetch`
(`lib/digest-auth.js`) lets one request per credentials make that retry while
the others wait for it, then send with the challenge it proved, or fail
without sending: a password changed on the device costs each request already
on its way one failed login, plus one for the retry. The retry drops the
refused cached challenge first, so if it is cancelled (a live feed stopped)
or times out before its verdict, the waiting requests start over without
credentials (a challenge, no attempt) rather than each sending the refused
challenge again. Credentials the device rejected are never sent again until
the user presses Connect, and Connect and disconnect drop the cached
challenges, so Connect starts from an unauthenticated challenge (which costs
no attempt).

Connect logs in with `GET /ISAPI/Security/userCheck` first, like the web UI in
Digest mode and HCNetSDK (the DS-7604NI has `isSupportUserCheck`), then reads
`/ISAPI/System/deviceInfo`. An accepted userCheck answers `<statusValue>200`;
older firmware answers HTTP 200 with `<statusValue>401</statusValue>` for a
wrong password, which counts as a rejection only when that request carried
the credentials (`DigestResponse.authenticated`). Connect's userCheck goes
out without them, so firmware that answers it without a challenge says 401
to nobody in particular; that answer, like a device without userCheck (404,
403 `notSupport`), leaves the check to deviceInfo. Unauthenticated 401s
are an HTML page, but a rejected *credentialed* userCheck can explain itself
in XML (`statusValue`, `lockStatus` lock/unlock, `unlockTime` in seconds,
`retryLoginTime` = attempts left, `subStatusCode`), which the web UI turns into
"locked, try again in N min" or "N attempts left". `AuthError` carries the
same (`locked`, `unlockSeconds`, `attemptsLeft`) when a 401 body has them,
and the message says so. Not verified on the DS-7604NI, since it costs a
failed login: whether V4.75 sends that body, and whether it does for paths
other than userCheck.

The Digest client is MD5 only (`qop="auth"`, or none), which is what the
DS-7604NI asks for on HTTP and on RTSP. The web UI reads an optional
`WebCertificateCap algorithmType@opt`, so some firmware may let the web
Digest algorithm be set to SHA-256; no such device has been seen, and the
extension then fails with "Unsupported digest algorithm".

## Errors, write results and time limits

Error answers carry a `<ResponseStatus>` body (`statusCode`, `statusString`,
`subStatusCode`, sometimes `subStatusString`). Config documents use the
`isapi.org/ver20` namespace but error bodies from the DS-7604NI use
`hikvision.com/ver20`, and `/SDK/` endpoints answer in `urn:psialliance-org`
without a `subStatusCode`, so `lib/errors.js` matches by local name and also
accepts the JSON form. A path the NVR doesn't have answers
403 `notSupport`, not 404. `subStatusString` can mislead: a crossing motion
polygon got "Tag 32 is invalid (two root tags)".

A successful PUT or DELETE also returns a ResponseStatus. Like the web UI's
`response.js`, only `statusCode` 1 (OK) counts as success, and 7 means
"stored, but takes effect after a reboot", which the user is told; any other
code is a failure even with HTTP 200.

Endpoint fallbacks share one policy (`isFallbackError`): try the next URL on
404, 403 `notSupport`/`invalidOperation` and 400 `badXmlContent`/`badParameters`,
on a 403 or 400 without a body that says otherwise, and on a write answered
200 with `notSupport`/`invalidOperation`; stop on 401, `lowPrivilege`,
timeouts and network errors, and on 503 `serviceUnavailable`/`deviceBusy`
(an empty channel's snapshot answers 503).

503 `serviceUnavailable` ("Device Busy") isn't only "busy, try later": this
NVR also gives it, every time, for capability resources it doesn't serve
(`…/privacyMask/regions/capabilities`, `/ISAPI/Event/triggers/capabilities`),
and now and then for ones it does (`…/motionDetection/capabilities`). So a
document the extension can do without, such as the motion capabilities,
counts as absent after any error answer, not only after a "not here" one.

Every request has a time limit (`TIMEOUT_MS` in `lib/isapi.js`), as in
Hikvision's own clients (web UI 30 s per request, iVMS 3–30 s to connect):
8 s for each of Connect's requests, 10 s for other reads, 20 s for searches
and writes. The limit includes downloading the body, so full-size JPEGs (main
stream, stored pictures, stills from recordings) get 10 s and sub-stream
frames 5 s: an 8 MP frame of about 1.5 MB takes about 6 s over a 2 Mbps
remote link.

## Channels: analog vs. IP ("digital")

The web UI picks the URL by channel type. A channel is analog when
`channelId <= analogChannelCount`; on an NVR with only IP cameras every channel
is digital. The extension uses the same URLs, except where the table says.

| Setting | Analog channel | IP camera on an NVR |
|---|---|---|
| Motion config | `/ISAPI/System/Video/inputs/channels/{id}/motionDetection` | `/ISAPI/ContentMgmt/InputProxy/channels/{id}/video/motionDetection` |
| Motion capabilities | `/ISAPI/System/Video/inputs/channels/{id}/motionDetection/capabilities` | the same System URL; the extension asks `…/InputProxy/channels/{id}/video/motionDetection/capabilities` first |
| Motion layout capabilities | `…/inputs/channels/{id}/motionDetection/layout/capabilities` | `…/InputProxy/channels/{id}/video/motionDetection/layout/capabilities` |
| Privacy mask | `/ISAPI/System/Video/inputs/channels/{id}/privacyMask` | `/ISAPI/ContentMgmt/InputProxy/channels/{id}/video/privacyMask` |
| Event actions ("linkage") | `/ISAPI/Event/triggers/VMD-{id}` (both) | |
| Arming schedule (not used by the extension) | `/ISAPI/Event/schedules/motionDetections/VMD_video{id}` (both) | |
| Channel list | `/ISAPI/System/Video/inputs/channels` | `/ISAPI/ContentMgmt/InputProxy/channels` |
| Online state | `<videoInputEnabled>` in the channel list | `/ISAPI/ContentMgmt/InputProxy/channels/status` |

The DS-7604NI answers the analog channel list with 403 notSupport, but its
per-channel System URLs (motion, privacy) answer for the IP channels too,
with the same documents as the InputProxy ones.

The web UI always reads both channel lists and shows the analog inputs first,
then the IP cameras; HCNetSDK's ISAPI login reads both too and numbers the IP
channels after the analog ones. So a hybrid DVR (analog inputs plus IP
cameras) lists all of them, and the extension does the same
(`lib/channels.js`). As a guard it drops an IP entry whose id an analog input
already has, which no device seen so far does. No hybrid DVR was captured, so
the numbering is inferred from HCNetSDK.

Firmware with neither list still has the stream list
(`/ISAPI/Streaming/channels`), and the extension then lists a channel per
input the streams name. Each `StreamingChannel`'s `<Video>` names its input as
the web UI writes it: `<dynVideoInputChannelID>` for an IP camera,
`<videoInputChannelID>` for an analog input. That element gives the channel's
kind and number; a stream naming neither counts as an analog input numbered
by its id (101 and 102 are channel 1). On the DS-7604NI every stream names
`<dynVideoInputChannelID>` (1 for streams 101 and 102), and its
`<channelName>` is the stream's own number ("101"), not the camera's name,
which only the InputProxy list has. So a name that is only digits is left
out, and the channel is shown as "Channel N".

The web UI marks an IP camera online from `<online>` in each
`InputProxyChannelStatus` (it matches them to channels by position; the
extension matches by `<id>`), and an analog input online when
`<videoInputEnabled>` is empty or `true`. The status is only a label: when it
can't be read, every camera counts as online.

## Live snapshots

A channel's current frame is a JPEG at `/ISAPI/Streaming/channels/{id}01/picture`
(main stream) or `…/{id}02/picture` (sub stream). The web UI uses
`/ISAPI/ContentMgmt/StreamingProxy/channel/{id}{ss}/Picture` for IP cameras;
the DS-7604NI serves the same frame at `…/StreamingProxy/channels/{id}02/picture`
(plural, lower case), with `Content-Type: image/jpeg`. It answers the bare
channel ID (`/channels/1/picture`) with 400 `badXmlContent`, and a channel
without a camera with 503 `serviceUnavailable` within about 30 ms.

`lib/snapshots.js` tries, in order: the stream asked for, the main stream
(for a camera without a sub-stream), StreamingProxy for an IP camera, then
the bare ID. It keeps the first URL that serves a frame, so each later frame
is one request, and only looks again after 4 failed requests in a row. A URL
where the device answered with an error other than "not here" (503,
`lowPrivilege`) is kept too, as the next URLs would answer the same; a
successful answer that isn't a JPEG (no `FF D8` start) counts as "not here".
`digestFetch` reads an answer as bytes when its Content-Type is `image/*` or
its URL has `/picture` in any letter case.

While requests fail, the feed waits 0.5, 1, 2, 4, 8 s, then 10 s between them
(instead of a request every 200 ms, or three when every URL was tried each
time), and a frame resets it. After 2 failures in a row the view shows "No
signal" over the last frame, dimmed as stale. A camera the NVR lists offline
(`<online>false`) starts that way, with slow retries, but is still asked,
since the camera may be back. What the DS-7604NI answers for a disconnected
camera's snapshot hasn't been verified (no camera was unplugged); the mock
answers 503 like an empty channel.

### How often the picture changes

The DS-7604NI does not encode a JPEG per request. `/picture` serves a cached
704×576 still that it refreshes about once a second (new pictures 0.65–1.16 s
apart, mean ~1 s), the same bytes for `{id}01`, `{id}02` and StreamingProxy.
A request takes ~190 ms, so polling every 200 ms got the same picture 4–5
times in a row, and the old readout said "5 fps". Answers carry
`Cache-Control: no-cache` and `Connection: close` with no ETag or
Last-Modified, so there is no conditional GET; only comparing the bytes tells
a repeat. No polling scheme gets more than ~1 new picture a second out of it
(two requests in flight, or four channels in parallel, measured the same).
The refresh matches the cameras' main-stream I-frame interval (25 frames at
25 fps), but whether it follows it is unproven.

`lib/snapshot-pacer.js` therefore compares each answer with the feed's last
picture (length, then every byte) and drops repeats: they aren't decoded,
drawn or counted, and the fps readout is new pictures a second (per camera
in the grid). Once a feed sees repeats (2 of its last 5 answers), it waits
0.6 × the median time between new pictures (at least the feed's interval,
200 ms single / 500 ms grid, at most 1 s) after each new picture, then asks
every 150 ms until the picture changes (every 500 ms in a grid cell, which
never asks more often than that). Measured on the device with the single
view's timing: 1.1 new pictures a second from ~3 requests a second, against
5.2 for a fixed 200 ms. Simulated with the same refresh, a grid cell asks
~1.7 times a second instead of 2. A camera that sends a new picture every
time never repeats, so it keeps the fixed interval. Feeds stop asking while
the page is hidden and resume when it is shown.

### Picture size, HD and aspect

The DS-7604NI's plain `/picture` is 704×576 (~66 KB) on the main and the sub
stream alike, so asking `{id}01` for "HD" got the same picture as SD. The
cameras' streams are 2688×1520 (main) and 640×360 (sub), both 16:9
(`/ISAPI/Streaming/channels` lists every IP camera's streams; StreamingProxy
lists the same). The 704×576 still is the whole 16:9 picture squeezed (no crop,
no letterbox; the OSD text is narrow and tall), so shown at its own pixel
aspect everything looks 44 % too tall. With
`?videoResolutionWidth=W&videoResolutionHeight=H` (any size other than
704×576, 2688×1520 included) the NVR sends a 1920×1088 still instead
(~280–345 KB, ~250 ms), also refreshed about once a second; 704×576 asked
gives the plain still. Hikvision's web UI passes no size. These parameters
are documented ISAPI options, but other firmware may refuse or ignore them.

So, in the single view only (the grid stays on the plain sub-stream still,
4 × 66 KB), "HD" uses the sized URL where the plain main-stream still can't be
full size (`fullSizeUpgrade` in `lib/snapshots.js`): on an NVR's IP camera
(`digital` channel), or where the plain `{id}01` and `{id}02` stills have the
same size. A camera connected directly already serves its native main-stream
size on `{id}01`, so it keeps the plain URL. The size asked for is the
channel's own main stream (`{id}01` in the stream list, read once per device at
Connect; 1920×1080 when unknown), so a device that honours it isn't asked to
scale down. The check runs with the feed's first frame, also when the channel
answered 503 at first (a camera starting) and recovered later. The outcome is
remembered per channel until disconnect: a bigger still keeps the sized URL; a
refusal (404, 403 `notSupport`, 400 `badParameters`, any other 4xx), something
other than an image or a still no bigger than the plain one keeps the plain
URL. A timeout, a 503 (`serviceUnavailable`, `deviceBusy`) or another 5xx is
about the moment, so it decides nothing: that feed shows the plain still and
the channel's next feed checks again. The sized URL is still a `/picture` URL,
so it is read as bytes with the 10 s full-size time limit.

Every frame (single view, grid cells, playback stills) is shown at its
channel's main-stream aspect when its own differs from it by more than 3 %
(`displaySize` in `lib/picture-size.js`): the squeezed side is stretched
(704×576 → 1018.6×576 at 16:9), with CSS `aspect-ratio` and
`object-fit: fill`. The 1920×1088 still (0.2 % off 16:9) and the 1280×720
stored pictures are shown as they are, as is any frame when the stream list
can't be read. A squeeze never turns a picture, but a camera in corridor mode
does (by 90°) while the stream list keeps the landscape size it encodes, as
Hikvision's web UI knows (it swaps the listed width and height when
`/ISAPI/Image/channels/{ch}` has `Corridor/enabled`). So a still in the other
orientation than its stream is compared with the stream turned the same way:
a 1080×1920 still of a stream listed 1920×1080 is shown as it is, not
flattened into a 16:9 box.

The drawing canvas takes the picture's displayed size, as its pixels too
(`resizeCanvas` in `src/canvas.js`), so strokes, corner handles and labels
have their own size on screen: not stretched 1.45× wide over a 704×576 still
shown at 16:9, nor shrunk over a 1920×1088 still shown at 800 px. So the
canvas changes size with the frame (SD, HD, a 1280×720 stored picture in
Playback, which is cleared when Playback is left, or the default 300×150
before the first frame) and with the window. The motion and privacy tools
therefore keep their shapes as fractions of the picture (`lib/shapes.js`) and
use canvas pixels only to draw and hit-test. Device units come in only on
load and save (`motionRegionToImage`/`imageToMotionRegion`,
`privacyRegionToImage`/`imageRectToPrivacy` in `lib/config-xml.js`), so a
frame of another size between loading, drawing and saving moves nothing.

### Live video streams

Hikvision's own apps play smooth video by decoding the continuous stream,
which the DS-7604NI offers only over RTSP (port 554) and its private SDK port
(8000). A browser extension page can open neither, so the extension stays
with snapshots. What was measured, for a client that can:

- `rtsp://{host}:554/ISAPI/Streaming/channels/{id}01` (main) and `…{id}02`
  (sub), with Digest MD5 without `qop`. Both are H.265 at 25 fps. The sub
  stream is ~250 kbit/s, Main profile level 5.1 (`hev1.1.6.L153` for
  WebCodecs); the main stream is ~3.9 Mbit/s with SVC (temporal layers), and
  channel 1's also carries PCMU audio. The SDP has no `sprop-*` parameter
  sets, so VPS/SPS/PPS come in band before the first IDR, and RTP packets
  carry padding.
- Nothing on port 80 carries video: an RTSP-over-HTTP tunnel request gets a
  plain 200 XML answer, `httpPreview` answers 403 `notSupport`,
  `/ISAPI/Security/adminAccesses` lists no WebSocket protocol, and
  `/SDK/play/{n}/004` (the web plugin's path, `isSupportHttpPlay` true)
  answered a bare request with 400 after 6–8 s; its request format is
  unknown.

## Motion detection

### Region or grid mode

`motionDetection/capabilities` advertises `<regionType opt="…">`. If it offers
both `region` and `grid`, the web UI draws polygons ("multi-region"); otherwise it
uses the 22×18 cell grid. iVMS-4200 has no polygons at all: it edits motion
as a grid over the private SDK (`NET_DVR_PICCFG_V40`: 22 columns, 18 rows
for PAL or 15 for NTSC, sensitivity 0–5).

- **Where the capabilities come from.** The web UI reads them from the System
  URL for every channel (`discardFalseAlarmCap` in `websdk.js`). The extension
  asks an IP camera's InputProxy URL first, next to its motion config, then
  the System one (`Isapi.getMotionCapabilities`). The DS-7604NI serves the
  same document at both, and either can answer 503 now and then. Any error
  answer, a body that isn't XML, or a 200 answer whose root isn't
  `MotionDetection` (`MotionDetectionLayout` for the layout capabilities),
  such as a `ResponseStatus`, counts as not having them, so the next URL is
  tried; the DS-7604NI never answered that way.
- **Without capabilities** the web UI hides the sensitivity slider and
  follows the motion document's own `regionType` (`bSupportMulRegion` stays
  false): its grid editor for `grid`, whose save changes only `gridMap`; its
  legacy ROI editor for `region` (below); no editor for `none`. The extension
  edits the grid when the document has `Grid` granularity and a `gridMap` and
  its `regionType` is `grid` or missing (`motionEditMode`): saving polygons
  sets `regionType` region and zeroes `gridMap`, which on a grid-only camera
  would wipe the detection area. A document with a grid in any other mode,
  such as polygons saved in region mode (`gridMap` zeroed), is shown
  read-only and its area sent back as loaded: editing that grid would switch
  the camera to grid mode with nowhere to detect. Polygons only for a
  document without a grid.
- **Sensitivity levels**: `sensitivityLevel@min/max/step` in the capabilities,
  else in `…/motionDetection/layout/capabilities` (the web UI's `motionCapa`,
  where it always reads them; 0–100 step 20 on the DS-7604NI). The layout's
  own level is read first (`MotionDetectionLayout > sensitivityLevel`, the
  root's child in the layout capabilities), then the first other one that
  states min and max, so a per-region level can't set the steps. With neither,
  the slider is locked and the stored level is sent back unchanged, never
  snapped to a guessed step: the DS-7604NI stores a level between steps as the
  step below (37 became 20).
- **Region without grid is the legacy ROI mode.** When `regionType@opt` offers
  `region` but not `grid`, the web UI doesn't draw polygons: it shows the
  stored regions as rectangles scaled by `normalizedScreenWidth/Height`
  (`transRegionToPlugin`) and writes the plugin's coordinates back in those
  units. No device seen so far uses this mode, so its scale and Y direction
  are unverified. The extension uses polygons only when the capabilities offer
  both, and shows the regions read-only ("Editing regions isn't supported for
  this camera yet") for region-only cameras and for any motion document that
  declares a coordinate space other than 1000, instead of saving them at an
  assumed scale. Saving then sends the area (`regionType`, `gridMap`,
  `RegionList`) back as loaded, with the other settings changed.
- **How many polygons**: `MotionDetectionLayout > layout > RegionList@size` in
  the capabilities (4 on the DS-7604NI; 4 when unknown).
- **How many corners**: `MotionDetectionLayout > regionEdgesNum@min` to
  `@max` (4–10 on the DS-7604NI, which stores a 4-corner region on channel 3
  and a 10-corner one on channel 4; 3–10 when unknown). Without the
  capabilities the extension reads `regionEdgesNum` and `targetType@opt` from
  the layout capabilities, which state them on the DS-7604NI too. The web UI passes
  `@max + 1` (else 5) to its drawing plugin as `PointNumMax`, with
  `MinClosed` 5: those are plugin click counts, which include the click that
  closes the polygon, not corner counts.

### Saving regions

- **Polygons**: the save removes every `<Region>`, appends the new ones to
  `RegionList` as `<Region xmlns="">`, sets `RegionList@size`, sets
  `regionType` to `region` and zeroes `gridMap`. The device rasterizes the
  polygons into the grid itself and then reads back `regionType` grid, with
  a `gridMap` of every cell the polygons overlap (cells covered by less than
  about 0.2 % may be left out). On the DS-7604NI a polygon over the left
  half (X 0–500) became the left 11 of 22 columns, and one over the top
  quarter (Y 750–1000) the top 5 of 18 rows.
- **A motion PUT can merge regions by id**, like privacy masks. Verified on the
  DS-7604NI: PUTting the device's own document back (`regionType` grid,
  `<RegionList>` without `size`, holding region 1 only) kept a stored region 2.
  The extension's save (`regionType` region, `gridMap` zeroed,
  `<RegionList size="N">` with exactly N `<Region xmlns="">`) replaces the
  list, so a deleted region is really gone. Keep those three parts when
  changing the save, and don't restore a motion backup by PUTting it as-is if
  regions were added since.
- **Grid mode**: only `gridMap` changes. It's 18 rows × 6 hex digits; each row
  is 24 bits, MSB first, and only the first 22 bits (columns) are used. Row 0
  is the top of the picture.
- **Polygons whose edges cross aren't saved.** Before saving, the web UI runs
  `drawTools.checkLine` on each polygon (every pair of edges that don't share a
  corner, through `intersectLineLine`) and stops with "Region is invalid, no
  crossing line is allowed". Its test also rejects any two edges on one line,
  even when they don't meet (a U standing on two feet). The DS-7604NI refuses
  a crossing polygon itself: a bow tie got HTTP 500, `statusCode` 3
  `deviceError`, and nothing was stored. The extension refuses a crossing,
  touching or overlapping outline (`isSimplePolygon` in `lib/shapes.js`) when
  a region is closed and, for stored regions, on save, but accepts such a U.
  An outline whose corners all lie on one line or one spot (`hasArea`) is
  refused with its own message, so a stored placeholder region is reported
  as having no area, to delete or redraw, rather than as crossing.

Because every save reads back as grid, a document can't tell whether its
`gridMap` came from its polygons or was edited as a grid elsewhere, e.g. in
iVMS. On the DS-7604NI every channel's grid matches its polygons. Whether the
NVR keeps the old polygons after a grid edit over the private SDK is
untested; if it does, the extension (like the web UI, which also draws the
stored polygons and overwrites the grid on save) shows those polygons, and a
save replaces the grid with their area.

### Coordinates

`drawTools.translateSceneXml` converts device ↔ normalized coordinates with a
**fixed scale of 1000**: `device / 1000` to draw, `clamp(0, 1000, trunc(normalized * 1000))`
to save. The device's Y axis starts at the **bottom** of the image. This was
confirmed by rasterizing each stored polygon against the device's own
`gridMap`, any overlap counting: with Y flipped, 395, 395, 396 and 396 of 396
cells match on channels 1–4 (the two misses are slivers under 0.2 %);
without the flip, only 367, 155 and 256 on channels 1, 2 and 4 (channel 3's
region is the whole picture). The write tests above agree.

### Detection target (person / vehicle)

Stored in `MotionDetectionLayout > targetType` as a comma-separated list of
enabled types, e.g. `human`, `human,vehicle`, or empty. The allowed values are
in `targetType@opt` in the capabilities. If the element is missing, the UI
creates one with no namespace, which serializes as `<targetType xmlns="">`.

The web UI shows a checkbox for every `targetType@opt` value and writes the
ticked ones in that order. The extension's panel has only Person (`human`)
and Vehicle (`vehicle`), so on save it keeps every other target the camera
had on (`mergeTargetTypes`): in the capabilities' order, then any the
capabilities don't list. The DS-7604NI offers exactly `human,vehicle`.

No device was seen sending `TargetDetection`/`detectionTarget` blocks in a
motion document (the web UI uses `detectionTarget` only as a label), so the
extension reads and writes only the layout's `targetType`.

### Dynamic analysis

"Dynamic Analysis for Motion" (the web UI's `enableHighLight` label; iVMS
calls it "Enable Motion Dynamic Analysis") is the root `<enableHighlight>`
of the motion document. It marks moving objects in live view. The capabilities
offer it as `<enableHighlight opt="true,false">`. `eventMotion.js` shows the
checkbox only when the document has the field and saves it in place; the
DS-7604NI sends it on every channel and keeps a written value.

`enableDynamicAnalysis` is a different setting ("Enable Dynamic Analysis for
Face Detection") and isn't part of motion documents.

## Privacy masks

The web UI (`config/image/privacyMask.js`) and write tests on the DS-7604NI
(IP channel 3) agree on these:

- **Coordinates** are in the document's `normalizedScreenSize` units (704×576
  here; the web UI assumes 704×576 when the size is missing), stretched over
  the whole picture, with Y measured from the **bottom**. A region at
  `positionY` 432–576 masked the top quarter of the image. The web UI converts
  with `1 - positionY / height`, like motion regions. The camera overlays
  (`…/video/overlays`, 704×576 in the older `hikvision.com` namespace) count
  Y from the bottom too. The extension clamps saved rectangles to the screen.
- **The per-region `<enabled>` flag does nothing on this NVR.** Every stored
  region reads back with `<enabled>false</enabled>`, and a region sent with
  `enabled=false` still masks. Only the root `<enabled>` switches masking on
  and off. The web UI ignores the per-region flag when it loads and writes the
  root value into every region when it saves. The extension does the same and
  shows every region that has an area.
- **PUT `/privacyMask` merges regions by id.** A region left out of the list
  stays stored and keeps masking, so a PUT alone can't remove a mask.
- **DELETE `{base}/privacyMask/regions` clears every region** (statusCode 1,
  with base = `/ISAPI/ContentMgmt/InputProxy/channels/{id}/video` for IP
  channels). A PUT after it stores exactly its list. The web UI saves this
  way: its `tamperRegion` request is a DELETE in `websdk.js`, followed by a
  PUT of the rebuilt list (ids 1..n, each `id`, `enabled`,
  `RegionCoordinatesList`, no `maskType`).

`Isapi.savePrivacyMask` follows the same sequence. If the PUT fails after the
DELETE, it PUTs the document as loaded back, so the camera isn't left without
masks. Firmware that can't DELETE the regions, such as cameras with fixed mask
slots, answers "not here" or `methodNotAllowed`. For that firmware the
extension sends a single PUT instead: unused slots are disabled and their
coordinates emptied, so a deleted mask can't come back. That firmware's
behaviour is unverified: no standalone camera was tested.

Only when `{base}/privacyMask` itself answers "not here" (`isFallbackError`)
does `Isapi.getPrivacyMask` read `{base}/privacyMask/regions` instead. A busy
answer, a refusal, a timeout or a network error is the load's error, to be
retried: this NVR answers some privacy sub-resources 503 "Device Busy" every
time, and the region list is no substitute for the full document. That list
is a bare `<PrivacyMaskRegionList>` (the DS-7604NI serves one too) without the
root `<enabled>`, the only switch that turns masking on and off, and a save
can't add one. So with that document the panel's switch is disabled, saying
"This device doesn’t let the extension switch masks on or off", and every
mask it shows is saved with its own `<enabled>` on, where firmware honours
that flag at all. The list goes back to its own path in a single PUT, without
a DELETE.

## Event actions

Motion linkage is the trigger `/ISAPI/Event/triggers/VMD-{id}` (GET and PUT,
`motionLink` in `websdk.js`). Each `<EventTriggerNotification>` is one action.
The web UI (`eventMotion.js`) and write tests on the DS-7604NI (`VMD-3`)
agree on these:

- **Which actions a device offers.** `/ISAPI/Event/triggersCap` >
  `MotionDetectionTriggerCap` flags them: `isSupportRecord`, `isSupportCenter`,
  `isSupportEmail`, `isSupportBeep`, `isSupportIO`, `isSupportWhiteLightOut`,
  `isSupportAudioOut`, plus `isSupportIOOutputUnify`. The web UI shows only the
  flagged actions; the extension disables the others ("Not supported by this
  device"). Without triggersCap, or without that block, every action is
  offered. The per-trigger `…/VMD-1/capabilities` answers 403
  `notSupport` on the NVR.
- **Record is per channel**: `<id>record-{ch}</id>`, method `record`, and
  `<dynVideoInputID>{ch}</dynVideoInputID>` for an IP channel (`videoInputID`
  for analog; new entries follow the trigger's own `videoInputChannelID` /
  `dynVideoInputChannelID`). A trigger can also record other channels (the web
  UI offers every channel), so the toggle reads and writes only this channel's
  entry and leaves other `record-N` links alone.
- **center, email, beep**: the method name is also the `<id>`.
- **Alarm output**: `<id>IO-{port}</id>`, method `IO`, and
  `<outputIOPortID>` for the device's own ports (or every port when
  `isSupportIOOutputUnify`), `<dynOutputIOPortID>` for an IP camera's port.
  - The outputs: when `/ISAPI/System/IO/outputs/capabilities` mentions
    `IOType`, `/ISAPI/System/IO/outputs` lists every port with its `IOType`
    (`local`, `digitalChannel`, `analogChannel`). Otherwise the device's own
    ports are `/ISAPI/System/IO/outputs` and its IP cameras' are
    `/ISAPI/ContentMgmt/IOProxy/outputs`. Ports with `IOUseType` `whiteLight`
    or `audio` stand for a camera's light or speaker and are left out, as are
    analog ports marked `disable`. A digital port marked `disable` is still a
    relay.
  - The DS-7604NI has no relay of its own (`IOOutputPortNums` 0). Its relays
    are its cameras': 301 on channel 3's camera and 401 on channel 4's, matched
    by `IODescriptor/ipAddress` against the channel's InputProxy `ipAddress`.
    302/303 and 402/403 are the light and speaker pseudo ports.
  - The extension switches the channel's own camera relay, else the device's
    first local output (cameras), else disables the toggle ("This camera has no
    alarm output"). Turning it off removes only that port's entry.
  - Write tests: `IO-301` with `dynOutputIOPortID` was stored. `IO-1` with
    `outputIOPortID` 1, which older versions wrote, was accepted too, but port
    1 doesn't exist, so it linked to nothing.
- **White light and audio alarm on an NVR**:
  `<id>whiteLightOut-{ch}</id><notificationMethod>whiteLightOut</notificationMethod><lightAudioOutID>{ch}</lightAudioOutID>`,
  and the same with `audioOut`. Only for the channels listed by
  `/ISAPI/Event/triggers/notifications/channels/whiteLightAlarm?format=json`
  (`WhiteLightAlarmList[].channelID`) and `…/AudioAlarm?format=json`
  (`AudioAlarmList[]`): channels 3 and 4 here. Both shapes were stored in
  write tests. A bare `<notificationMethod>whiteLight</notificationMethod>` or
  `audio`, which older versions wrote, fails the whole PUT with 400
  `badXmlContent` ("Tag 16 is invalid (two root tags)"). A device whose
  triggersCap names either `*Out` flag never gets a bare name: a light or
  speaker flag it leaves out disables that toggle. Devices that name neither
  still get the bare names; that is unverified, since no standalone camera has
  been tested.
- **`notificationRecurrence`**: the NVR accepts it on a record entry but drops
  it, and neither the NVR, its web UI nor the SDK writes it. New entries copy
  it only when the trigger's own entries carry it (camera firmware).

triggersCap, the outputs and the light and speaker lists describe the hardware,
so the extension reads them once per connection (`Isapi.getEventActionSupport`).
One that answers an error other than "not here" (e.g. 503 busy), or a body
that isn't XML, counts as absent for that load only. A save goes to
`/ISAPI/Event/triggers/{id of the loaded trigger}`. When the per-trigger GET
isn't there, the trigger is picked out of `/ISAPI/Event/triggers` by
`videoInputChannelID`, `dynVideoInputChannelID` or id `VMD-{ch}`.

## Playback

### Search paging

`POST /ISAPI/ContentMgmt/search` pages its results, and the DS-7604NI
doesn't page the way the request suggests:

- **A page holds at most 64 matches**, however many `maxResults` asks for
  (100 and 200 both returned 64; 40 returned 40). It honours
  `searchResultPostion` exactly: position 64 starts with the 65th match.
- **`numOfMatches` can't be trusted.** For a video search it is the total (139
  on every page of one search); for a picture search (track `…03`) it is only
  that page's count.

So `Isapi.searchMatches` asks for 50 a page (the web UI's download page asks
for 50, iVMS for 40) and starts each page after the matches it has received,
ignoring `numOfMatches`. It stops when the status isn't `MORE`, or when a page
brings no match it hasn't seen (an empty page, or firmware that ignores the
position), and after 40 requests at most. Matches are de-duplicated by
`playbackURI`. Stepping by 100, as the extension used to, skipped matches
64–99: about 22 hours of a three-day search here.

### Record types

The record type is the last part of each match's `metadataDescriptor`. iVMS
and the web UI's timebar give scheduled recording (`timing`, `CMR`), `manual`
and `command` (started by a platform or alarm host) a colour each, and draw
events (`motion`, `alarm`, `motionOrAlarm`, `smart` and any type they don't
recognise) in their alarm colour. The extension sorts recordings into the same
four kinds (`recordKind` in `lib/playback.js`; `personOrVehicel` is an event).
Manual and command recordings are not events, so the events-only filter leaves
them out. The DS-7604NI records on a schedule and only ever returns `timing`.

### Device time and days

Search times, results and recorded-frame `starttime` values are the device's
wall-clock time with a `Z` suffix: `2026-10-25T12:00:00Z` is 12:00 on the
NVR's clock, not UTC. iVMS sends the fields as they are (zero time
difference), and the web UI searches whole days of them.

The extension used to hold these as browser-local `Date`s and measure a day as
24 hours of elapsed time from local midnight. On a daylight-saving changeover
day that is wrong: with the browser in Europe/Prague, 2026-10-25 lasts 25 hours,
so the search ended at 22:59:59 (the last hour of recordings was never shown)
and 12:00 was drawn at 13:00; on 2027-03-28 (23 hours) the search ran to 00:59
the next day, everything after 02:00 was drawn an hour early, and a recording
at 02:30 (a time Prague skips) was shown at 03:30. A browser in another zone
than the NVR couldn't reach the NVR's newest day either, because "today" and
the date picker's limit followed the browser's date.

So device times are "floating" Dates (`lib/device-time.js`): the wall-clock
fields stored as if they were UTC and read only in UTC. A day is then always
00:00:00–23:59:59 and 12:00 is half-way along the timeline, in any zone. Tests
run this in Europe/Prague and America/New_York on both zones' changeover days
(`tests/timezones`).

"Today" is the device's. Playback reads `<localTime>` from `GET
/ISAPI/System/time` once per connection, keeps how far that is from the
browser's wall clock, and allows days up to the device's today, even when that
is the browser's tomorrow. Only the wall-clock part counts: the DS-7604NI
answered `2026-10-10T13:23:07+01:00` at 13:23 CEST, an offset that
leaves daylight saving out (its `<timeZone>` is
`CST-1:00:00DST01:00:00,M3.5.0/02:00:00,M10.5.0/02:00:00`), so no offset is
ever used. A device that refuses the request (or has no `<localTime>`) leaves
"today" to the browser's clock.

### Month calendar

`POST /ISAPI/ContentMgmt/record/tracks/{id}01/dailyDistribution` answers for a
whole month (about 2.8 KB on the DS-7604NI: every day of the month, each with
`<record>` true or false and `<recordType>time` on recorded days), so it is
asked for once per channel and month, as the web UI does (it asks again only
when the month changes), not with every day's search. Only the device's
current month can still gain days, so its answer is asked for again after 5
minutes. Changing the channel or reconnecting starts afresh.

### Stored pictures

A picture search (track `…03`) gives each picture a `playbackURI` such as
`http://192.168.0.108/picture/Streaming/tracks/103/?starttime=…&name=…&size=…`.
The address in it is the `Host` header the search was sent with, echoed back
(a search sent as `192.168.0.108.` got URIs on `192.168.0.108.`), not
necessarily the address the user typed: browsers lower-case it, a proxy may
rewrite it, and other firmware may write its own LAN address. The web UI's
`download.js` keeps only the part from `/picture` on and requests it from the
address it is connected to. The extension does the same
(`storedPicturePath` in `lib/playback.js`): it requests the URI's path and
query from the connected device, whatever scheme, host and port the URI
names, and only when the path, with `.`/`..` segments resolved, starts with
`/picture/`. It used to refuse any URI whose host wasn't exactly the one
typed, so a hostname typed in capitals got no pictures. The DS-7604NI's
stored pictures are 1280×720.

### Stills from recordings

`…/channels/{id}01/picture?starttime=…` (StreamingProxy, then Streaming)
isn't documented ISAPI. The DS-7604NI accepts the parameter but ignores it
and sends the live picture. So before offering Play, the extension asks for a
moment in 2000, long before any recording (`Isapi.ignoresRecordedFrameTime`):
a device that honours the time can't return an image for it. On the
DS-7604NI Play is therefore disabled and the timeline only shows where
recordings are. No firmware that honours the time has been tested.

## Open questions

Unverified, each described in its section above:

- Whether V4.75 explains a rejected credentialed login (lock, attempts left)
  in XML. Finding out costs a failed login.
- Whether a device that isn't activated answers deviceInfo with 401 Digest,
  so that the scan finds it.
- What a disconnected camera's snapshot answers on the NVR, and whether the
  ~1 s snapshot refresh is the cameras' I-frame interval.
- Region-only (legacy ROI) motion: its coordinate scale and Y direction.
- Whether the NVR keeps stale polygons after a grid edit in iVMS.
- Standalone cameras: bare `whiteLight`/`audio` action names, and privacy
  masks in fixed slots without DELETE.
- A hybrid DVR's channel numbering, a device that requires SHA-256 Digest,
  and the request format of `/SDK/play`.
