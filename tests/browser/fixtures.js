/**
 * Test fixtures: synthetic and NVR-shaped XML committed in tests/fixtures,
 * plus any real device captures in tests/fixtures/local (git-ignored; made
 * with tests/capture-fixtures.sh).
 */
import motionDetection from '../fixtures/motionDetection.xml?raw';
import motionDetectionNvr from '../fixtures/motionDetection-nvr.xml?raw';
import motionCapabilitiesNvr from '../fixtures/motionCapabilities-nvr.xml?raw';
import motionLayoutCapabilitiesNvr from '../fixtures/motionLayoutCapabilities-nvr.xml?raw';
import privacyMask from '../fixtures/privacyMask.xml?raw';
import privacyMaskNvr from '../fixtures/privacyMask-nvr.xml?raw';
import privacyMaskNvrRegions from '../fixtures/privacyMask-nvr-regions.xml?raw';
import eventTrigger from '../fixtures/eventTrigger.xml?raw';
import eventTriggerNvr from '../fixtures/eventTrigger-nvr.xml?raw';
import eventTriggerNvrVmd3 from '../fixtures/eventTrigger-nvr-vmd3.xml?raw';
import eventTriggerNvrVmd3Io301 from '../fixtures/eventTrigger-nvr-vmd3-io301.xml?raw';
import eventTriggerNvrVmd3WhiteLight from '../fixtures/eventTrigger-nvr-vmd3-whitelight.xml?raw';
import triggersCapNvr from '../fixtures/triggersCap-nvr.xml?raw';
import ioOutputsNvr from '../fixtures/ioOutputs-nvr.xml?raw';
import ioOutputsCapabilitiesNvr from '../fixtures/ioOutputsCapabilities-nvr.xml?raw';
import ioProxyOutputsNvr from '../fixtures/ioProxyOutputs-nvr.xml?raw';
import whiteLightAlarmChannelsNvr from '../fixtures/whiteLightAlarmChannels-nvr.json?raw';
import audioAlarmChannelsNvr from '../fixtures/audioAlarmChannels-nvr.json?raw';
import inputProxyChannelsNvr from '../fixtures/inputProxyChannels-nvr.xml?raw';
import inputProxyChannelsStatusNvr from '../fixtures/inputProxyChannelsStatus-nvr.xml?raw';
import videoInputChannelsHybrid from '../fixtures/videoInputChannels-hybrid.xml?raw';
import inputProxyChannelsHybrid from '../fixtures/inputProxyChannels-hybrid.xml?raw';
import userCheckNvr from '../fixtures/userCheck-nvr.xml?raw';
import streamingChannelsNvr from '../fixtures/streamingChannels-nvr.xml?raw';
import systemTimeNvr from '../fixtures/systemTime-nvr.xml?raw';

export const fixtures = {
  // motionDetectionNvr is the DS-7604NI's channel 1 config as captured, with its capabilities
  // (the same at the InputProxy and System URLs) and layout capabilities
  motionDetection, motionDetectionNvr, motionCapabilitiesNvr, motionLayoutCapabilitiesNvr,
  privacyMask, privacyMaskNvr, privacyMaskNvrRegions, eventTrigger, eventTriggerNvr,
  // DS-7604NI captures (channel 3: its camera has a relay, white light and speaker); the -io301 and
  // -whitelight triggers are what the NVR stored after its own web UI's linkage was PUT
  eventTriggerNvrVmd3, eventTriggerNvrVmd3Io301, eventTriggerNvrVmd3WhiteLight, triggersCapNvr, ioOutputsNvr,
  ioOutputsCapabilitiesNvr, ioProxyOutputsNvr, whiteLightAlarmChannelsNvr, audioAlarmChannelsNvr, inputProxyChannelsNvr,
  // The DS-7604NI's answer to a userCheck it accepts
  userCheckNvr,
  // The DS-7604NI's IP camera status (all four online)
  inputProxyChannelsStatusNvr,
  // A hybrid DVR (synthetic): analog inputs 1–4, input 4 switched off, and IP cameras 5–6
  videoInputChannelsHybrid, inputProxyChannelsHybrid,
  // The DS-7604NI's stream list: each camera's main stream 2688×1520, sub stream 640×360
  streamingChannelsNvr,
  // The DS-7604NI's clock, read at 13:03 CEST: right wall-clock time, "+01:00" without daylight saving
  systemTimeNvr,
};

const captured = import.meta.glob('../fixtures/local/*_motionDetection.xml', { query: '?raw', import: 'default', eager: true });

/** Motion configs to check: the synthetic one, the committed NVR capture and any captured locally. */
export const motionFixtures = [
  ['synthetic', motionDetection],
  ['DS-7604NI', motionDetectionNvr],
  ...Object.entries(captured).map(([path, xml]) => [`device ${path.split('/').pop()}`, xml]),
];
