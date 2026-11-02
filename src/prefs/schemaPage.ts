import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { firstLine, run } from '../voxtype.js';
import { choiceModel, inputDeviceLabel, inputDevices, parseCardNames } from './choices.js';
import { LIVE_PARAKEET_MODEL } from './models.js';
import { noteRestartNeeded } from './voxtypeConfig.js';
import { showToast } from './window.js';

const NUMBER_APPLY_DELAY_MS = 600;

// Pages of voxtype settings. Labels, descriptions, types and ranges come from
// `voxtype config schema --json`, so only the key names live here. Keys this voxtype build does not
// know (another engine, an older version) and keys for an engine that is not in use are skipped.
type SchemaGroup = { title: string; keys: string[] };

export type SchemaPageContent = {
    name: string;
    title: string;
    icon: string;
    groups: SchemaGroup[];
};

export const DICTATION_PAGE: SchemaPageContent = {
    name: 'dictation',
    title: 'Dictation',
    icon: 'audio-input-microphone-symbolic',
    groups: [
        {
            title: '',
            keys: ['whisper.streaming', 'parakeet.streaming', 'output.auto_submit', 'output.fallback_to_clipboard'],
        },
        {
            title: 'Microphone',
            keys: ['audio.device', 'audio.max_duration_secs', 'audio.pause_media', 'audio.duck_media', 'audio.feedback.enabled'],
        },
    ],
};

export const NOTIFICATIONS_PAGE: SchemaPageContent = {
    name: 'notifications',
    title: 'Notifications',
    icon: 'preferences-system-notifications-symbolic',
    groups: [
        {
            title: 'Notifications',
            keys: [
                'output.notification.on_transcription',
                'output.notification.on_no_speech',
                'output.notification.on_recording_start',
                'output.notification.on_recording_stop',
            ],
        },
    ],
};

// Voxtype's own name for live transcription is "Streaming transcription"; the Models page says live.
const LABELS: Record<string, string> = {
    'whisper.streaming': 'Live transcription',
    'parakeet.streaming': 'Live transcription',
    'audio.duck_media': 'Lower media while recording',
};

// Voxtype's words describe its device names, which this page replaces with the names of the cards.
const DESCRIPTIONS: Record<string, string> = {
    'audio.device': 'The microphone Voxtype listens to. System default follows your Sound settings.',
};

// Facts voxtype's own descriptions leave out.
const DESCRIPTION_NOTES: Record<string, string> = {
    'whisper.streaming': 'Voxtype requires Toggle for this, so your shortcut becomes press to start, press again to stop. Turn on "Use your GPU" on the Models page too: on the CPU it can fall behind and keep typing long after you stop. Cannot be used with Load on demand.',
    'parakeet.streaming': 'Voxtype requires Toggle for this, so your shortcut becomes press to start, press again to stop. Only works with the Parakeet Unified model, from the Models page.',
};

// Rows go stale when the Models page changes the engine or model.
const refreshers = new WeakMap<Adw.PreferencesWindow, (() => void)[]>();

export function refreshSchemaPages(window: Adw.PreferencesWindow): void {
    refreshers.get(window)?.forEach(refresh => refresh());
}

type SchemaValue = string | number | boolean | null;

type SchemaKey = {
    key: string;
    label: string;
    description: string;
    type: 'bool' | 'string' | 'int' | 'float' | 'enum' | 'dynamic_enum';
    value: SchemaValue;
    choices?: string[];
    min?: number;
    max?: number;
    source?: string;
    engine?: string | null;
    compiled: boolean;
    restart_required: boolean;
};

type VoxtypeSchema = {
    keys: SchemaKey[];
};

type AudioDevice = {
    name: string;
    default: boolean;
};

type InputDevices = {
    names: string[];
    label: (name: string) => string;
};

// Fills in once voxtype has described its settings, so the window opens straight away.
export function buildSchemaPage(window: Adw.PreferencesWindow, content: SchemaPageContent): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: content.name,
        title: content.title,
        icon_name: content.icon,
    });
    const groups: Adw.PreferencesGroup[] = [];
    const refresh = () => {
        fillSchemaPage(window, page, content, groups).catch(error => {
            logError(error as Error, `voxtype-osd: could not build the ${content.title} page`);
        });
    };

    refreshers.set(window, [...refreshers.get(window) ?? [], refresh]);
    refresh();
    return page;
}

async function fillSchemaPage(window: Adw.PreferencesWindow, page: Adw.PreferencesPage, content: SchemaPageContent, groups: Adw.PreferencesGroup[]): Promise<void> {
    const schemaResult = await run(['voxtype', 'config', 'schema', '--json']);
    groups.splice(0).forEach(group => page.remove(group));

    if (!schemaResult.ok) {
        const group = new Adw.PreferencesGroup({
            title: 'Voxtype settings unavailable',
            description: `Could not run "voxtype config schema": ${firstLine(schemaResult.stderr)}`,
        });
        groups.push(group);
        page.add(group);
        return;
    }

    const schema = JSON.parse(schemaResult.stdout) as VoxtypeSchema;
    for (const entry of schema.keys) {
        entry.label = LABELS[entry.key] ?? entry.label;
        entry.description = DESCRIPTIONS[entry.key] ?? entry.description;
        if (entry.key in DESCRIPTION_NOTES) {
            entry.description = `${entry.description} ${DESCRIPTION_NOTES[entry.key]}`;
        }
    }

    const activeEngine = schema.keys.find(entry => entry.key === 'engine')?.value ?? null;
    const applies = (entry: SchemaKey) => entry.compiled && (!entry.engine || activeEngine === null || entry.engine === activeEngine);
    const keys = new Map(schema.keys.filter(applies).map(entry => [entry.key, entry]));
    const devices = await loadDevices();

    const apply = async (entry: SchemaKey, value: string | null) => {
        const argv = value === null
            ? ['voxtype', 'config', 'unset', entry.key]
            : ['voxtype', 'config', 'set', entry.key, value];
        const result = await run(argv);

        if (!result.ok) {
            showToast(window, `Could not change ${entry.label}: ${firstLine(result.stderr)}`);
            return;
        }

        if (entry.restart_required) {
            await noteRestartNeeded(window);
        }
    };

    for (const { title, keys: names } of content.groups) {
        const rows = names.flatMap(name => {
            const entry = keys.get(name);
            const row = entry === undefined ? null : buildSchemaRow(entry, devices, apply);
            // Left on, these stay switchable so they can be turned back off.
            if (row !== null && entry?.key === 'parakeet.streaming') {
                row.sensitive = entry.value === true || keys.get('parakeet.model')?.value === LIVE_PARAKEET_MODEL;
            }
            if (row !== null && entry?.key === 'whisper.streaming') {
                row.sensitive = entry.value === true || keys.get('whisper.on_demand_loading')?.value !== true;
            }
            return row === null ? [] : [row];
        });

        if (rows.length > 0) {
            const group = new Adw.PreferencesGroup({ title });
            rows.forEach(row => group.add(row));
            groups.push(group);
            page.add(group);
        }
    }
}

type Apply = (entry: SchemaKey, value: string | null) => Promise<void>;

function buildSchemaRow(entry: SchemaKey, devices: InputDevices, apply: Apply): Adw.PreferencesRow | null {
    switch (entry.type) {
    case 'bool':
        return buildSwitchRow(entry, apply);
    case 'enum':
        return buildChoiceRow(entry, entry.choices ?? [], apply);
    case 'dynamic_enum':
        if (entry.source === 'devices') {
            return buildChoiceRow(entry, devices.names, apply, devices.label);
        }
        return null;
    case 'int':
    case 'float':
        return buildNumberRow(entry, apply);
    case 'string':
        return buildTextRow(entry, apply);
    default:
        return null;
    }
}

function buildSwitchRow(entry: SchemaKey, apply: Apply): Adw.SwitchRow {
    const row = new Adw.SwitchRow({
        title: entry.label,
        subtitle: entry.description,
        active: entry.value === true,
    });
    row.connect('notify::active', () => apply(entry, row.active ? 'true' : 'false'));
    return row;
}

function buildChoiceRow(entry: SchemaKey, choices: string[], apply: Apply, label?: (value: string) => string): Adw.ComboRow | null {
    const model = choiceModel(choices, entry.value, label);
    if (model === null) {
        return null;
    }

    const row = new Adw.ComboRow({
        title: entry.label,
        subtitle: entry.description,
        model: Gtk.StringList.new(model.labels),
        selected: model.selected,
    });
    row.connect('notify::selected', () => apply(entry, model.values[row.selected] ?? null));
    return row;
}

function buildNumberRow(entry: SchemaKey, apply: Apply): Adw.SpinRow {
    const isFloat = entry.type === 'float';
    const min = entry.min ?? 0;
    const max = entry.max ?? 1_000_000;
    const step = isFloat ? 0.1 : 1;

    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = entry.label;
    row.subtitle = entry.description;
    row.digits = isFloat ? 2 : 0;
    row.value = typeof entry.value === 'number' ? entry.value : min;

    // Spinning or typing changes the value many times; only save once it settles.
    let pendingId = 0;
    row.connect('notify::value', () => {
        if (pendingId !== 0) {
            GLib.source_remove(pendingId);
        }
        pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NUMBER_APPLY_DELAY_MS, () => {
            pendingId = 0;
            apply(entry, isFloat ? row.value.toFixed(2) : String(Math.round(row.value)));
            return GLib.SOURCE_REMOVE;
        });
    });
    return row;
}

function buildTextRow(entry: SchemaKey, apply: Apply): Adw.EntryRow {
    const row = new Adw.EntryRow({
        title: entry.label,
        text: typeof entry.value === 'string' ? entry.value : '',
        show_apply_button: true,
        tooltip_text: entry.description,
    });
    row.connect('apply', () => apply(entry, row.text.length === 0 ? null : row.text));
    return row;
}

async function loadDevices(): Promise<InputDevices> {
    const [devices, cards] = await Promise.all([
        run(['voxtype', 'info', 'devices', '--json']),
        run(['pactl', '--format=json', 'list', 'cards']),
    ]);
    const cardNames = parseCardNames(cards.stdout);
    const label = (name: string) => inputDeviceLabel(name, cardNames);

    try {
        return { names: inputDevices((JSON.parse(devices.stdout) as AudioDevice[]).map(device => device.name)), label };
    } catch {
        return { names: [], label };
    }
}
