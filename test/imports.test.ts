import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

// Compiled to build-test/test/, so the project root is two levels up.
const SRC = join(import.meta.dirname, '..', '..', 'src');

// Every module reachable from `entry` (a path under src/ without extension) through relative imports,
// with the library imports each makes.
function importGraph(entry: string): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    const pending = [entry];

    while (pending.length > 0) {
        const name = pending.pop()!;
        if (graph.has(name)) {
            continue;
        }

        const source = readFileSync(join(SRC, `${name}.ts`), 'utf8');
        const specifiers = [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(match => match[1]);
        const isRelative = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');
        graph.set(name, specifiers.filter(specifier => !isRelative(specifier)));
        pending.push(...specifiers.filter(isRelative).map(specifier => normalize(join(dirname(name), specifier)).replace(/\.js$/, '')));
    }

    return graph;
}

function offending(graph: Map<string, string[]>, forbidden: RegExp): string[] {
    return [...graph].flatMap(([name, imports]) => imports.filter(specifier => forbidden.test(specifier)).map(specifier => `${name}: ${specifier}`));
}

// GNOME's review guidelines: GTK libraries conflict with Clutter in the shell process, and the shell
// libraries conflict with GTK in the preferences process.
test('nothing the shell loads imports Gtk, Gdk or Adw', () => {
    const graph = importGraph('extension');

    assert.ok(graph.has('osdPill') && graph.has('waveform'), 'the walk should reach the indicator code');
    assert.deepEqual(offending(graph, /^gi:\/\/(Gtk|Gdk|Adw)(\?|$)/), []);
});

test('nothing the Settings window loads imports Clutter, Meta, St, Shell or shell UI modules', () => {
    const graph = importGraph('prefs');

    assert.ok(graph.has('prefs/stylePicker') && graph.has('prefs/window'), 'the walk should reach the Settings code');
    assert.deepEqual(offending(graph, /^gi:\/\/(Clutter|Meta|St|Shell)(\?|$)|^resource:\/\/\/org\/gnome\/shell\//), []);
});
