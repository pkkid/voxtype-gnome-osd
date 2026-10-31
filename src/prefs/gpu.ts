import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { reloadUnits } from '../systemd.js';
import { CommandResult } from '../voxtype.js';

// `voxtype setup gpu --enable` needs root, but the launcher starts the Vulkan build for anyone who
// sets VOXTYPE_GPU=1, so a drop-in on the user's own service is enough.
const DROP_IN = '[Service]\nEnvironment=VOXTYPE_GPU=1\n';

function dropInFile(): Gio.File {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', 'voxtype.service.d', 'voxtype-osd-gpu.conf']));
}

export function isGpuEnabled(): boolean {
    return dropInFile().query_exists(null);
}

export async function setGpuEnabled(enabled: boolean): Promise<CommandResult> {
    const file = dropInFile();

    try {
        if (enabled) {
            GLib.mkdir_with_parents(file.get_parent()!.get_path()!, 0o755);
            file.replace_contents(new TextEncoder().encode(DROP_IN), null, false, Gio.FileCreateFlags.NONE, null);
        } else {
            file.delete(null);
        }
    } catch (error) {
        return { ok: false, stdout: '', stderr: String(error) };
    }

    return reloadUnits();
}
