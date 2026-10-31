import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { isServiceActive, restartService } from '../systemd.js';
import { firstLine, run } from '../voxtype.js';
import { showToast } from './window.js';

const SYSTEM_CONFIG = '/etc/voxtype/config.toml';

// Until the user has a config of their own voxtype reads the system one, which it cannot save to, so
// every change would fail. Starting from a copy means the same settings, and voxtype keeps the comments.
export function ensureUserConfig(): void {
    const userConfig = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'voxtype', 'config.toml']));
    const systemConfig = Gio.File.new_for_path(SYSTEM_CONFIG);

    if (userConfig.query_exists(null) || !systemConfig.query_exists(null)) {
        return;
    }

    try {
        GLib.mkdir_with_parents(userConfig.get_parent()!.get_path()!, 0o755);
        systemConfig.copy(userConfig, Gio.FileCopyFlags.NONE, null, null);
    } catch (error) {
        logError(error as Error, 'voxtype-osd: could not create a config file');
    }
}

export async function setConfig(window: Adw.PreferencesWindow, key: string, value: string): Promise<boolean> {
    const result = await run(['voxtype', 'config', 'set', key, value]);
    if (!result.ok) {
        showToast(window, `Could not change ${key}: ${firstLine(result.stderr)}`);
    }
    return result.ok;
}

// For settings voxtype only reads at startup, where the change should simply take effect.
export async function restartIfRunning(window: Adw.PreferencesWindow): Promise<void> {
    if (!await isServiceActive()) {
        return;
    }

    const result = await restartService();
    if (!result.ok) {
        showToast(window, `Could not restart Voxtype: ${firstLine(result.stderr)}`);
    }
}
