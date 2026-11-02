// Pure helpers for Cleanup Anything. No GI imports so the unit tests can load this.

// Longest pause between the two taps of a double tap.
const TAP_GAP_MS = 350;

const PROMPT_WORD = '$prompt';
const LINKS = /(?:\w+:\/\/|www\.)\S+|\S+@\S+\.\w+/gi;
// Punctuation fixes often land right after a link, and that doesn't make it a new one.
const LINK_END = /[.,;:!?)\]}'"]+$/;

// Ctrl+C interrupts whatever a terminal is running instead of copying, so they are left alone.
const TERMINALS = /gnome-terminal|org\.gnome\.(console|ptyxis)|ptyxis|^kgx$|^kitty$|alacritty|^foot|ghostty|wezterm|konsole|tilix|terminator|xterm|urxvt|blackbox|contour|warp/i;

// The plain text types, best first. Only one type can be put back, as the clipboard has no way to
// offer several, so rich text comes back as plain text.
const TEXT_TYPE = /^(text\/plain;charset=utf-8|UTF8_STRING|text\/plain|STRING|TEXT)$/;

// GNOME reports each tap of Left Ctrl on its own, and leaves out presses that were part of a shortcut.
export class DoubleTap {
    private lastTap: number | null = null;

    // Takes the time of a tap in milliseconds and returns true when it completes a double tap.
    feed(now: number): boolean {
        const double = this.lastTap !== null && now - this.lastTap <= TAP_GAP_MS;
        this.lastTap = double ? null : now;
        return double;
    }
}

export function isTerminal(wmClass: string | null): boolean {
    return wmClass !== null && TERMINALS.test(wmClass);
}

// Text wins over images, then whatever is listed first.
export function chooseClipboardType(types: string[]): string | null {
    return types.find(type => TEXT_TYPE.test(type)) ?? types.find(type => type.startsWith('image/')) ?? types[0] ?? null;
}

// Keeps the spaces and line breaks around the original, which the cleanup command trims away.
export function restoreOuterSpace(original: string, cleaned: string): string {
    const start = original.length - original.trimStart().length;
    const end = original.trimEnd().length;
    return original.slice(0, start) + cleaned.trim() + original.slice(end);
}

function findLinks(text: string): Set<string> {
    return new Set((text.match(LINKS) ?? []).map(link => link.replace(LINK_END, '').toLowerCase()));
}

// A cleanup has no reason to add a link or address, so one came from the model and not the person.
export function addsLink(original: string, cleaned: string): boolean {
    const known = findLinks(original);
    return [...findLinks(cleaned)].some(link => !known.has(link));
}

// Puts the prompt where a command says $prompt. voxtype runs the command itself and knows nothing of
// $prompt, so this has to happen before it gets there. The prompt is quoted to suit the spot it lands
// in, so it stays one word and a shell never acts on what is in it.
export function fillPrompt(command: string, prompt: string): string {
    const single = prompt.replace(/'/g, `'\\''`);
    const double = prompt.replace(/[\\"$`]/g, '\\$&');
    let filled = '';
    let quote = '';

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];

        if (char === '\\' && quote !== "'") {
            filled += char + (command[++index] ?? '');
        } else if (command.startsWith(PROMPT_WORD, index) && !/\w/.test(command[index + PROMPT_WORD.length] ?? '')) {
            filled += quote === "'" ? single : quote === '"' ? double : `'${single}'`;
            index += PROMPT_WORD.length - 1;
        } else {
            quote = quote === '' && (char === "'" || char === '"') ? char : char === quote ? '' : quote;
            filled += char;
        }
    }
    return filled;
}

// `voxtype config get` prints null for a value that is not set.
export function configValue(output: string): string | null {
    const value = output.trim();
    return value === '' || value === 'null' ? null : value;
}
