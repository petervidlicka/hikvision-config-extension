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

## Event actions

Alarm outputs use `<id>IO-{port}</id>`. IP channels use `<dynOutputIOPortID>`
unless the device reports `bSupportIOOutputUnify`, in which case they use
`<outputIOPortID>`.

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
