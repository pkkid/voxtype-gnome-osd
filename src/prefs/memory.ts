import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { serviceMemory } from '../systemd.js';
import { run } from '../voxtype.js';
import { formatBytes, gpuMemory, modelLocation, modelPlace, onGpuBuild } from './models.js';
import { refreshSchemaPages } from './schemaPage.js';
import { restartIfRunning, setConfig } from './voxtypeConfig.js';

const MEMORY_POLL_SECS = 5;

const ON_DEMAND_NOTE = 'Loads the model when you start dictating and unloads it when you finish, freeing its system or GPU memory. The first words take a moment longer.';
const ON_DEMAND_LIVE_NOTE = 'Live transcription cannot be used with this on.';

type OnDemandSetting = {
    key: string;
    label: string;
    value: unknown;
};

type RunsOptions = {
    gpuRow: Adw.SwitchRow | null;
    onDemand: OnDemandSetting | null;
    // Voxtype silently drops live transcription for Whisper when it has to load on demand.
    liveLocked: boolean;
    modelsDir: string;
    modelsBytes: number;
};

export function buildRunsGroup(window: Adw.PreferencesWindow, { gpuRow, onDemand, liveLocked, modelsDir, modelsBytes }: RunsOptions): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Where it runs' });
    if (gpuRow !== null) {
        group.add(gpuRow);
    }

    const isOnDemand = onDemand?.value === true;
    if (onDemand !== null) {
        const row = new Adw.SwitchRow({
            title: onDemand.label,
            subtitle: liveLocked ? `${ON_DEMAND_NOTE} ${ON_DEMAND_LIVE_NOTE}` : ON_DEMAND_NOTE,
            active: isOnDemand,
            sensitive: isOnDemand || !liveLocked,
        });
        row.connect('notify::active', async () => {
            if (await setConfig(window, onDemand.key, row.active ? 'true' : 'false')) {
                await restartIfRunning(window);
                refreshSchemaPages(window);
            }
        });
        group.add(row);
    }

    // Anything but a row lands below the list, which keeps this reading as information, not an option.
    group.add(buildFolderSummary(modelsDir, modelsBytes));
    group.add(buildMemorySummary(isOnDemand));
    return group;
}

// Measured only while it is on screen, because asking about video memory runs nvidia-smi.
function buildMemorySummary(isOnDemand: boolean): Gtk.Label {
    const label = buildSummaryLabel();

    const refresh = async () => {
        const [memory, accel] = await Promise.all([serviceMemory(), run(['voxtype', 'info', 'accel', '--json'])]);
        if (memory === null) {
            label.label = 'Voxtype is not running.';
            return;
        }

        const location = accel.ok ? modelLocation(accel.stdout) : null;
        const video = accel.ok ? gpuMemory(accel.stdout) : null;
        const showVideo = accel.ok && location !== 'cpu' && onGpuBuild(accel.stdout);
        label.label = [
            modelPlace(location, isOnDemand),
            `${formatBytes(memory)} of system memory is in use.`,
            ...(showVideo ? [video !== null || isOnDemand ? `${video ? formatBytes(video) : '0 MB'} of GPU memory is in use.` : 'Your GPU does not report its memory use.'] : []),
        ].join('\n');
    };

    let pollId = 0;
    label.connect('map', () => {
        refresh();
        pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MEMORY_POLL_SECS, () => {
            refresh();
            return GLib.SOURCE_CONTINUE;
        });
    });
    label.connect('unmap', () => {
        GLib.source_remove(pollId);
        pollId = 0;
    });

    return label;
}

// The path is a link because this is the only way to the folder in the Settings window.
function buildFolderSummary(modelsDir: string, modelsBytes: number): Gtk.Label {
    const label = buildSummaryLabel();
    label.margin_top = 10;
    const uri = GLib.markup_escape_text(GLib.filename_to_uri(modelsDir, null), -1);
    const path = GLib.markup_escape_text(modelsDir, -1);
    label.set_markup(`Models are stored in <a href="${uri}">${path}</a> and use ${formatBytes(modelsBytes)}.`);
    return label;
}

function buildSummaryLabel(): Gtk.Label {
    return new Gtk.Label({
        xalign: 0,
        wrap: true,
        margin_start: 12,
        margin_end: 12,
        css_classes: ['caption', 'dimmed'],
    });
}
