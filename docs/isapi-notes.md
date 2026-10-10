# ISAPI notes: how Hikvision's own web UI configures motion detection

Reverse-engineered from the NVR's built-in web UI (web version V4.0.1 build 231207,
WebComponents plugin V3.0.7.500), served from `/doc/script/` on the device:
`config/event/eventMotion.js`, `config/drawTools.js`, `isapi/websdk.js`.
The UI needs the Windows plugin to draw regions, which is why it only works in
Internet Explorer.

## Analog vs. IP ("digital") channels

The UI picks the URL by channel type. A channel is analog when
`channelId <= analogChannelCount`; on an NVR with only IP cameras every channel
is digital.

| Setting | Analog channel | IP camera on an NVR |
|---|---|---|
| Motion config | `/ISAPI/System/Video/inputs/channels/{id}/motionDetection` | `/ISAPI/ContentMgmt/InputProxy/channels/{id}/video/motionDetection` |
| Motion layout capabilities | `…/inputs/channels/{id}/motionDetection/layout/capabilities` | `…/InputProxy/channels/{id}/video/motionDetection/layout/capabilities` |
| Motion capabilities | `/ISAPI/System/Video/inputs/channels/{id}/motionDetection/capabilities` (both) | |
| Privacy mask | `/ISAPI/System/Video/inputs/channels/{id}/privacyMask` | `/ISAPI/ContentMgmt/InputProxy/channels/{id}/video/privacyMask` |
| Event actions ("linkage") | `/ISAPI/Event/triggers/VMD-{id}` (both) | |
| Arming schedule | `/ISAPI/Event/schedules/motionDetections/VMD_video{id}` (both) | |
| Channel list | `/ISAPI/System/Video/inputs/channels` | `/ISAPI/ContentMgmt/InputProxy/channels` |
| Online state | `<videoInputEnabled>` in the channel list | `/ISAPI/ContentMgmt/InputProxy/channels/status` |

The web UI always reads both channel lists and shows the analog inputs first,
then the IP cameras; HCNetSDK's ISAPI login reads both too and numbers the IP
channels after the analog ones. So a hybrid DVR (analog inputs plus IP
cameras) lists all of them, and the extension does the same. As a guard it
drops an IP entry whose id an analog input already has, which no device seen
so far does. The DS-7604NI answers the analog list with 403 notSupport.

The web UI marks an IP camera online from `<online>` in each
`InputProxyChannelStatus` (it matches them to channels by position; the
extension matches by `<id>`), and an analog input online when
`<videoInputEnabled>` is empty or `true`. The status is only a label: when it
can't be read, every camera counts as online.

## Region vs. grid mode

`motionDetection/capabilities` advertises `<regionType opt="…">`. If it offers
both `region` and `grid`, the UI draws polygons ("multi-region"); otherwise it
uses the 22×18 cell grid.

- Max polygons: `MotionDetectionLayout > RegionList@size` in capabilities (default 4).
- Max points per polygon: `MotionDetectionLayout > regionEdgesNum@max` + 1 (default 5).
- Saving polygons: removes every `<Region>`, appends the new ones to `RegionList`,
  sets `RegionList@size` and sets `regionType` to `region`. The device rasterizes
  the polygons into `gridMap` itself.
- Saving grid mode: only `gridMap` changes. It's 18 rows × 6 hex digits; each row
  is 24 bits, MSB first, and only the first 22 bits (columns) are used.

## Coordinates

`drawTools.translateSceneXml` converts device ↔ normalized coordinates with a
**fixed scale of 1000**: `device / 1000` to draw, `clamp(0, 1000, trunc(normalized * 1000))`
to save. The device's Y axis starts at the **bottom** of the image. This was
confirmed by rasterizing a stored polygon against the device's own `gridMap`:
379/396 cells match with Y flipped, versus 365/396 without the flip.

## Detection target (person / vehicle)

Stored in `MotionDetectionLayout > targetType` as a comma-separated list of
enabled types, e.g. `human`, `human,vehicle`, or empty. The allowed values are
in `targetType@opt` in the capabilities. If the element is missing, the UI
creates one with no namespace, which serializes as `<targetType xmlns="">`.

No device was seen sending `TargetDetection`/`detectionTarget` blocks in a
motion document (the web UI uses `detectionTarget` only as a label), so the
extension reads and writes only the layout's `targetType`.

## Dynamic analysis

"Dynamic Analysis for Motion" (the web UI's `enableHighLight` label; iVMS
calls it "Enable Motion Dynamic Analysis") is the root `<enableHighlight>`
of the motion document. It marks moving objects in live view. The capabilities
offer it as `<enableHighlight opt="true,false">`. `eventMotion.js` shows the
checkbox only when the document has the field and saves it in place; the
DS-7604NI sends it on every channel and keeps a written value.

`enableDynamicAnalysis` is a different setting ("Enable Dynamic Analysis for
Face Detection") and isn't part of motion documents.

## Event actions

Motion linkage is the trigger `/ISAPI/Event/triggers/VMD-{id}` (GET and PUT,
`motionLink` in `websdk.js`). Each `<EventTriggerNotification>` is one action.
The web UI (`eventMotion.js`) and write tests on the DS-7604NI (V4.75.206,
`VMD-3`) agree on these:

- **Which actions a device offers.** `/ISAPI/Event/triggersCap` >
  `MotionDetectionTriggerCap` flags them: `isSupportRecord`, `isSupportCenter`,
  `isSupportEmail`, `isSupportBeep`, `isSupportIO`, `isSupportWhiteLightOut`,
  `isSupportAudioOut`, plus `isSupportIOOutputUnify`. The web UI shows only the
  flagged actions; the extension disables the others ("Not supported by this
  device"). Without triggersCap, or without that block, every action is
  offered as before. The per-trigger `…/VMD-1/capabilities` answers 403
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
so the extension reads them once per connection. One that answers an error
other than "not here" (e.g. 503 busy), or a body that isn't XML, counts as
absent for that load only. A save goes to
`/ISAPI/Event/triggers/{id of the loaded trigger}`. When the per-trigger GET
isn't there, the trigger is picked out of `/ISAPI/Event/triggers` by
`videoInputChannelID`, `dynVideoInputChannelID` or id `VMD-{ch}`.

## Privacy masks

The web UI (`config/image/privacyMask.js`) and write tests on the DS-7604NI
(firmware V4.75.206, IP channel 3) agree on these:

- **Coordinates** are in the document's `normalizedScreenSize` units (704×576
  here; the web UI assumes 704×576 when the size is missing), stretched over
  the whole picture, with Y measured from the **bottom**. A region at
  `positionY` 432–576 masked the top quarter of the image. The web UI converts
  with `1 - positionY / height`, like motion regions.
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
coordinates emptied, so a deleted mask can't come back.

## Playback search

`POST /ISAPI/ContentMgmt/search` pages its results, and the DS-7604NI
(firmware V4.75.206) doesn't page the way the request suggests:

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

The record type is the last part of each match's `metadataDescriptor`. iVMS
and the web UI's timebar give scheduled recording (`timing`, `CMR`), `manual`
and `command` (started by a platform or alarm host) a colour each, and draw
events (`motion`, `alarm`, `motionOrAlarm`, `smart` and any type they don't
recognise) in their alarm colour. The extension sorts recordings into the same
four kinds (`recordKind` in `lib/playback.js`; `personOrVehicel` is an event).
Manual and command recordings are not events, so the events-only filter leaves
them out. This NVR records on a schedule and only ever returns `timing`.

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
(V4.75) answered `2026-10-10T13:23:07+01:00` at 13:23 CEST, an offset that
leaves daylight saving out (its `<timeZone>` is
`CST-1:00:00DST01:00:00,M3.5.0/02:00:00,M10.5.0/02:00:00`), so no offset is
ever used. A device that refuses the request (or has no `<localTime>`) leaves
"today" to the browser's clock.

### Month calendar

`POST /ISAPI/ContentMgmt/record/tracks/{id}01/dailyDistribution` answers for a
whole month (about 2.8 KB), so it is asked for once per channel and month, as
the web UI does (it asks again only when the month changes), not with every
day's search. Only the device's current month can still gain days, so its
answer is asked for again after 5 minutes. Changing the channel or
reconnecting starts afresh.

## Errors and write results

Error answers carry a `<ResponseStatus>` body (`statusCode`, `statusString`,
`subStatusCode`, sometimes `subStatusString`). Config documents use the
`isapi.org/ver20` namespace but error bodies from the DS-7604NI use
`hikvision.com/ver20`, and `/SDK/` endpoints answer in `urn:psialliance-org`
without a `subStatusCode`, so `lib/errors.js` matches by local name and also
accepts the JSON form. A path the NVR doesn't have answers
403 `notSupport`, not 404.

A successful PUT or DELETE also returns a ResponseStatus. Like the web UI's
`response.js`, only `statusCode` 1 (OK) counts as success, and 7 means
"stored, but takes effect after a reboot"; any other code is a failure even
with HTTP 200.

Endpoint fallbacks share one policy (`isFallbackError`): try the next URL on
404, 403 `notSupport`/`invalidOperation` and 400 `badXmlContent`/`badParameters`
(and on a write answered 200 with `notSupport`/`invalidOperation`);
stop on 401, `lowPrivilege`, timeouts and network errors, and on 503
`serviceUnavailable`/`deviceBusy` (an empty channel's snapshot answers 503).

503 `serviceUnavailable` ("Device Busy") isn't only "busy, try later": this
NVR also gives it, every time, for capability resources it doesn't serve
(`…/privacyMask/regions/capabilities`, `/ISAPI/Event/triggers/capabilities`).
So a document the extension can do without, such as the motion capabilities,
counts as absent after any error answer, not only after a "not here" one.

Every request has a time limit (`TIMEOUT_MS` in `lib/isapi.js`), as in
Hikvision's own clients (web UI 30 s per request, iVMS 3–30 s to connect).
The limit includes downloading the body, so full-size JPEGs (main stream,
stored pictures, stills from recordings) get 10 s and sub-stream frames 5 s:
an 8 MP frame of about 1.5 MB takes about 6 s over a 2 Mbps remote link.

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
(two requests in flight, or four channels in parallel, measured the same);
smooth video needs the RTSP stream, which a browser page can't open.

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
scale down. The outcome is remembered per channel until disconnect: a bigger
still keeps the sized URL; an error answer, something other than an image or
a still no bigger than the plain one keeps the plain URL. A timeout decides
nothing. The sized URL is still a `/picture` URL, so it is read as bytes with
the 10 s full-size time limit.

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
flattened into a 16:9 box. The drawing canvas follows the displayed size; its pixels stay
the frame's. So the canvas changes size with the frame: 704×576 SD, 1920×1088
HD, a 1280×720 stored picture in Playback (cleared when Playback is left), or
the default 300×150 before the first frame. The motion and privacy tools
therefore keep their shapes as fractions of the picture (`lib/shapes.js`) and
use canvas pixels only to draw and hit-test. Device units come in only on
load and save (`motionRegionToImage`/`imageToMotionRegion`,
`privacyRegionToImage`/`imageRectToPrivacy` in `lib/config-xml.js`), so a
frame of another size between loading, drawing and saving moves nothing.

## Logins and lockout

The device locks a computer (by IP address) out after a few failed logins,
typically for about 30 minutes, and while it is locked the right password is
refused too, also for iVMS and the web UI on that computer. The threshold
isn't readable on the DS-7604NI (`/ISAPI/Security/illegalLoginLock` answers
403 `notSupport`).

On V4.75 every 401 carries a fresh nonce with `stale="FALSE"`, so a 401 for
an expired nonce and one for a wrong password look the same; only answering
the new challenge tells them apart, and that answer is another failed login
if the password is wrong. The device accepts a nonce it issued again later,
also on another connection, with a rising `nc`. So `digestFetch` lets one
request per credentials make that retry while the others wait for it, then
send with the challenge it proved, or fail without sending: a password changed
on the device costs each request already on its way one failed login, plus one
for the retry. The retry drops the refused cached challenge first, so if it
is cancelled (a live feed stopped) or times out before its verdict, the
waiting requests start over without credentials (a challenge, no attempt)
rather than each sending the refused challenge again. Credentials the
device rejected are never sent again until the user presses Connect, and
Connect and disconnect drop the cached challenges, so Connect starts from an
unauthenticated challenge (which costs no attempt).

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
same (`locked`, `unlockSeconds`, `attemptsLeft`) when a 401 body has them.
Not verified on the DS-7604NI, since it costs a failed login: whether V4.75
sends that body, and whether it does for paths other than userCheck.
