import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { serviceMemory } from '../systemd.js';
import { run } from '../voxtype.js';
import { formatBytes, gpuMemory } from './models.js';
import { restartIfRunning, setConfig } from './voxtypeConfig.js';

const MEMORY_POLL_SECS = 5;

type OnDemandSetting = {
    key: string;
    label: string;
    description: string;
    value: unknown;
};

export function buildMemoryGroup(window: Adw.PreferencesWindow, onDemand: OnDemandSetting | null): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Memory' });
    group.add(buildMemoryRow());

    if (onDemand !== null) {
        const row = new Adw.SwitchRow({
            title: onDemand.label,
            subtitle: onDemand.description,
            active: onDemand.value === true,
        });
        row.connect('notify::active', async () => {
            if (await setConfig(window, onDemand.key, row.active ? 'true' : 'false')) {
                await restartIfRunning(window);
            }
        });
        group.add(row);
    }

    return group;
}

// Measured only while the row is on screen, because asking about video memory runs nvidia-smi.
function buildMemoryRow(): Adw.ActionRow {
    const label = new Gtk.Label({ css_classes: ['dim-label'] });
    const row = new Adw.ActionRow({
        title: 'Memory in use',
        subtitle: 'Voxtype and the models it has loaded.',
    });
    row.add_suffix(label);

    const refresh = async () => {
        const [memory, accel] = await Promise.all([serviceMemory(), run(['voxtype', 'info', 'accel', '--json'])]);
        const video = accel.ok ? gpuMemory(accel.stdout) : null;

        if (memory === null) {
            label.label = 'Not running';
        } else {
            label.label = video === null ? formatBytes(memory) : `${formatBytes(memory)} + ${formatBytes(video)} on the GPU`;
        }
    };

    let pollId = 0;
    row.connect('map', () => {
        refresh();
        pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MEMORY_POLL_SECS, () => {
            refresh();
            return GLib.SOURCE_CONTINUE;
        });
    });
    row.connect('unmap', () => {
        GLib.source_remove(pollId);
        pollId = 0;
    });

    return row;
}
