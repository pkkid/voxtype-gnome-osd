import test from 'node:test';
import assert from 'node:assert/strict';

import { isRecording, parseStateFile } from '../src/states.js';

test('parseStateFile reads every state voxtype writes, ignoring surrounding whitespace', () => {
    assert.equal(parseStateFile('idle'), 'idle');
    assert.equal(parseStateFile('recording\n'), 'recording');
    assert.equal(parseStateFile('  streaming  '), 'streaming');
    assert.equal(parseStateFile('transcribing\r\n'), 'transcribing');
});

test('parseStateFile treats anything else as unavailable', () => {
    for (const contents of ['', '   ', 'unavailable', 'Recording', 'recording idle', 'garbage']) {
        assert.equal(parseStateFile(contents), 'unavailable', JSON.stringify(contents));
    }
});

test('isRecording is true while the microphone is live, with or without live dictation', () => {
    assert.equal(isRecording('recording'), true);
    assert.equal(isRecording('streaming'), true);
    for (const state of ['idle', 'transcribing', 'unavailable'] as const) {
        assert.equal(isRecording(state), false, state);
    }
});
