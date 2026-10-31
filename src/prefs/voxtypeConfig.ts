import Adw from 'gi://Adw';

import { isServiceActive, restartService } from '../systemd.js';
import { firstLine, run } from '../voxtype.js';
import { showToast } from './window.js';

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
