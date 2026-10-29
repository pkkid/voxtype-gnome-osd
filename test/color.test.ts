import test from 'node:test';
import assert from 'node:assert/strict';

import { accentColor, DEFAULT_ACCENT_COLOR, parseHexColor, rgbToHex } from '../src/color.js';

test('parseHexColor reads #rrggbb into 0..1 channels', () => {
    assert.deepEqual(parseHexColor('#ff0080'), [1, 0, 128 / 255]);
    assert.deepEqual(parseHexColor('  #FFFFFF '), [1, 1, 1]);
});

test('parseHexColor rejects anything that is not #rrggbb', () => {
    for (const value of ['', 'red', '#fff', 'ff0080', '#ff008', '#ff00800', '#gg0000', 'rgb(1,2,3)']) {
        assert.equal(parseHexColor(value), null, value);
    }
});

test('accentColor normalises valid values and falls back to the default', () => {
    assert.equal(accentColor(' #3584E4 '), '#3584e4');
    assert.equal(accentColor('nonsense'), DEFAULT_ACCENT_COLOR);
});

test('rgbToHex round trips with parseHexColor and clamps out of range channels', () => {
    assert.equal(rgbToHex(...parseHexColor('#3584e4')!), '#3584e4');
    assert.equal(rgbToHex(1.5, -0.2, 0.5), '#ff0080');
});
