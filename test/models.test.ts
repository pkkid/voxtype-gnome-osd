import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    claudeCleanupCommand,
    cleanupCommand,
    cleanupModel,
    cleanupPrompt,
    DEFAULT_CLEANUP_PROMPT,
    dictationModels,
    formatBytes,
    gpuAvailable,
    gpuLabel,
    gpuMemory,
    installedModels,
    isActiveModel,
    modelDisplayName,
    modelFileNames,
    parseDownloadEvent,
    parseModelsDir,
    parseOllamaList,
    withCleanupPrompt,
} from '../src/prefs/models.js';

const CATALOG = {
    engines: {
        moonshine: { models: [{ name: 'base', download_arg: 'moonshine-base', installed: true }] },
        whisper: {
            models: [
                { name: 'tiny', download_arg: 'tiny', installed: false },
                { name: 'base.en', download_arg: 'base.en', installed: true },
            ],
        },
    },
};

test('installedModels keeps only what is downloaded, with its engine', () => {
    assert.deepEqual(installedModels(CATALOG), [
        { engine: 'moonshine', name: 'base', downloadArg: 'moonshine-base' },
        { engine: 'whisper', name: 'base.en', downloadArg: 'base.en' },
    ]);
});

test('isActiveModel accepts either name, because engines differ in which the config holds', () => {
    const model = { engine: 'sensevoice', name: 'small', downloadArg: 'sensevoice-small' };

    assert.equal(isActiveModel(model, 'small'), true);
    assert.equal(isActiveModel(model, 'sensevoice-small'), true);
    assert.equal(isActiveModel(model, 'other'), false);
    assert.equal(isActiveModel(model, null), false);
});

test('modelFileNames covers the whisper file and directory forms', () => {
    assert.deepEqual(modelFileNames({ engine: 'whisper', name: 'base.en', downloadArg: 'base.en' }), ['ggml-base.en.bin', 'base.en', 'base.en']);
});

test('parseModelsDir reads the catalog header, and gives up on anything else', () => {
    assert.equal(parseModelsDir('Model catalog  (/home/me/.local/share/voxtype/models)\n\nwhisper\n'), '/home/me/.local/share/voxtype/models');
    assert.equal(parseModelsDir('whisper\n  base.en\n'), null);
});

test('parseOllamaList reads the columns and skips the header', () => {
    const output = [
        'NAME               ID              SIZE      MODIFIED',
        'llama3.2:1b        baf6a787fdff    1.3 GB    3 days ago',
        'tinyllama:latest   2644915ede35    45 MB     2 weeks ago',
        '',
    ].join('\n');

    assert.deepEqual(parseOllamaList(output), [
        { name: 'llama3.2:1b', size: '1.3 GB', bytes: 1.3e9 },
        { name: 'tinyllama:latest', size: '45 MB', bytes: 45e6 },
    ]);
    assert.deepEqual(parseOllamaList('NAME    ID    SIZE    MODIFIED\n'), []);
});

test('formatBytes matches how voxtype reports sizes', () => {
    assert.equal(formatBytes(147964211), '141 MB');
    assert.equal(formatBytes(1610612736), '1.5 GB');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
});

test('cleanupCommand quotes for the shell and cleanupModel reads it back', () => {
    const command = cleanupCommand('llama3.2:1b');

    assert.match(command, /^ollama run 'llama3\.2:1b' 'Clean up .*:'$/);
    assert.equal(cleanupModel(command), 'llama3.2:1b');
});

const WRAPPER_PATH = join(import.meta.dirname, '..', '..', 'bin', 'voxtype-cleanup.py');

test('claudeCleanupCommand runs the wrapper from wherever the extension is installed', () => {
    const command = claudeCleanupCommand("/home/o'neil/ext");

    assert.match(command, /^python3 '\/home\/o'\\''neil\/ext\/bin\/voxtype-cleanup\.py' --model haiku --effort low --prompt '/);
    assert.equal(cleanupPrompt(command), DEFAULT_CLEANUP_PROMPT);
});

test('the default prompt matches the one in the wrapper', () => {
    const source = readFileSync(WRAPPER_PATH, 'utf8');
    const start = source.indexOf('DEFAULT_PROMPT = (');
    const parsed = spawnSync('python3', ['-c', `${source.slice(start, source.indexOf('\n\n', start))}\nprint(DEFAULT_PROMPT)`], { encoding: 'utf8' });

    assert.equal(parsed.stdout.trim(), DEFAULT_CLEANUP_PROMPT);
});

test('cleanupPrompt reads quoted prompts, and shows the default when there is none', () => {
    const wrapper = "python3 '/x y/bin/voxtype-cleanup.py'";

    assert.equal(cleanupPrompt(`${wrapper} --prompt 'Fix: $text'`), 'Fix: $text');
    assert.equal(cleanupPrompt(`${wrapper} --prompt "Fix \\"this\\": \\\\ ok"`), 'Fix "this": \\ ok');
    assert.equal(cleanupPrompt(`${wrapper} --prompt='Fix it'`), 'Fix it');
    assert.equal(cleanupPrompt(`${wrapper} --prompt 'don'\\''t'`), "don't");
    assert.equal(cleanupPrompt(wrapper), DEFAULT_CLEANUP_PROMPT);
});

test('cleanupPrompt gives up on other commands and anything it could not rewrite safely', () => {
    assert.equal(cleanupPrompt("ollama run llama3.2:1b 'Clean up'"), null);
    assert.equal(cleanupPrompt('python3 /x/bin/voxtype-cleanup.py | tee log'), null);
    assert.equal(cleanupPrompt('python3 /x/bin/voxtype-cleanup.py --prompt "$HOME"'), null);
    assert.equal(cleanupPrompt("python3 /x/bin/voxtype-cleanup.py --prompt 'unfinished"), null);
    assert.equal(cleanupPrompt(''), null);
});

test('withCleanupPrompt keeps the other arguments and survives awkward text', () => {
    const start = "python3 '/x y/bin/voxtype-cleanup.py' --model sonnet --effort high --prompt old";

    for (const prompt of ["don't \"quote\" $100\nline two: $text", 'plain', '--prompt', '\\ back']) {
        const command = withCleanupPrompt(start, prompt);

        assert.equal(cleanupPrompt(command), prompt);
        assert.match(command, /--model sonnet --effort high/);
        assert.equal(command.split('--prompt').length - 1, prompt === '--prompt' ? 2 : 1);
        assert.equal(spawnSync('sh', ['-c', `printf %s ${command.slice(command.lastIndexOf('--prompt ') + 9)}`], { encoding: 'utf8' }).stdout, prompt);
    }
});

test('withCleanupPrompt drops the flag for a blank prompt, and replaces the = form', () => {
    assert.equal(withCleanupPrompt('python3 /x/bin/voxtype-cleanup.py --prompt old', '  '), 'python3 /x/bin/voxtype-cleanup.py');
    assert.equal(withCleanupPrompt("python3 /x/bin/voxtype-cleanup.py --prompt='old one'", 'new'), 'python3 /x/bin/voxtype-cleanup.py --prompt new');
});

test('cleanupModel reads a hand-written Ollama command and ignores other commands', () => {
    assert.equal(cleanupModel(`ollama run llama3.2:1b 'Format for Slack'`), 'llama3.2:1b');
    assert.equal(cleanupModel('sed s/foo/bar/'), null);
    assert.equal(cleanupModel(''), null);
});

test('dictationModels follows voxtype.io, keeps other downloads and drops the rest', () => {
    const models = dictationModels({
        engines: {
            moonshine: { models: [{ name: 'base', download_arg: 'moonshine-base', installed: false }] },
            whisper: {
                models: [
                    { name: 'large-v3', download_arg: 'large-v3', installed: false },
                    { name: 'tiny.en', download_arg: 'tiny.en', installed: true },
                    { name: 'custom', download_arg: 'custom', installed: true },
                    { name: 'unlisted', download_arg: 'unlisted', installed: false },
                ],
            },
        },
    });

    assert.deepEqual(models.map(model => model.name), ['tiny.en', 'large-v3', 'base', 'custom']);
    assert.equal(models[0].note?.bestFor, 'Quick notes, low-end hardware');
    assert.equal(models[3].note, null);
});

test('parseDownloadEvent reads the JSON progress events and skips anything else', () => {
    assert.deepEqual(parseDownloadEvent('{"event":"progress","model":"tiny.en","file":"ggml-tiny.en.bin","bytes":1,"total":4,"pct":25.0}'), { kind: 'progress', fraction: 0.25, file: 'ggml-tiny.en.bin' });
    assert.deepEqual(parseDownloadEvent('{"event":"done","model":"tiny.en"}'), { kind: 'done' });
    assert.deepEqual(parseDownloadEvent('{"event":"error","model":"x","message":"nope"}'), { kind: 'error', message: 'nope' });
    assert.equal(parseDownloadEvent('Error: nope'), null);
});

test('gpuAvailable needs the Vulkan build installed, runnable, and a GPU to use', () => {
    const variants = (fields: object) => JSON.stringify({ variants: [{ variant: 'whisper-vulkan', installed: true, runs_on_this_cpu: true, gpu_available: true, ...fields }] });

    assert.equal(gpuAvailable(variants({})), true);
    assert.equal(gpuAvailable(variants({ installed: false })), false);
    assert.equal(gpuAvailable(variants({ gpu_available: false })), false);
    assert.equal(gpuAvailable('not json'), false);
});

test('gpuLabel only claims what voxtype observed', () => {
    assert.equal(gpuLabel('{"state":"cpu-only"}'), 'Running on the CPU now.');
    assert.equal(gpuLabel('{"state":"gpu"}'), 'Running on the GPU now.');
    assert.equal(gpuLabel('{"state":"cpu-fallback"}'), 'Could not use the GPU, so it fell back to the CPU.');
    assert.equal(gpuLabel('{"state":"unknown"}'), '');
    assert.equal(gpuLabel('{"state":"not-running"}'), '');
    assert.equal(gpuLabel(''), '');
});

test('modelDisplayName spells out the engine, and the language for whisper', () => {
    const whisper = (name: string) => modelDisplayName({ engine: 'whisper', name, downloadArg: name });

    assert.equal(whisper('small.en'), 'Whisper English - Small');
    assert.equal(whisper('medium'), 'Whisper Multilingual - Medium');
    assert.equal(whisper('large-v3'), 'Whisper Multilingual - Large v3');
    assert.equal(whisper('large-v3-turbo'), 'Whisper Multilingual - Large v3 Turbo');
});

test('modelDisplayName drops the engine from names that repeat it', () => {
    assert.equal(modelDisplayName({ engine: 'moonshine', name: 'base', downloadArg: 'moonshine-base' }), 'Moonshine - Base');
    assert.equal(modelDisplayName({ engine: 'sensevoice', name: 'small', downloadArg: 'sensevoice-small' }), 'SenseVoice - Small');
    assert.equal(modelDisplayName({ engine: 'paraformer', name: 'paraformer-zh', downloadArg: 'paraformer-zh' }), 'Paraformer - Chinese');
    assert.equal(modelDisplayName({ engine: 'parakeet', name: 'parakeet-tdt-0.6b-v3-int8', downloadArg: 'parakeet-tdt-0.6b-v3-int8' }), 'Parakeet - TDT 0.6b v3 int8');
    assert.equal(modelDisplayName({ engine: 'mystery', name: 'x', downloadArg: 'x' }), 'mystery - X');
});

test('gpuMemory reads the video memory out of the evidence, when there is any', () => {
    assert.equal(gpuMemory(JSON.stringify({ evidence: ['binary: voxtype-vulkan', 'vram: 650 MiB held by pid 42 (nvidia-smi)'] })), 650 * 1024 ** 2);
    assert.equal(gpuMemory(JSON.stringify({ evidence: ['binary: voxtype-avx2'] })), null);
    assert.equal(gpuMemory('{}'), null);
    assert.equal(gpuMemory('not json'), null);
});
