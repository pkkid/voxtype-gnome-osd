// Pure helpers for the accent color setting. No GI imports so the unit tests can load this.

export const DEFAULT_ACCENT_COLOR = '#f2594d';

// The dot shown while the microphone is live. Always red, whatever the accent, so it reads as recording.
export const RECORDING_DOT_COLOR = '#ed333b';

export type Rgb = [number, number, number];

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

// Returns the color as 0..1 channels, or null if it is not a #rrggbb string.
export function parseHexColor(value: string): Rgb | null {
    const match = HEX_COLOR.exec(value.trim());
    if (match === null) {
        return null;
    }

    const digits = match[1];
    return [0, 2, 4].map(offset => parseInt(digits.slice(offset, offset + 2), 16) / 255) as Rgb;
}

// Normalises a stored setting to #rrggbb, falling back to the default when it is malformed.
export function accentColor(value: string): string {
    return parseHexColor(value) === null ? DEFAULT_ACCENT_COLOR : value.trim().toLowerCase();
}

// Turns 0..1 channels into #rrggbb.
export function rgbToHex(red: number, green: number, blue: number): string {
    return `#${[red, green, blue].map(channel => {
        const byte = Math.round(Math.min(Math.max(channel, 0), 1) * 255);
        return byte.toString(16).padStart(2, '0');
    }).join('')}`;
}
