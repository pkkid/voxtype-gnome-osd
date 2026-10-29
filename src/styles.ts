// The recording indicator styles. Must match the pill-style choices in the settings schema.
export const INDICATOR_STYLES = ['classic', 'minimal', 'wave', 'osd'] as const;

export type IndicatorStyle = typeof INDICATOR_STYLES[number];

export function isIndicatorStyle(value: string): value is IndicatorStyle {
    return (INDICATOR_STYLES as readonly string[]).includes(value);
}
