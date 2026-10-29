import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { CommandResult } from './voxtype.js';

// voxtype.service is controlled through the systemd user manager's D-Bus API rather than by
// spawning systemctl. Shared by the shell extension and the preferences window, so only Gio here.

const SERVICE = 'voxtype.service';
const SYSTEMD = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER = 'org.freedesktop.systemd1.Manager';

export function setServiceRunning(running: boolean): Promise<CommandResult> {
    return attempt(() => callManager(running ? 'StartUnit' : 'StopUnit', new GLib.Variant('(ss)', [SERVICE, 'replace'])));
}

export function restartService(): Promise<CommandResult> {
    return attempt(() => callManager('RestartUnit', new GLib.Variant('(ss)', [SERVICE, 'replace'])));
}

// Same meaning as `systemctl --user enable|disable`, including the daemon reload it does afterwards.
export function setServiceEnabled(enabled: boolean): Promise<CommandResult> {
    return attempt(async () => {
        if (enabled) {
            await callManager('EnableUnitFiles', new GLib.Variant('(asbb)', [[SERVICE], false, false]));
        } else {
            await callManager('DisableUnitFiles', new GLib.Variant('(asb)', [[SERVICE], false]));
        }
        await callManager('Reload', null);
    });
}

export async function isServiceActive(): Promise<boolean> {
    try {
        const [unitPath] = (await callManager('LoadUnit', new GLib.Variant('(s)', [SERVICE]))).deepUnpack<[string]>();
        const [state] = (await call(unitPath, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.freedesktop.systemd1.Unit', 'ActiveState']))).recursiveUnpack<[string]>();
        return state === 'active' || state === 'reloading';
    } catch {
        return false;
    }
}

export async function isServiceEnabled(): Promise<boolean> {
    try {
        const [state] = (await callManager('GetUnitFileState', new GLib.Variant('(s)', [SERVICE]))).deepUnpack<[string]>();
        return state === 'enabled' || state === 'enabled-runtime';
    } catch {
        return false;
    }
}

function callManager(method: string, parameters: GLib.Variant | null): Promise<GLib.Variant> {
    return call(MANAGER_PATH, MANAGER, method, parameters);
}

function call(objectPath: string, iface: string, method: string, parameters: GLib.Variant | null): Promise<GLib.Variant> {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(SYSTEMD, objectPath, iface, method, parameters, null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try {
                resolve(connection!.call_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

// Runs a D-Bus request and reports it the way a command would: ok, or the error message as stderr.
async function attempt(request: () => Promise<unknown>): Promise<CommandResult> {
    try {
        await request();
        return { ok: true, stdout: '', stderr: '' };
    } catch (error) {
        if (error instanceof GLib.Error) {
            Gio.DBusError.strip_remote_error(error);
        }
        return { ok: false, stdout: '', stderr: error instanceof Error || error instanceof GLib.Error ? error.message : String(error) };
    }
}
