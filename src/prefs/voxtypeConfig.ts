import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { isServiceActive, restartService } from '../systemd.js';
import { firstLine, run } from '../voxtype.js';
import { setRestartNotice, showToast } from './window.js';

const SYSTEM_CONFIG = '/etc/voxtype/config.toml';
const MAX_RECORDING_KEY = 'audio.max_duration_secs';
const MAX_RECORDING_SECS = '300';

// Until the user has a config of their own voxtype reads the system one, which it cannot save to, so
// every change would fail. Starting from a copy means the same settings, and voxtype keeps the comments.
// Its 60 second limit cuts off a long dictation, so that one starts higher. Returns whether it made one.
export async function ensureUserConfig(window: Adw.PreferencesWindow): Promise<boolean> {
    const userConfig = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'voxtype', 'config.toml']));
    const systemConfig = Gio.File.new_for_path(SYSTEM_CONFIG);

    if (userConfig.query_exists(null) || !systemConfig.query_exists(null)) {
        return false;
    }

    try {
        GLib.mkdir_with_parents(userConfig.get_parent()!.get_path()!, 0o755);
        systemConfig.copy(userConfig, Gio.FileCopyFlags.NONE, null, null);
    } catch (error) {
        logError(error as Error, 'voxtype-osd: could not create a config file');
        return false;
    }

    await setConfig(window, MAX_RECORDING_KEY, MAX_RECORDING_SECS);
    return true;
}

export async function setConfig(window: Adw.PreferencesWindow, key: string, value: string): Promise<boolean> {
    const result = await run(['voxtype', 'config', 'set', key, value]);
    if (!result.ok) {
        showToast(window, `Could not change ${key}: ${firstLine(result.stderr)}`);
    }
    return result.ok;
}

// Stopped, voxtype reads the change when it next starts, so there is nothing to ask for.
export async function noteRestartNeeded(window: Adw.PreferencesWindow): Promise<void> {
    if (await isServiceActive()) {
        setRestartNotice(window, true);
    }
}

// For settings voxtype only reads at startup, where the change should simply take effect.
export async function restartIfRunning(window: Adw.PreferencesWindow): Promise<void> {
    if (!await isServiceActive()) {
        return;
    }

    const result = await restartService();
    if (result.ok) {
        setRestartNotice(window, false);
    } else {
        showToast(window, `Could not restart Voxtype: ${firstLine(result.stderr)}`);
    }
}
