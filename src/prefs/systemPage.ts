import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { buildSchemaPage } from './schemaPage.js';
import { buildStorageGroup } from './storage.js';
import { showToast } from './window.js';

export function buildSystemPage(window: Adw.PreferencesWindow): Adw.PreferencesPage {
    return buildSchemaPage(window, {
        name: 'system',
        title: 'System',
        icon: 'preferences-other-symbolic',
        groups: [],
        fill: (page, configPath) => {
            const storage = buildStorageGroup(window);
            page.add(storage.group);
            page.add(buildConfigGroup(window, configPath));

            // Models come and go from the Models page, so measure again each time this page is shown.
            storage.refresh();
            page.connect('map', storage.refresh);
        },
    });
}

function buildConfigGroup(window: Adw.PreferencesWindow, configPath: string): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Advanced Configuration',
        description: 'Voxtype has many more options than fit here. Edit the file, then turn Voxtype off and on again from the panel menu.',
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
        } catch {
            showToast(window, `Could not open ${configPath}`);
        }
    });
    group.add(fileRow);

    return group;
}
