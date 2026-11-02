// Pure helpers for the Voxtype page's dropdowns. No GI imports so the unit tests can load this.

export const DEFAULT_CHOICE = 'Default';

export type ChoiceModel = {
    // What each entry writes to the voxtype config; null removes the key so voxtype's default applies.
    values: (string | null)[];
    labels: string[];
    selected: number;
};

// Builds a dropdown for a voxtype setting. The current value is always offered, even when it is
// not one of the known choices, so opening the page never silently changes the config.
export function choiceModel(choices: string[], current: string | number | boolean | null, label: (value: string) => string = prettyChoice): ChoiceModel | null {
    const values: (string | null)[] = [...choices];
    const currentText = current === null ? null : String(current);

    if (currentText === null) {
        values.unshift(null);
    } else if (!values.includes(currentText)) {
        values.unshift(currentText);
    }

    if (values.length === 0) {
        return null;
    }

    return {
        values,
        labels: values.map(value => (value === null ? DEFAULT_CHOICE : label(value))),
        selected: Math.max(0, values.indexOf(currentText)),
    };
}

export function prettyChoice(value: string): string {
    const spaced = value.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const SYSTEM_DEVICE = 'default';
const CARD_DEVICE = /^sysdefault:CARD=(.+)$/;

// Voxtype lists every ALSA route to every sound card. One per card is enough, and that one goes
// through ALSA's own conversion, so it works whatever format the microphone records in.
export function inputDevices(names: string[]): string[] {
    return names.filter(name => name === SYSTEM_DEVICE || CARD_DEVICE.test(name));
}

export function inputDeviceLabel(name: string, cardNames: Map<string, string>): string {
    if (name === SYSTEM_DEVICE) {
        return 'System default';
    }

    const card = CARD_DEVICE.exec(name)?.[1];
    return card === undefined ? name : cardNames.get(card) ?? card;
}

type PulseCard = { properties?: Record<string, unknown> };

// The names from Sound settings, by the ALSA card id voxtype's device names use.
export function parseCardNames(pactlJson: string): Map<string, string> {
    try {
        const cards = JSON.parse(pactlJson) as PulseCard[];
        return new Map(cards.flatMap(({ properties }) => {
            const id = properties?.['alsa.id'];
            const name = properties?.['device.description'];
            return typeof id === 'string' && typeof name === 'string' ? [[id, name] as [string, string]] : [];
        }));
    } catch {
        return new Map();
    }
}
