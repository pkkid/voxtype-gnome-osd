import test from 'node:test';
import assert from 'node:assert/strict';

import { choiceModel, DEFAULT_CHOICE } from '../src/prefs/choices.js';

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
