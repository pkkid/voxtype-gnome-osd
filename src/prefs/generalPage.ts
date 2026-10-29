import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { isServiceActive, isServiceEnabled, setServiceEnabled, setServiceRunning } from '../systemd.js';
import { firstLine } from '../voxtype.js';
import { captureShortcut, ensureToggleBinding, findToggleBinding } from './shortcut.js';
import { showToast } from './window.js';

const SERVICE_POLL_SECS = 2;

export function buildGeneralPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
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
                showToast(window, `Could not ${runningRow.active ? 'start' : 'stop'} Voxtype: ${firstLine(result.stderr)}`);
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
                showToast(window, `Could not change autostart: ${firstLine(result.stderr)}`);
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
