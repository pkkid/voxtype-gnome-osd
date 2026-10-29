import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { AudioSample, parseBridgeLine } from './levels.js';

const BRIDGE_COMMAND = ['voxtype-audio-bridge'];

export class AudioBridge {
    private readonly onSample: (sample: AudioSample) => void;
    private process: Gio.Subprocess | null = null;
    private stream: Gio.DataInputStream | null = null;
    private cancellable: Gio.Cancellable | null = null;

    constructor(onSample: (sample: AudioSample) => void) {
        this.onSample = onSample;
    }

    start(): void {
        if (this.process !== null) {
            return;
        }

        try {
            this.process = Gio.Subprocess.new(BRIDGE_COMMAND, Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (error) {
            logError(error as Error, 'voxtype-osd: could not launch voxtype-audio-bridge');
            this.process = null;
            return;
        }

        this.cancellable = new Gio.Cancellable();
        this.stream = new Gio.DataInputStream({ base_stream: this.process.get_stdout_pipe()! });
        this.readNextLine(this.stream);
    }

    stop(): void {
        // A read is always pending, so closing the stream synchronously fails with
        // "Stream has outstanding operation". Cancelling the read and killing the
        // bridge closes the pipe from the other end instead.
        this.cancellable?.cancel();
        this.cancellable = null;
        this.stream = null;

        this.process?.force_exit();
        this.process = null;
    }

    private readNextLine(stream: Gio.DataInputStream): void {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this.cancellable, (source, result) => {
            let line: string | null = null;

            try {
                const [raw] = source!.read_line_finish_utf8(result);
                line = raw;
            } catch (error) {
                if (error instanceof Gio.IOErrorEnum && error.code === Gio.IOErrorEnum.CANCELLED) {
                    return;
                }

                logError(error as Error, 'voxtype-osd: audio bridge read failed');
                this.stop();
                return;
            }

            if (this.stream !== stream) {
                return;
            }

            if (line === null) {
                log('voxtype-osd: audio bridge closed its output');
                this.stop();
                return;
            }

            const sample = parseBridgeLine(line);
            if (sample !== null) {
                this.onSample(sample);
            }

            this.readNextLine(stream);
        });
    }
}
