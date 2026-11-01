import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseClipboardType, configValue, DoubleTap, isTerminal, restoreOuterSpace } from '../src/cleanupRules.js';

function fired(taps: number[]): number {
    const detector = new DoubleTap();
    return taps.filter(tap => detector.feed(tap)).length;
}

test('DoubleTap needs two taps close together', () => {
    assert.equal(fired([0, 150]), 1);
    assert.equal(fired([0]), 0);
    assert.equal(fired([0, 500]), 0);
});

test('DoubleTap fires once for three quick taps, and can fire again after', () => {
    assert.equal(fired([0, 100, 200]), 1);
    assert.equal(fired([0, 100, 200, 300]), 2);
});

test('DoubleTap counts a late tap as the start of a new double tap', () => {
    assert.equal(fired([0, 500, 600]), 1);
});

test('isTerminal knows the common terminals and no other apps', () => {
    for (const wmClass of ['gnome-terminal-server', 'org.gnome.Console', 'org.gnome.Ptyxis', 'kgx', 'kitty', 'Alacritty', 'foot', 'com.mitchellh.ghostty', 'org.wezfurlong.wezterm', 'konsole', 'XTerm']) {
        assert.equal(isTerminal(wmClass), true, wmClass);
    }
    for (const wmClass of ['firefox', 'Code', 'org.gnome.TextEditor', 'slack', 'Google-chrome', 'org.gnome.Nautilus', null]) {
        assert.equal(isTerminal(wmClass), false, String(wmClass));
    }
});

test('chooseClipboardType prefers text, then images, then whatever is first', () => {
    assert.equal(chooseClipboardType(['text/html', 'text/plain;charset=utf-8', 'text/plain']), 'text/plain;charset=utf-8');
    assert.equal(chooseClipboardType(['application/x-thing', 'image/png']), 'image/png');
    assert.equal(chooseClipboardType(['application/x-thing']), 'application/x-thing');
    assert.equal(chooseClipboardType([]), null);
});

test('restoreOuterSpace keeps the space around the original and drops the space the command added', () => {
    assert.equal(restoreOuterSpace('  teh text\n\n', 'The text.\n'), '  The text.\n\n');
    assert.equal(restoreOuterSpace('teh text', ' The text.  '), 'The text.');
});

test('configValue treats null and blank as not set', () => {
    assert.equal(configValue('null\n'), null);
    assert.equal(configValue('\n'), null);
    assert.equal(configValue('  sed s/a/b/\n'), 'sed s/a/b/');
});
