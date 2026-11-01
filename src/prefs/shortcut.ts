import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { run } from '../voxtype.js';
import { choiceModel } from './choices.js';
import { hotkeyKeycode, hotkeyKeyName, hotkeyLabel, modifierName, readModifiers, writeModifiers } from './hotkey.js';
import { restartIfRunning, setConfig } from './voxtypeConfig.js';
import { showToast } from './window.js';

// The dictation shortcut is voxtype's own hotkey, because only voxtype sees both the press and the
// release that push-to-talk needs. Older versions of this extension saved a GNOME custom shortcut
// running `voxtype record toggle` instead; left in place on the same keys, it stops every recording
// the hotkey starts, so the Settings window offers to remove it.
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_KEYBINDING_SCHEMA = `${MEDIA_KEYS_SCHEMA}.custom-keybinding`;
const TOGGLE_COMMAND = 'voxtype record toggle';

const INPUT_DEVICE = '/dev/input/event0';

const MODE_SUBTITLE = 'Push to talk records while the keys are held. Toggle starts and stops on separate presses.';
const FORCED_MODE_SUBTITLE = 'Voxtype requires Toggle for live transcription: typing while keys are held can leave recording stuck on. Press the keys once to start and again to stop.';

// Used for a modifier held before the dialog saw it pressed, and for Super, whose press GNOME Shell
// keeps to itself. The mask cannot tell left from right.
const MASK_MODIFIERS: [Gdk.ModifierType, string, string][] = [
    [Gdk.ModifierType.CONTROL_MASK, 'LEFTCTRL', 'RIGHTCTRL'],
    [Gdk.ModifierType.ALT_MASK, 'LEFTALT', 'RIGHTALT'],
    [Gdk.ModifierType.SHIFT_MASK, 'LEFTSHIFT', 'RIGHTSHIFT'],
    [Gdk.ModifierType.SUPER_MASK, 'LEFTMETA', 'RIGHTMETA'],
];

type CapturedHotkey = { key: string; modifiers: string[] };

type HotkeySchema = {
    config_path: string;
    keys: { key: string; value: string | number | boolean | null; choices?: string[] }[];
};

// Shown once voxtype has described its hotkey, so the window opens straight away. Stays hidden if
// voxtype cannot answer; the Voxtype page explains why.
export function buildShortcutGroup(window: Adw.PreferencesWindow): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Shortcut',
        visible: false,
        description: canReadInputDevices()
            ? ''
            : 'Voxtype cannot read the keyboard, so the shortcut will not work. Add yourself to the input group with "sudo usermod -aG input $USER", then log out and back in.',
    });
    fillShortcutGroup(window, group).catch(error => {
        logError(error as Error, 'voxtype-osd: could not build the shortcut settings');
    });
    return group;
}

async function fillShortcutGroup(window: Adw.PreferencesWindow, group: Adw.PreferencesGroup): Promise<void> {
    const result = await run(['voxtype', 'config', 'schema', '--json']);
    if (!result.ok) {
        return;
    }

    const schema = JSON.parse(result.stdout) as HotkeySchema;
    const entries = new Map(schema.keys.map(entry => [entry.key, entry]));
    const keyEntry = entries.get('hotkey.key');
    if (keyEntry === undefined) {
        return;
    }

    let enabled = entries.get('hotkey.enabled')?.value !== false;
    let key = String(keyEntry.value);
    let modifiers = loadModifiers(schema.config_path);

    const label = new Gtk.ShortcutLabel({ valign: Gtk.Align.CENTER });
    const showHotkey = () => {
        label.accelerator = enabled ? hotkeyAccelerator(key, modifiers) : '';
        label.disabled_text = enabled ? hotkeyLabel(keyLabel(key), modifiers) : 'Not set';
    };
    showHotkey();

    const shortcutRow = new Adw.ActionRow({
        title: 'Dictation shortcut',
        subtitle: 'Works from any app. Saved in the Voxtype config. These keys also reach the app you are in, so pick some it does not use.',
        activatable: true,
    });
    shortcutRow.add_suffix(label);
    shortcutRow.connect('activated', () => {
        captureHotkey(window, async captured => {
            if (captured === null) {
                if (await setConfig(window, 'hotkey.enabled', 'false')) {
                    enabled = false;
                    showHotkey();
                    await restartIfRunning(window);
                }
                return;
            }

            if (!await setConfig(window, 'hotkey.key', captured.key)) {
                return;
            }
            key = captured.key;

            if (saveModifiers(schema.config_path, captured.modifiers)) {
                modifiers = captured.modifiers;
            } else {
                showToast(window, `Could not save the modifier keys to ${schema.config_path}`);
            }

            if (enabled || await setConfig(window, 'hotkey.enabled', 'true')) {
                enabled = true;
            }
            showHotkey();
            await restartIfRunning(window);
        });
    });
    group.add(shortcutRow);

    const modeEntry = entries.get('hotkey.mode');
    const modeModel = modeEntry === undefined ? null : choiceModel(modeEntry.choices ?? [], modeEntry.value);
    if (modeModel !== null) {
        const modeRow = new Adw.ComboRow({
            title: 'Activation mode',
            subtitle: MODE_SUBTITLE,
            model: Gtk.StringList.new(modeModel.labels),
            selected: modeModel.selected,
        });

        let chosen = modeModel.selected;
        let syncing = false;
        modeRow.connect('notify::selected', async () => {
            const value = modeModel.values[modeRow.selected];
            if (syncing) {
                return;
            }

            chosen = modeRow.selected;
            if (value !== null && value !== undefined && await setConfig(window, 'hotkey.mode', value)) {
                await restartIfRunning(window);
            }
        });

        // Voxtype runs live transcription in toggle mode whatever the config says, and only says so in
        // its log. Show what the hotkey really does, without changing the saved setting.
        const showRealMode = async () => {
            const streaming = await run(['voxtype', 'config', 'get', `${entries.get('engine')?.value}.streaming`]);
            const forced = streaming.ok && streaming.stdout.trim() === 'true';

            syncing = true;
            modeRow.selected = forced ? Math.max(0, modeModel.values.indexOf('toggle')) : chosen;
            syncing = false;
            modeRow.sensitive = !forced;
            modeRow.subtitle = forced ? FORCED_MODE_SUBTITLE : MODE_SUBTITLE;
        };
        group.connect('map', () => {
            showRealMode().catch(error => logError(error as Error, 'voxtype-osd: could not check live transcription'));
        });
        group.add(modeRow);
    }

    const legacy = findToggleBindings();
    if (legacy.length > 0) {
        const legacyRow = new Adw.ActionRow({
            title: 'Old GNOME shortcut found',
            subtitle: `${legacy[0].get_string('binding')} also runs "${TOGGLE_COMMAND}". On the same keys it stops dictation as soon as it starts.`,
        });
        const removeButton = new Gtk.Button({ label: 'Remove', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'] });
        removeButton.connect('clicked', () => {
            removeToggleBindings();
            group.remove(legacyRow);
        });
        legacyRow.add_suffix(removeButton);
        group.add(legacyRow);
    }

    group.visible = true;
}

function canReadInputDevices(): boolean {
    try {
        return Gio.File.new_for_path(INPUT_DEVICE).query_info('access::can-read', Gio.FileQueryInfoFlags.NONE, null).get_attribute_boolean('access::can-read');
    } catch {
        return true;
    }
}

function loadModifiers(configPath: string): string[] {
    try {
        const [, contents] = Gio.File.new_for_path(configPath).load_contents(null);
        return readModifiers(new TextDecoder().decode(contents));
    } catch {
        return [];
    }
}

function saveModifiers(configPath: string, modifiers: string[]): boolean {
    try {
        const file = Gio.File.new_for_path(configPath);
        const [, contents] = file.load_contents(null);
        const updated = writeModifiers(new TextDecoder().decode(contents), modifiers);
        if (updated === null) {
            return false;
        }
        file.replace_contents(new TextEncoder().encode(updated), null, false, Gio.FileCreateFlags.NONE, null);
        return true;
    } catch (error) {
        logError(error as Error, 'voxtype-osd: could not save the hotkey modifiers');
        return false;
    }
}

function hotkeyKeyval(key: string): number | null {
    const keycode = hotkeyKeycode(key);
    if (keycode === null) {
        return null;
    }

    const [found, , keyvals] = Gdk.Display.get_default()!.map_keycode(keycode);
    return found && keyvals !== null && keyvals.length > 0 ? keyvals[0] : null;
}

// Keys given by number are shown as the current layout's letter, the rest as voxtype names them.
function keyLabel(key: string): string {
    const keyval = hotkeyKeyval(key);
    return keyval === null ? key : Gtk.accelerator_get_label(keyval, 0);
}

// An accelerator for the shortcut label, or '' when it cannot show the keys faithfully, which means
// a key given by name or a right-hand modifier. The row then falls back to spelling them out.
function hotkeyAccelerator(key: string, modifiers: string[]): string {
    const keyval = hotkeyKeyval(key);
    if (keyval === null) {
        return '';
    }

    let mask = 0 as Gdk.ModifierType;
    for (const name of modifiers) {
        const flag = MASK_MODIFIERS.find(([, left]) => left === name)?.[0];
        if (flag === undefined) {
            return '';
        }
        mask |= flag;
    }
    return Gtk.accelerator_name(keyval, mask);
}

function findToggleBindings(): Gio.Settings[] {
    const paths = new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA }).get_strv('custom-keybindings');
    return paths
        .map(path => new Gio.Settings({ schema_id: CUSTOM_KEYBINDING_SCHEMA, path }))
        .filter(binding => binding.get_string('command').trim() === TOGGLE_COMMAND && binding.get_string('binding') !== '');
}

function removeToggleBindings(): void {
    const mediaKeys = new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA });
    const removed = findToggleBindings();
    const removedPaths = removed.map(binding => binding.path);

    mediaKeys.set_strv('custom-keybindings', mediaKeys.get_strv('custom-keybindings').filter(path => !removedPaths.includes(path)));
    for (const binding of removed) {
        for (const name of ['name', 'command', 'binding']) {
            binding.reset(name);
        }
    }
}

export function isUsableShortcut(keyval: number, mask: Gdk.ModifierType): boolean {
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

function heldModifiers(held: Set<string>, mask: Gdk.ModifierType): string[] {
    const modifiers = new Set(held);
    for (const [flag, left, right] of MASK_MODIFIERS) {
        if ((mask & flag) !== 0 && !modifiers.has(left) && !modifiers.has(right)) {
            modifiers.add(left);
        }
    }
    return [...modifiers];
}

// Hands back the keys pressed, or null when Backspace removes the shortcut.
function captureHotkey(window: Adw.PreferencesWindow, onCaptured: (hotkey: CapturedHotkey | null) => void): void {
    const dialog = new Adw.AlertDialog({
        heading: 'Set dictation shortcut',
        body: 'Press the new key combination.\nEsc cancels, Backspace removes the shortcut.',
    });
    dialog.add_response('cancel', 'Cancel');

    const held = new Set<string>();

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_controller, keyval: number, keycode: number, state: Gdk.ModifierType) => {
        const modifier = modifierName(keycode);
        if (modifier !== null) {
            held.add(modifier);
            return Gdk.EVENT_STOP;
        }

        const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
        const key = Gdk.keyval_to_lower(keyval);

        if (mask === 0 && key === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        if (mask === 0 && key === Gdk.KEY_BackSpace) {
            onCaptured(null);
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        if (!isUsableShortcut(key, mask)) {
            return Gdk.EVENT_STOP;
        }

        onCaptured({ key: hotkeyKeyName(keycode), modifiers: heldModifiers(held, mask) });
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    controller.connect('key-released', (_controller, _keyval: number, keycode: number) => {
        const modifier = modifierName(keycode);
        if (modifier !== null) {
            held.delete(modifier);
        }
    });
    dialog.add_controller(controller);

    dialog.present(window);
}
