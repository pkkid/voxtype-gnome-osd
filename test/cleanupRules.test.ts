import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { addsLink, chooseClipboardType, configValue, DoubleTap, fillPrompt, isTerminal, restoreOuterSpace } from '../src/cleanupRules.js';

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

const AWKWARD = `don't "quote" $HOME \`id\` \\ back\nline two: $text`;

test('fillPrompt keeps the prompt as one piece of text, wherever $prompt sits', () => {
    const shell = (command: string) => spawnSync('sh', ['-c', fillPrompt(command, AWKWARD)], { encoding: 'utf8' }).stdout;

    assert.equal(shell('printf %s $prompt'), AWKWARD);
    assert.equal(shell(`printf %s '$prompt'`), AWKWARD);
    assert.equal(shell('printf %s "$prompt"'), AWKWARD);
    assert.equal(shell(`printf %s "Do this: $prompt!"`), `Do this: ${AWKWARD}!`);
    assert.equal(shell(`printf %s 'Do this: $prompt!'`), `Do this: ${AWKWARD}!`);
    assert.equal(shell('printf "%s|%s" $prompt $prompt'), `${AWKWARD}|${AWKWARD}`);
});

test('fillPrompt leaves other variables and an escaped $prompt alone', () => {
    assert.equal(fillPrompt('echo $prompts $HOME \\$prompt', 'x'), 'echo $prompts $HOME \\$prompt');
    assert.equal(fillPrompt('sed s/foo/bar/', 'x'), 'sed s/foo/bar/');
    assert.equal(fillPrompt('', 'x'), '');
});

test('addsLink finds a new link or address', () => {
    assert.equal(addsLink('please check this', 'Please check this https://evil.example'), true);
    assert.equal(addsLink('please check this', 'Please check www.evil.example'), true);
    assert.equal(addsLink('send it over', 'Send it to a@evil.example'), true);
    assert.equal(addsLink('see https://b.io', 'See https://b.io/other'), true);
});

test('addsLink allows links that were there, with new punctuation or capitals, and text without any', () => {
    assert.equal(addsLink('see https://b.io', 'See https://b.io'), false);
    assert.equal(addsLink('see www.foo.com', 'See www.foo.com.'), false);
    assert.equal(addsLink('see www.foo.com', 'See WWW.foo.com, please'), false);
    assert.equal(addsLink('mail bob@foo.com', 'Mail Bob@foo.com.'), false);
    assert.equal(addsLink('teh text', 'The text.'), false);
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
