import test from 'node:test';
import assert from 'node:assert/strict';

import { equalizerHeights, LevelHistory, parseBridgeLine, rippleHeights, WAVEFORM_GAIN } from '../src/levels.js';

test('parseBridgeLine reads a well formed level line', () => {
    const sample = parseBridgeLine('{"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}');

    assert.deepEqual(sample, { peak: 0.421 });
});

test('parseBridgeLine ignores the bridge status lines', () => {
    assert.equal(parseBridgeLine('{"status":"connected"}'), null);
    assert.equal(parseBridgeLine('{"status":"disconnected"}'), null);
});

test('parseBridgeLine returns null instead of throwing on garbage', () => {
    const rejected = ['', '   ', 'not json', '{"peak":', '[]', 'null', '42', '{"peak":"loud","rms":0,"vad":1}', '{"rms":0.1,"vad":1}', '{"peak":null}'];

    for (const line of rejected) {
        assert.equal(parseBridgeLine(line), null, `expected null for ${JSON.stringify(line)}`);
    }
});

test('parseBridgeLine clamps a peak outside the unit range', () => {
    assert.equal(parseBridgeLine('{"peak":3.5,"rms":0.2,"vad":1}')?.peak, 1);
    assert.equal(parseBridgeLine('{"peak":-0.4,"rms":0.2,"vad":1}')?.peak, 0);
});

test('LevelHistory starts silent', () => {
    const history = new LevelHistory(4);

    assert.deepEqual(history.bars(), [0, 0, 0, 0]);
    assert.deepEqual(history.recent(3), [0, 0, 0]);
    assert.equal(history.level, 0);
});

test('LevelHistory turns everything heard between steps into one bar holding the loudest peak', () => {
    const history = new LevelHistory(3);
    history.push({ peak: 0.01 });
    history.push({ peak: 0.04 });
    history.push({ peak: 0.02 });
    history.step();

    assert.deepEqual(history.bars(), [0, 0, 0.04 * WAVEFORM_GAIN]);
});

test('LevelHistory shifts every bar one slot left per step, newest on the right', () => {
    const history = new LevelHistory(3);
    history.push({ peak: 0.05 });
    history.step();
    history.step();

    assert.deepEqual(history.bars(), [0, 0.05 * WAVEFORM_GAIN, 0]);
});

test('LevelHistory never draws past the full height', () => {
    const history = new LevelHistory(1);
    history.push({ peak: 0.9 });
    history.step();

    assert.deepEqual(history.bars(), [1]);
});

test('LevelHistory level rises quickly and falls back slowly', () => {
    const history = new LevelHistory();
    history.push({ peak: 0.1 });
    const risen = history.level;
    history.push({ peak: 0 });
    const fallen = history.level;

    assert.ok(risen > 0.4, `expected a fast rise, got ${risen}`);
    assert.ok(fallen > risen * 0.9, `expected a slow fall, got ${fallen}`);
});

test('LevelHistory recent keeps the newest peaks at the end', () => {
    const history = new LevelHistory();
    history.push({ peak: 0.01 });
    history.push({ peak: 0.02 });

    assert.deepEqual(history.recent(3), [0, 0.01 * WAVEFORM_GAIN, 0.02 * WAVEFORM_GAIN]);
});

test('LevelHistory clear drops the previous recording', () => {
    const history = new LevelHistory(2);
    history.push({ peak: 0.05 });
    history.step();
    history.clear();
    history.step();

    assert.deepEqual(history.bars(), [0, 0]);
    assert.equal(history.level, 0);
});

test('equalizerHeights is flat for silence and taller in the middle for a steady voice', () => {
    assert.deepEqual(equalizerHeights([0, 0, 0], 0, 5), [0, 0, 0, 0, 0]);

    const heights = equalizerHeights([0.5, 0.5, 0.5], 0.5, 5);
    assert.equal(heights.length, 5);
    assert.ok(heights[2] > heights[0], 'middle bar should be the tallest');
    assert.equal(heights[0], heights[4]);
});

test('equalizerHeights stays within the full height', () => {
    for (const height of equalizerHeights([1, 1, 1], 1, 9)) {
        assert.ok(height >= 0 && height <= 1);
    }
    assert.deepEqual(equalizerHeights([], 0, 1), [0]);
});

test('rippleHeights stays between the resting and the crest height', () => {
    for (const phase of [0, 1, 2.5, 7]) {
        for (const height of rippleHeights(12, phase)) {
            assert.ok(height >= 0.2 && height <= 0.5);
        }
    }
});
