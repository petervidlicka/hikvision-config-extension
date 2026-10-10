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
  `badXmlContent` ("Tag 16 is invalid (two root tags)"). Devices whose
  triggersCap doesn't name the `*Out` flags still get the bare names; that is
  unverified, since no standalone camera has been tested.
- **`notificationRecurrence`**: the NVR accepts it on a record entry but drops
  it, and neither the NVR, its web UI nor the SDK writes it. New entries copy
  it only when the trigger's own entries carry it (camera firmware).

triggersCap, the outputs and the light and speaker lists describe the hardware,
so the extension reads them once per connection. A save goes to
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
404, 403 `notSupport`/`invalidOperation` and 400 `badXmlContent`/`badParameters`;
stop on 401, `lowPrivilege`, timeouts and network errors, and on 503
`serviceUnavailable`/`deviceBusy` (an empty channel's snapshot answers 503).

Every request has a time limit (`TIMEOUT_MS` in `lib/isapi.js`), as in
Hikvision's own clients (web UI 30 s per request, iVMS 3–30 s to connect).
