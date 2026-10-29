import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INDICATOR_STYLES } from '../src/styles.js';

// Compiled to build-test/test/, so the project root is two levels up.
const ROOT = join(import.meta.dirname, '..', '..');
const SCHEMA_DIR = join(ROOT, 'schemas');
const SCHEMA = readFileSync(join(SCHEMA_DIR, 'org.gnome.shell.extensions.voxtype-osd.gschema.xml'), 'utf8');
const METADATA = JSON.parse(readFileSync(join(ROOT, 'metadata.json'), 'utf8'));

test('the settings schema compiles strictly and is the one metadata.json names', () => {
    execFileSync('glib-compile-schemas', ['--strict', '--dry-run', SCHEMA_DIR]);

    assert.match(SCHEMA, new RegExp(`<schema id="${METADATA['settings-schema']}"`));
});

test('the schema offers exactly the indicator styles the code draws', () => {
    const key = SCHEMA.match(/<key name="pill-style"[\s\S]*?<\/key>/)?.[0] ?? '';
    const choices = [...key.matchAll(/<choice value="([^"]+)"\/>/g)].map(match => match[1]);

    assert.deepEqual(choices, [...INDICATOR_STYLES]);
    assert.match(key, /<default>'classic'<\/default>/);
});
