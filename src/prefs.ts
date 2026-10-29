import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { choiceModel } from './choices.js';
import { accentColor, parseHexColor, rgbToHex } from './color.js';
import { setSidebarContent, showToast } from './prefsWindow.js';
import { buildStylePickerGroup } from './stylePicker.js';
import {
    isServiceActive,
    isServiceEnabled,
    restartService,
    run,
    setServiceEnabled,
    setServiceRunning,
} from './voxtype.js';

const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_KEYBINDING_SCHEMA = `${MEDIA_KEYS_SCHEMA}.custom-keybinding`;
const CUSTOM_KEYBINDING_BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/';
const TOGGLE_COMMAND = 'voxtype record toggle';
const SERVICE_POLL_SECS = 2;
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

export default class VoxtypeOsdPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        window.set_default_size(880, 800);

        const voxtypePage = new Adw.PreferencesPage({
            name: 'voxtype',
            title: 'Voxtype',
            icon_name: 'audio-input-microphone-symbolic',
        });
        fillVoxtypePage(window, voxtypePage).catch(error => {
            logError(error as Error, 'voxtype-osd: could not build the Voxtype page');
        });

        setSidebarContent(window, {
            title: this.metadata.name,
            subtitle: 'Settings',
            iconName: 'audio-input-microphone-symbolic',
        }, [
            buildGeneralPage(window, settings),
            buildIndicatorPage(settings),
            voxtypePage,
        ]);
    }
}

// ───────────────────────── General page ─────────────────────────

function buildGeneralPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: 'general',
        title: 'General',
        icon_name: 'preferences-system-symbolic',
    });

    page.add(buildServiceGroup(window));
    page.add(buildShortcutGroup(window));
    page.add(buildPanelIconGroup(settings));

    return page;
}

function buildServiceGroup(window: Adw.PreferencesWindow): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Voxtype service' });

    const runningRow = new Adw.SwitchRow({
        title: 'Running',
        subtitle: 'Stopping Voxtype frees the speech model from memory. The shortcut does nothing while it is stopped.',
    });
    const loginRow = new Adw.SwitchRow({
        title: 'Start at login',
    });
    group.add(runningRow);
    group.add(loginRow);

    let syncing = false;

    const refresh = async () => {
        const [active, enabled] = await Promise.all([isServiceActive(), isServiceEnabled()]);
        syncing = true;
        runningRow.active = active;
        loginRow.active = enabled;
        syncing = false;
    };

    runningRow.connect('notify::active', () => {
        if (syncing) {
            return;
        }
        setServiceRunning(runningRow.active).then(result => {
            if (!result.ok) {
                toast(window, `Could not ${runningRow.active ? 'start' : 'stop'} Voxtype: ${firstLine(result.stderr)}`);
            }
            refresh();
        });
    });

    loginRow.connect('notify::active', () => {
        if (syncing) {
            return;
        }
        setServiceEnabled(loginRow.active).then(result => {
            if (!result.ok) {
                toast(window, `Could not change autostart: ${firstLine(result.stderr)}`);
            }
            refresh();
        });
    });

    refresh();
    const pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SERVICE_POLL_SECS, () => {
        refresh();
        return GLib.SOURCE_CONTINUE;
    });
    window.connect('close-request', () => {
        GLib.source_remove(pollId);
        return false;
    });

    return group;
}

function buildShortcutGroup(window: Adw.PreferencesWindow): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Shortcut' });

    const shortcutLabel = new Gtk.ShortcutLabel({
        accelerator: findToggleBinding()?.get_string('binding') ?? '',
        disabled_text: 'Not set',
        valign: Gtk.Align.CENTER,
    });
    const shortcutRow = new Adw.ActionRow({
        title: 'Dictation shortcut',
        subtitle: 'Starts and stops dictation from any app. Saved as a GNOME keyboard shortcut.',
        activatable: true,
    });
    shortcutRow.add_suffix(shortcutLabel);
    shortcutRow.connect('activated', () => {
        captureShortcut(window, accelerator => {
            ensureToggleBinding().set_string('binding', accelerator);
            shortcutLabel.accelerator = accelerator;
        });
    });
    group.add(shortcutRow);

    return group;
}

function buildPanelIconGroup(settings: Gio.Settings): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Panel icon' });

    const leftClickRow = new Adw.SwitchRow({
        title: 'Left-click the panel icon to dictate',
        subtitle: 'Right-click always opens the menu.',
    });
    settings.bind('left-click-toggles', leftClickRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(leftClickRow);

    const stoppedRow = new Adw.SwitchRow({
        title: 'Keep panel icon while Voxtype is stopped',
        subtitle: 'Shows a crossed-out microphone so you can start Voxtype from the menu.',
    });
    settings.bind('show-when-stopped', stoppedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(stoppedRow);

    return group;
}

// ───────────────────────── Indicator page ─────────────────────────

function buildIndicatorPage(settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: 'indicator',
        title: 'Indicator',
        icon_name: 'preferences-desktop-appearance-symbolic',
    });

    const showGroup = new Adw.PreferencesGroup();
    const pillRow = new Adw.SwitchRow({
        title: 'Show recording indicator',
        subtitle: 'The on-screen indicator shown while you dictate.',
    });
    settings.bind('show-pill', pillRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    showGroup.add(pillRow);
    page.add(showGroup);

    const styleGroup = buildStylePickerGroup(settings, 'pill-style');
    pillRow.bind_property('active', styleGroup, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
    page.add(styleGroup);

    const lookGroup = new Adw.PreferencesGroup({ title: 'Appearance' });
    pillRow.bind_property('active', lookGroup, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
    page.add(lookGroup);

    const waveformRow = new Adw.SwitchRow({
        title: 'Show waveform',
        subtitle: 'Bars or waves that follow your voice.',
    });
    settings.bind('show-waveform', waveformRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    lookGroup.add(waveformRow);

    lookGroup.add(buildAccentColorRow(settings));

    const resetButton = new Gtk.Button({
        label: 'Reset',
        valign: Gtk.Align.CENTER,
    });
    resetButton.connect('clicked', () => {
        settings.reset('pill-x');
        settings.reset('pill-y');
    });
    const positionRow = new Adw.ActionRow({
        title: 'Position',
        subtitle: 'Drag the indicator while it is showing, or choose "Move recording indicator" from the panel menu.',
    });
    positionRow.add_suffix(resetButton);
    lookGroup.add(positionRow);

    return page;
}

function buildAccentColorRow(settings: Gio.Settings): Adw.ActionRow {
    const colorButton = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({ title: 'Accent color', with_alpha: false }),
        valign: Gtk.Align.CENTER,
    });
    const resetButton = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: 'Reset to the default red',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const row = new Adw.ActionRow({
        title: 'Accent color',
        subtitle: 'Used for the waveform, the Classic border and the panel icon. The recording dot stays red.',
    });
    row.add_suffix(resetButton);
    row.add_suffix(colorButton);

    // The setting is a #rrggbb string and the button holds a Gdk.RGBA, so sync them by hand.
    const syncButton = () => {
        const [red, green, blue] = parseHexColor(accentColor(settings.get_string('accent-color')))!;
        if (rgbToHex(colorButton.rgba.red, colorButton.rgba.green, colorButton.rgba.blue) !== rgbToHex(red, green, blue)) {
            colorButton.rgba = new Gdk.RGBA({ red, green, blue, alpha: 1 });
        }
        resetButton.sensitive = settings.get_user_value('accent-color') !== null;
    };

    colorButton.connect('notify::rgba', () => {
        const hex = rgbToHex(colorButton.rgba.red, colorButton.rgba.green, colorButton.rgba.blue);
        if (hex !== accentColor(settings.get_string('accent-color'))) {
            settings.set_string('accent-color', hex);
        }
    });
    resetButton.connect('clicked', () => settings.reset('accent-color'));
    const changedId = settings.connect('changed::accent-color', syncButton);
    row.connect('destroy', () => settings.disconnect(changedId));
    syncButton();

    return row;
}

// ───────────────────────── Shortcut capture ─────────────────────────

function findToggleBinding(): Gio.Settings | null {
    const mediaKeys = new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA });

    for (const path of mediaKeys.get_strv('custom-keybindings')) {
        const binding = new Gio.Settings({ schema_id: CUSTOM_KEYBINDING_SCHEMA, path });
        if (binding.get_string('command').trim() === TOGGLE_COMMAND) {
            return binding;
        }
    }

    return null;
}

function ensureToggleBinding(): Gio.Settings {
    const existing = findToggleBinding();
    if (existing !== null) {
        return existing;
    }

    const mediaKeys = new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA });
    const paths = mediaKeys.get_strv('custom-keybindings');

    let index = 0;
    while (paths.includes(`${CUSTOM_KEYBINDING_BASE}custom${index}/`)) {
        index += 1;
    }

    const path = `${CUSTOM_KEYBINDING_BASE}custom${index}/`;
    const binding = new Gio.Settings({ schema_id: CUSTOM_KEYBINDING_SCHEMA, path });
    binding.set_string('name', 'Voxtype dictation');
    binding.set_string('command', TOGGLE_COMMAND);
    binding.set_string('binding', '');
    mediaKeys.set_strv('custom-keybindings', [...paths, path]);

    return binding;
}

function isUsableShortcut(keyval: number, mask: Gdk.ModifierType): boolean {
    if (!Gtk.accelerator_valid(keyval, mask)) {
        return false;
    }

    // Plain keys and Shift+key would swallow normal typing, so require a real modifier
    // unless it is a key nobody types text with.
    if ((mask & ~Gdk.ModifierType.SHIFT_MASK) !== 0) {
        return true;
    }

    return (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) || keyval === Gdk.KEY_Pause || keyval === Gdk.KEY_Scroll_Lock;
}

function captureShortcut(window: Adw.PreferencesWindow, onCaptured: (accelerator: string) => void): void {
    const dialog = new Adw.AlertDialog({
        heading: 'Set dictation shortcut',
        body: 'Press the new key combination.\nEsc cancels, Backspace removes the shortcut.',
    });
    dialog.add_response('cancel', 'Cancel');

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_controller, keyval: number, keycode: number, state: Gdk.ModifierType) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
        const key = Gdk.keyval_to_lower(keyval);

        if (mask === 0 && key === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        if (mask === 0 && key === Gdk.KEY_BackSpace) {
            onCaptured('');
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        if (!isUsableShortcut(key, mask)) {
            return Gdk.EVENT_STOP;
        }

        onCaptured(Gtk.accelerator_name_with_keycode(null, key, keycode, mask));
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);

    dialog.present(window);
}

// ───────────────────────── Voxtype page ─────────────────────────

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
                toast(window, 'Voxtype restarted');
            } else {
                toast(window, `Could not restart Voxtype: ${firstLine(result.stderr)}`);
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
            toast(window, `Could not change ${entry.label}: ${firstLine(result.stderr)}`);
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
            toast(window, `Could not open ${configPath}`);
        }
    });
    group.add(fileRow);

    const restartRow = new Adw.ActionRow({
        title: 'Restart Voxtype',
        activatable: true,
    });
    restartRow.add_suffix(new Gtk.Image({ icon_name: 'view-refresh-symbolic' }));
    restartRow.connect('activated', () => {
        restartService().then(result => toast(window, result.ok ? 'Voxtype restarted' : `Could not restart Voxtype: ${firstLine(result.stderr)}`));
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

// ───────────────────────── Helpers ─────────────────────────

function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? '';
}

function toast(window: Adw.PreferencesWindow, title: string): void {
    showToast(window, title);
}
