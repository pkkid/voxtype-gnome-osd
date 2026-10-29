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
export function choiceModel(choices: string[], current: string | number | boolean | null): ChoiceModel | null {
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
        labels: values.map(value => (value === null ? DEFAULT_CHOICE : prettyChoice(value))),
        selected: Math.max(0, values.indexOf(currentText)),
    };
}

export function prettyChoice(value: string): string {
    const spaced = value.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
