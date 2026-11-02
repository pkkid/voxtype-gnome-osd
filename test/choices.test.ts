import test from 'node:test';
import assert from 'node:assert/strict';

import { choiceModel, DEFAULT_CHOICE, inputDeviceLabel, inputDevices, parseCardNames } from '../src/prefs/choices.js';

test('choiceModel selects the current value and labels the choices for people', () => {
    assert.deepEqual(choiceModel(['type', 'clipboard', 'paste_keys'], 'clipboard'), {
        values: ['type', 'clipboard', 'paste_keys'],
        labels: ['Type', 'Clipboard', 'Paste keys'],
        selected: 1,
    });
});

test('choiceModel keeps a current value it does not know, so opening the page changes nothing', () => {
    const model = choiceModel(['default', 'pipewire'], 'hw:CARD=USB');

    assert.deepEqual(model?.values, ['hw:CARD=USB', 'default', 'pipewire']);
    assert.equal(model?.selected, 0);
});

test('choiceModel offers Default, which unsets the key, when nothing is configured', () => {
    const model = choiceModel(['default', 'pipewire'], null);

    assert.deepEqual(model?.values, [null, 'default', 'pipewire']);
    assert.equal(model?.labels[0], DEFAULT_CHOICE);
    assert.equal(model?.selected, 0);
    assert.equal(choiceModel([], 'x')?.values.length, 1);
});

test('inputDevices keeps the system default and one entry per sound card', () => {
    assert.deepEqual(inputDevices([
        'default',
        'pipewire',
        'sysdefault:CARD=PCH',
        'front:CARD=PCH,DEV=0',
        'surround40:CARD=PCH,DEV=0',
        'sysdefault:CARD=C920',
        'iec958:CARD=Microphones,DEV=0',
    ]), ['default', 'sysdefault:CARD=PCH', 'sysdefault:CARD=C920']);
});

test('parseCardNames maps ALSA card ids to the names from Sound settings, and survives bad output', () => {
    const cards = parseCardNames(JSON.stringify([
        { properties: { 'alsa.id': 'PCH', 'device.description': 'Built-in Audio' } },
        { properties: { 'device.description': 'Bluetooth headset' } },
        {},
    ]));
    assert.deepEqual([...cards], [['PCH', 'Built-in Audio']]);
    assert.equal(parseCardNames('').size, 0);
});

test('inputDeviceLabel names devices for people and falls back to what it has', () => {
    const cards = new Map([['PCH', 'Built-in Audio']]);
    assert.equal(inputDeviceLabel('default', cards), 'System default');
    assert.equal(inputDeviceLabel('sysdefault:CARD=PCH', cards), 'Built-in Audio');
    assert.equal(inputDeviceLabel('sysdefault:CARD=C920', cards), 'C920');
    assert.equal(inputDeviceLabel('hw:CARD=USB', cards), 'hw:CARD=USB');
});

test('choiceModel uses a custom label for the choices but not for Default', () => {
    const model = choiceModel(['a'], null, value => value.toUpperCase());
    assert.deepEqual(model?.labels, [DEFAULT_CHOICE, 'A']);
});
