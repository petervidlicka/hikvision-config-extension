/**
 * Test fixtures: synthetic and NVR-shaped XML committed in tests/fixtures,
 * plus any real device captures in tests/fixtures/local (git-ignored; made
 * with tests/capture-fixtures.sh).
 */
import motionDetection from '../fixtures/motionDetection.xml?raw';
import motionCapabilitiesNvr from '../fixtures/motionCapabilities-nvr.xml?raw';
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

export const fixtures = {
  motionDetection, motionCapabilitiesNvr, privacyMask, privacyMaskNvr, privacyMaskNvrRegions, eventTrigger, eventTriggerNvr,
  // DS-7604NI captures (channel 3: its camera has a relay, white light and speaker); the -io301 and
  // -whitelight triggers are what the NVR stored after its own web UI's linkage was PUT
  eventTriggerNvrVmd3, eventTriggerNvrVmd3Io301, eventTriggerNvrVmd3WhiteLight, triggersCapNvr, ioOutputsNvr,
  ioOutputsCapabilitiesNvr, ioProxyOutputsNvr, whiteLightAlarmChannelsNvr, audioAlarmChannelsNvr, inputProxyChannelsNvr,
};

const captured = import.meta.glob('../fixtures/local/*_motionDetection.xml', { query: '?raw', import: 'default', eager: true });

/** Motion configs to check: the synthetic one plus any captured from a device. */
export const motionFixtures = [
  ['synthetic', motionDetection],
  ...Object.entries(captured).map(([path, xml]) => [`device ${path.split('/').pop()}`, xml]),
];
