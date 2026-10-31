// Pure helpers for voxtype's [hotkey] settings. No GI imports so the unit tests can load this.
//
// `voxtype config set` covers hotkey.key, hotkey.mode and hotkey.enabled, but it does not allow
// hotkey.modifiers, so that one line is edited here. The rest of the file is left exactly as it was.

// Keycodes from GDK are XKB keycodes, which are the evdev codes voxtype listens for plus 8.
const XKB_KEYCODE_OFFSET = 8;

// By physical key rather than keyval, because voxtype sees the physical key whatever the layout does.
const MODIFIER_NAMES: Record<number, string> = {
    29: 'LEFTCTRL',
    42: 'LEFTSHIFT',
    54: 'RIGHTSHIFT',
    56: 'LEFTALT',
    58: 'CAPSLOCK',
    97: 'RIGHTCTRL',
    100: 'RIGHTALT',
    125: 'LEFTMETA',
    126: 'RIGHTMETA',
};

const MODIFIER_LABELS: Record<string, string> = {
    LEFTCTRL: 'Ctrl',
    RIGHTCTRL: 'Right Ctrl',
    LEFTSHIFT: 'Shift',
    RIGHTSHIFT: 'Right Shift',
    LEFTALT: 'Alt',
    RIGHTALT: 'Right Alt',
    LEFTMETA: 'Super',
    RIGHTMETA: 'Right Super',
    CAPSLOCK: 'Caps Lock',
};

const SECTION_HEADER = /^\s*\[\s*hotkey\s*\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const MODIFIERS_LINE = /^\s*modifiers\s*=/;
const KEY_LINE = /^\s*key\s*=/;
const OUTSIDE_SECTION = /^\s*hotkey\s*[.=]/m;

export function hotkeyKeyName(keycode: number): string {
    return `EVTEST_${keycode - XKB_KEYCODE_OFFSET}`;
}

export function modifierName(keycode: number): string | null {
    return MODIFIER_NAMES[keycode - XKB_KEYCODE_OFFSET] ?? null;
}

// The XKB keycode of a voxtype key given by number, or null for a key given by name, like F13.
export function hotkeyKeycode(key: string): number | null {
    const match = /^(EVTEST|WEV)_(\d+)$/.exec(key);
    if (match === null) {
        return null;
    }
    return Number(match[2]) + (match[1] === 'EVTEST' ? XKB_KEYCODE_OFFSET : 0);
}

export function hotkeyLabel(keyLabel: string, modifiers: string[]): string {
    return [...modifiers.map(name => MODIFIER_LABELS[name] ?? name), keyLabel].join(' + ');
}

export function readModifiers(toml: string): string[] {
    const lines = toml.split('\n');
    const section = findSection(lines);
    const statement = section === null ? null : findModifiers(lines, section);

    if (statement === null) {
        return [];
    }

    const value = lines.slice(statement.first, statement.last + 1).map(stripComment).join(' ');
    return [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map(match => match[1] ?? match[2]);
}

// Returns the config with hotkey.modifiers replaced, or null when [hotkey] is written in a form that
// cannot be edited by line (`hotkey.key = ...` or an inline table), so nothing gets defined twice.
export function writeModifiers(toml: string, modifiers: string[]): string | null {
    if (OUTSIDE_SECTION.test(toml)) {
        return null;
    }

    const lines = toml.split('\n');
    const value = `[${modifiers.map(name => JSON.stringify(name)).join(', ')}]`;
    const section = findSection(lines);

    if (section === null) {
        const separator = toml.length === 0 || toml.endsWith('\n') ? '' : '\n';
        return `${toml}${separator}\n[hotkey]\nmodifiers = ${value}\n`;
    }

    const statement = findModifiers(lines, section);
    if (statement !== null) {
        const closing = lines[statement.last];
        const trailing = closing.slice(stripComment(closing).lastIndexOf(']') + 1);
        lines.splice(statement.first, statement.last - statement.first + 1, `modifiers = ${value}${trailing}`);
        return lines.join('\n');
    }

    const keyLine = lines.slice(section.first, section.last).findIndex(line => KEY_LINE.test(line));
    lines.splice(keyLine === -1 ? section.first : section.first + keyLine + 1, 0, `modifiers = ${value}`);
    return lines.join('\n');
}

type LineRange = { first: number; last: number };

// The lines after the [hotkey] header, up to but not including the next section's header.
function findSection(lines: string[]): LineRange | null {
    const header = lines.findIndex(line => SECTION_HEADER.test(line));
    if (header === -1) {
        return null;
    }

    const next = lines.findIndex((line, index) => index > header && ANY_HEADER.test(line));
    return { first: header + 1, last: next === -1 ? lines.length : next };
}

// The modifiers statement, which may be an array spread over several lines.
function findModifiers(lines: string[], section: LineRange): LineRange | null {
    for (let first = section.first; first < section.last; first++) {
        if (!MODIFIERS_LINE.test(lines[first])) {
            continue;
        }

        let last = first;
        while (last < section.last - 1 && !stripComment(lines[last]).includes(']')) {
            last += 1;
        }
        return { first, last };
    }
    return null;
}

function stripComment(line: string): string {
    return line.replace(/#.*$/, '');
}
