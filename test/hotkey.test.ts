import test from 'node:test';
import assert from 'node:assert/strict';

import { hotkeyKeycode, hotkeyKeyName, hotkeyLabel, modifierName, readModifiers, writeModifiers } from '../src/prefs/hotkey.js';

const CONFIG = [
    'state_file = "auto"',
    '',
    '[hotkey]',
    '# Key to hold for push-to-talk',
    'key = "EVTEST_32"',
    '',
    '# Example: modifiers = ["LEFTCTRL", "LEFTALT"]',
    'modifiers = ["LEFTCTRL", "LEFTALT", "LEFTMETA"]',
    '',
    '# mode = "push_to_talk"',
    '',
    '[audio]',
    'device = "default"',
    '',
].join('\n');

test('GDK keycodes convert to the evdev numbers voxtype uses', () => {
    assert.equal(hotkeyKeyName(40), 'EVTEST_32');
    assert.equal(hotkeyKeycode('EVTEST_32'), 40);
    assert.equal(hotkeyKeycode('WEV_40'), 40);
    assert.equal(hotkeyKeycode('F13'), null);
});

test('modifiers are told apart by physical key', () => {
    assert.equal(modifierName(37), 'LEFTCTRL');
    assert.equal(modifierName(105), 'RIGHTCTRL');
    assert.equal(modifierName(133), 'LEFTMETA');
    assert.equal(modifierName(40), null);
});

test('hotkeyLabel reads like a shortcut and keeps names it does not know', () => {
    assert.equal(hotkeyLabel('D', ['LEFTCTRL', 'LEFTALT', 'LEFTMETA']), 'Ctrl + Alt + Super + D');
    assert.equal(hotkeyLabel('F13', []), 'F13');
    assert.equal(hotkeyLabel('D', ['RIGHTALT', 'MUTE']), 'Right Alt + MUTE + D');
});

test('readModifiers ignores commented examples and other sections', () => {
    assert.deepEqual(readModifiers(CONFIG), ['LEFTCTRL', 'LEFTALT', 'LEFTMETA']);
    assert.deepEqual(readModifiers('[hotkey]\n# modifiers = ["LEFTCTRL"]\nkey = "F13"\n'), []);
    assert.deepEqual(readModifiers('[other]\nmodifiers = ["LEFTCTRL"]\n\n[hotkey]\nkey = "F13"\n'), []);
    assert.deepEqual(readModifiers('state_file = "auto"\n'), []);
});

test('readModifiers follows an array over several lines', () => {
    assert.deepEqual(readModifiers('[hotkey]\nmodifiers = [\n  "LEFTCTRL", # the left one\n  \'LEFTALT\',\n]\n'), ['LEFTCTRL', 'LEFTALT']);
});

test('writeModifiers changes only the modifiers line', () => {
    assert.equal(writeModifiers(CONFIG, ['RIGHTALT']), CONFIG.replace('modifiers = ["LEFTCTRL", "LEFTALT", "LEFTMETA"]\n', 'modifiers = ["RIGHTALT"]\n'));
});

test('writeModifiers keeps a trailing comment and clears with an empty array', () => {
    assert.equal(writeModifiers('[hotkey]\nmodifiers = ["LEFTCTRL"]  # mine\n', []), '[hotkey]\nmodifiers = []  # mine\n');
});

test('writeModifiers replaces a whole array spread over several lines', () => {
    assert.equal(writeModifiers('[hotkey]\nmodifiers = [\n  "LEFTCTRL", # [left]\n]\nkey = "D"\n', ['LEFTALT']), '[hotkey]\nmodifiers = ["LEFTALT"]\nkey = "D"\n');
});

test('writeModifiers adds the line after the key when only a comment mentions it', () => {
    const config = '[hotkey]\n# modifiers = ["LEFTCTRL"]\nkey = "F13"\n\n[audio]\ndevice = "default"\n';

    assert.equal(writeModifiers(config, ['LEFTCTRL']), '[hotkey]\n# modifiers = ["LEFTCTRL"]\nkey = "F13"\nmodifiers = ["LEFTCTRL"]\n\n[audio]\ndevice = "default"\n');
});

test('writeModifiers stays inside [hotkey] when another section has the same key', () => {
    assert.equal(writeModifiers('[other]\nmodifiers = ["X"]\n\n[hotkey]\nkey = "F13"\n', ['LEFTCTRL']), '[other]\nmodifiers = ["X"]\n\n[hotkey]\nkey = "F13"\nmodifiers = ["LEFTCTRL"]\n');
});

test('writeModifiers adds a [hotkey] section when there is none', () => {
    assert.equal(writeModifiers('state_file = "auto"', ['LEFTCTRL']), 'state_file = "auto"\n\n[hotkey]\nmodifiers = ["LEFTCTRL"]\n');
});

test('writeModifiers refuses forms it would have to define twice', () => {
    assert.equal(writeModifiers('hotkey.key = "F13"\n', ['LEFTCTRL']), null);
    assert.equal(writeModifiers('hotkey = { key = "F13" }\n', ['LEFTCTRL']), null);
});

test('what writeModifiers writes reads back', () => {
    const updated = writeModifiers(CONFIG, ['LEFTCTRL', 'RIGHTMETA']);

    assert.deepEqual(readModifiers(updated!), ['LEFTCTRL', 'RIGHTMETA']);
});
