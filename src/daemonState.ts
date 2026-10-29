import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { DaemonState, parseStateFile } from './states.js';

export { DaemonState, isRecording } from './states.js';

function stateFilePath(): string {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'voxtype', 'state']);
}

export class DaemonStateWatcher {
    private readonly file: Gio.File;
    private readonly onChange: (state: DaemonState) => void;
    private directoryMonitor: Gio.FileMonitor | null = null;
    private cancellable: Gio.Cancellable | null = null;
    private current: DaemonState = 'unavailable';

    constructor(onChange: (state: DaemonState) => void) {
        this.file = Gio.File.new_for_path(stateFilePath());
        this.onChange = onChange;
    }

    start(): void {
        this.cancellable = new Gio.Cancellable();

        const directory = this.file.get_parent();
        if (directory !== null) {
            try {
                this.directoryMonitor = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            } catch (error) {
                logError(error as Error, 'voxtype-osd: could not watch the voxtype runtime directory');
                this.directoryMonitor = null;
            }

            this.directoryMonitor?.connect('changed', (_monitor, changed) => {
                if (changed.get_basename() === this.file.get_basename()) {
                    this.reload();
                }
            });
        }

        this.reload();
    }

    stop(): void {
        this.cancellable?.cancel();
        this.cancellable = null;

        this.directoryMonitor?.cancel();
        this.directoryMonitor = null;
    }

    private reload(): void {
        this.file.load_contents_async(this.cancellable, (source, result) => {
            let next: DaemonState = 'unavailable';

            try {
                const [ok, contents] = source!.load_contents_finish(result);
                if (ok) {
                    next = parseStateFile(new TextDecoder().decode(contents));
                }
            } catch (error) {
                if (error instanceof Gio.IOErrorEnum && error.code === Gio.IOErrorEnum.CANCELLED) {
                    return;
                }
                next = 'unavailable';
            }

            if (next !== this.current) {
                this.current = next;
                this.onChange(next);
            }
        });
    }
}
