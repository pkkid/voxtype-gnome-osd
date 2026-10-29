import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { buildGeneralPage } from './prefs/generalPage.js';
import { buildIndicatorPage } from './prefs/indicatorPage.js';
import { buildVoxtypePage } from './prefs/voxtypePage.js';
import { setSidebarContent } from './prefs/window.js';

export default class VoxtypeOsdPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        window.set_default_size(880, 800);

        setSidebarContent(window, {
            title: this.metadata.name,
            subtitle: 'Settings',
            iconName: 'audio-input-microphone-symbolic',
        }, [
            buildGeneralPage(window, settings),
            buildIndicatorPage(settings),
            buildVoxtypePage(window),
        ]);
    }
}
