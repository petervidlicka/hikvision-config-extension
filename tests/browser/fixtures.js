/**
 * Test fixtures: synthetic and NVR-shaped XML committed in tests/fixtures,
 * plus any real device captures in tests/fixtures/local (git-ignored; made
 * with tests/capture-fixtures.sh).
 */
import motionDetection from '../fixtures/motionDetection.xml?raw';
import motionCapabilitiesNvr from '../fixtures/motionCapabilities-nvr.xml?raw';
import privacyMask from '../fixtures/privacyMask.xml?raw';
import privacyMaskNvr from '../fixtures/privacyMask-nvr.xml?raw';
import eventTrigger from '../fixtures/eventTrigger.xml?raw';
import eventTriggerNvr from '../fixtures/eventTrigger-nvr.xml?raw';

export const fixtures = {
  motionDetection, motionCapabilitiesNvr, privacyMask, privacyMaskNvr, eventTrigger, eventTriggerNvr,
};

const captured = import.meta.glob('../fixtures/local/*_motionDetection.xml', { query: '?raw', import: 'default', eager: true });

/** Motion configs to check: the synthetic one plus any captured from a device. */
export const motionFixtures = [
  ['synthetic', motionDetection],
  ...Object.entries(captured).map(([path, xml]) => [`device ${path.split('/').pop()}`, xml]),
];
