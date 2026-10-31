import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { accentColor, parseHexColor, rgbToHex } from '../color.js';
import { run } from '../voxtype.js';
import { buildStylePickerGroup } from './stylePicker.js';
import { restartIfRunning, setConfig } from './voxtypeConfig.js';

export function buildIndicatorPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
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
    showGroup.add(buildVoxtypeDisplayRow(window));
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

// Voxtype's own floating panel. It reads voxtype's config, so it stays hidden if voxtype cannot answer.
function buildVoxtypeDisplayRow(window: Adw.PreferencesWindow): Adw.SwitchRow {
    const row = new Adw.SwitchRow({
        title: 'Show Voxtype\'s own display',
        subtitle: 'The floating waveform panel from Voxtype itself, shown alongside this indicator. Changing this restarts Voxtype.',
        visible: false,
    });

    run(['voxtype', 'config', 'get', 'osd.enabled']).then(result => {
        if (!result.ok) {
            return;
        }

        row.active = result.stdout.trim() === 'true';
        row.visible = true;

        let reverting = false;
        row.connect('notify::active', async () => {
            if (reverting) {
                return;
            }

            if (await setConfig(window, 'osd.enabled', row.active ? 'true' : 'false')) {
                await restartIfRunning(window);
            } else {
                reverting = true;
                row.active = !row.active;
                reverting = false;
            }
        });
    });

    return row;
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
