import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { isServiceActive, restartService } from '../systemd.js';
import { firstLine, run } from '../voxtype.js';
import { choiceModel } from './choices.js';
import { showToast } from './window.js';

const NUMBER_APPLY_DELAY_MS = 600;

// The voxtype settings shown on the Voxtype page. Labels, descriptions, types and ranges come from
// `voxtype config schema --json`, so only the key names live here. Keys this voxtype build does not
// know (another engine, an older version) are skipped.
const VOXTYPE_GROUPS: { title: string; keys: string[] }[] = [
    {
        title: 'Dictation',
        keys: ['parakeet.streaming', 'output.mode', 'output.auto_submit', 'output.fallback_to_clipboard'],
    },
    {
        title: 'Microphone',
        keys: ['audio.device', 'audio.max_duration_secs', 'audio.pause_media', 'audio.duck_media', 'audio.feedback.enabled'],
    },
    {
        title: 'Notifications',
        keys: [
            'output.notification.on_transcription',
            'output.notification.on_no_speech',
            'output.notification.on_recording_start',
            'output.notification.on_recording_stop',
        ],
    },
    {
        title: 'Memory',
        keys: ['parakeet.on_demand_loading'],
    },
];

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
    compiled: boolean;
    restart_required: boolean;
};

type VoxtypeSchema = {
    config_path: string;
    keys: SchemaKey[];
};

type AudioDevice = {
    name: string;
    default: boolean;
};

// The Voxtype page fills in once voxtype has described its settings, so the window opens straight away.
export function buildVoxtypePage(window: Adw.PreferencesWindow): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: 'voxtype',
        title: 'Voxtype',
        icon_name: 'audio-input-microphone-symbolic',
    });
    fillVoxtypePage(window, page).catch(error => {
        logError(error as Error, 'voxtype-osd: could not build the Voxtype page');
    });
    return page;
}

async function fillVoxtypePage(window: Adw.PreferencesWindow, page: Adw.PreferencesPage): Promise<void> {
    const schemaResult = await run(['voxtype', 'config', 'schema', '--json']);
    if (!schemaResult.ok) {
        const group = new Adw.PreferencesGroup({
            title: 'Voxtype settings unavailable',
            description: `Could not run "voxtype config schema": ${firstLine(schemaResult.stderr)}`,
        });
        page.add(group);
        return;
    }

    const schema = JSON.parse(schemaResult.stdout) as VoxtypeSchema;
    const keys = new Map(schema.keys.filter(entry => entry.compiled).map(entry => [entry.key, entry]));
    const devices = await loadDevices();

    const banner = new Adw.Banner({
        title: 'Restart Voxtype to apply your changes',
        button_label: 'Restart',
        revealed: false,
    });
    banner.connect('button-clicked', () => {
        restartService().then(result => {
            if (result.ok) {
                banner.revealed = false;
                showToast(window, 'Voxtype restarted');
            } else {
                showToast(window, `Could not restart Voxtype: ${firstLine(result.stderr)}`);
            }
        });
    });
    page.banner = banner;

    const apply = async (entry: SchemaKey, value: string | null) => {
        const argv = value === null
            ? ['voxtype', 'config', 'unset', entry.key]
            : ['voxtype', 'config', 'set', entry.key, value];
        const result = await run(argv);

        if (!result.ok) {
            showToast(window, `Could not change ${entry.label}: ${firstLine(result.stderr)}`);
            return;
        }

        if (entry.restart_required && await isServiceActive()) {
            banner.revealed = true;
        }
    };

    for (const { title, keys: names } of VOXTYPE_GROUPS) {
        const group = new Adw.PreferencesGroup({ title });

        for (const name of names) {
            const entry = keys.get(name);
            const row = entry === undefined ? null : buildSchemaRow(entry, devices, apply);
            if (row !== null) {
                group.add(row);
            }
        }

        page.add(group);
    }

    page.add(buildMoreGroup(window, schema.config_path));
}

function buildMoreGroup(window: Adw.PreferencesWindow, configPath: string): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'More',
        description: 'Voxtype has many more options than fit here. Edit the config file, then restart Voxtype.',
    });

    const fileRow = new Adw.ActionRow({
        title: 'Open config file',
        subtitle: configPath,
        activatable: true,
    });
    fileRow.add_suffix(new Gtk.Image({ icon_name: 'document-edit-symbolic' }));
    fileRow.connect('activated', () => {
        try {
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(configPath, null), null);
        } catch (error) {
            showToast(window, `Could not open ${configPath}`);
        }
    });
    group.add(fileRow);

    const restartRow = new Adw.ActionRow({
        title: 'Restart Voxtype',
        activatable: true,
    });
    restartRow.add_suffix(new Gtk.Image({ icon_name: 'view-refresh-symbolic' }));
    restartRow.connect('activated', () => {
        restartService().then(result => showToast(window, result.ok ? 'Voxtype restarted' : `Could not restart Voxtype: ${firstLine(result.stderr)}`));
    });
    group.add(restartRow);

    return group;
}

type Apply = (entry: SchemaKey, value: string | null) => Promise<void>;

function buildSchemaRow(entry: SchemaKey, devices: AudioDevice[], apply: Apply): Adw.PreferencesRow | null {
    switch (entry.type) {
    case 'bool':
        return buildSwitchRow(entry, apply);
    case 'enum':
        return buildChoiceRow(entry, entry.choices ?? [], apply);
    case 'dynamic_enum':
        if (entry.source === 'devices') {
            return buildChoiceRow(entry, devices.map(device => device.name), apply);
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

function buildChoiceRow(entry: SchemaKey, choices: string[], apply: Apply): Adw.ComboRow | null {
    const model = choiceModel(choices, entry.value);
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

async function loadDevices(): Promise<AudioDevice[]> {
    const result = await run(['voxtype', 'info', 'devices', '--json']);
    if (!result.ok) {
        return [];
    }

    try {
        return JSON.parse(result.stdout) as AudioDevice[];
    } catch {
        return [];
    }
}
