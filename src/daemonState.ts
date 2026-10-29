import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// 'streaming' is recording with live dictation ([parakeet] streaming = true): text is typed while
// you speak instead of after you stop.
export type DaemonState = 'unavailable' | 'idle' | 'recording' | 'streaming' | 'transcribing';

const KNOWN_STATES: DaemonState[] = ['idle', 'recording', 'streaming', 'transcribing'];

// True while the microphone is live, with or without live dictation.
export function isRecording(state: DaemonState): boolean {
    return state === 'recording' || state === 'streaming';
}

function stateFilePath(): string {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'voxtype', 'state']);
}

function toDaemonState(contents: string): DaemonState {
    const trimmed = contents.trim();

    for (const candidate of KNOWN_STATES) {
        if (candidate === trimmed) {
            return candidate;
        }
    }

    return 'unavailable';
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
                    next = toDaemonState(new TextDecoder().decode(contents));
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
