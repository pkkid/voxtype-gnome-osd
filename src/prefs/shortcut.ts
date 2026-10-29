import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

// The dictation shortcut is a regular GNOME custom keyboard shortcut running `voxtype record toggle`,
// so it keeps working when the extension is disabled.
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_KEYBINDING_SCHEMA = `${MEDIA_KEYS_SCHEMA}.custom-keybinding`;
const CUSTOM_KEYBINDING_BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/';
const TOGGLE_COMMAND = 'voxtype record toggle';

export function findToggleBinding(): Gio.Settings | null {
    const mediaKeys = new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA });

    for (const path of mediaKeys.get_strv('custom-keybindings')) {
        const binding = new Gio.Settings({ schema_id: CUSTOM_KEYBINDING_SCHEMA, path });
        if (binding.get_string('command').trim() === TOGGLE_COMMAND) {
            return binding;
        }
    }

    return null;
}

export function ensureToggleBinding(): Gio.Settings {
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

export function captureShortcut(window: Adw.PreferencesWindow, onCaptured: (accelerator: string) => void): void {
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
