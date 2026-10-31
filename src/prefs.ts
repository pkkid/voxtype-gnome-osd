import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { buildCleanupPage } from './prefs/cleanupPage.js';
import { buildGeneralPage } from './prefs/generalPage.js';
import { buildIndicatorPage } from './prefs/indicatorPage.js';
import { buildModelsPage } from './prefs/modelsPage.js';
import { buildSchemaPage, DICTATION_PAGE, NOTIFICATIONS_PAGE } from './prefs/schemaPage.js';
import { buildSystemPage } from './prefs/systemPage.js';
import { ensureUserConfig } from './prefs/voxtypeConfig.js';
import { setSidebarContent } from './prefs/window.js';

export default class VoxtypeOsdPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        window.set_default_size(880, 800);
        ensureUserConfig();
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!).add_search_path(`${this.path}/icons`);

        setSidebarContent(window, {
            title: this.metadata.name,
            subtitle: 'Settings',
            iconName: 'audio-input-microphone-symbolic',
        }, [
            buildGeneralPage(window, settings),
            buildIndicatorPage(window, settings),
            buildSchemaPage(window, DICTATION_PAGE),
            buildModelsPage(window),
            buildCleanupPage(window, settings),
            buildSchemaPage(window, NOTIFICATIONS_PAGE),
            buildSystemPage(window),
        ]);
    }
}
