import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { reloadUnits } from '../systemd.js';
import { CommandResult } from '../voxtype.js';

// Earlier versions turned the GPU on with VOXTYPE_GPU=1 in a drop-in on the user's own service, which
// the launcher /usr/bin/voxtype obeys. `voxtype setup` replaces that launcher, so this is only read
// until the next switch, and then cleared away.
function dropInFile(): Gio.File {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', 'voxtype.service.d', 'voxtype-osd-gpu.conf']));
}

export function hasGpuDropIn(): boolean {
    return dropInFile().query_exists(null);
}

export async function removeGpuDropIn(): Promise<CommandResult> {
    if (!hasGpuDropIn()) {
        return { ok: true, stdout: '', stderr: '' };
    }

    try {
        dropInFile().delete(null);
    } catch (error) {
        return { ok: false, stdout: '', stderr: String(error) };
    }

    return reloadUnits();
}
