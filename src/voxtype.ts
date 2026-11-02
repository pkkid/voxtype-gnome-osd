import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Shared by the shell extension and the preferences window, so only Gio and GLib here.

const READ_SIZE = 4096;
const KILL_DELAY_MS = 2000;

export type CommandResult = {
    ok: boolean;
    stdout: string;
    stderr: string;
};

export type CommandLimits = {
    input: string;
    timeoutMs: number;
    maxOutputBytes: number;
    cancellable: Gio.Cancellable;
};

export function run(argv: string[]): Promise<CommandResult> {
    return new Promise(resolve => {
        let process: Gio.Subprocess;

        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            resolve({ ok: false, stdout: '', stderr: String(error) });
            return;
        }

        process.communicate_utf8_async(null, null, (source, result) => {
            try {
                const [, stdout, stderr] = source!.communicate_utf8_finish(result);
                resolve({ ok: source!.get_successful(), stdout: stdout ?? '', stderr: stderr ?? '' });
            } catch (error) {
                resolve({ ok: false, stdout: '', stderr: String(error) });
            }
        });
    });
}

// Runs a command nobody can vouch for, which is why it has limits. It gets its own process group,
// because such commands tend to start others, and stopping only the first would leave them running.
// What it prints is kept in the shell's own memory, so too much of it stops the command.
export function runLimited(argv: string[], { input, timeoutMs, maxOutputBytes, cancellable }: CommandLimits): Promise<CommandResult> {
    return new Promise(resolve => {
        let process: Gio.Subprocess;
        try {
            process = Gio.Subprocess.new(['setsid', ...argv], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            resolve({ ok: false, stdout: '', stderr: String(error) });
            return;
        }

        const reads = new Gio.Cancellable();
        let problem: string | null = null;
        let killId = 0;

        const stop = (why: string) => {
            problem ??= why;
            if (killId !== 0) {
                return;
            }
            signalProcessGroup(process, 'TERM');
            killId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KILL_DELAY_MS, () => {
                signalProcessGroup(process, 'KILL');
                // Something that left the process group could still hold the pipes open.
                reads.cancel();
                killId = -1;
                return GLib.SOURCE_REMOVE;
            });
        };

        let timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timerId = 0;
            stop('the cleanup command timed out');
            return GLib.SOURCE_REMOVE;
        });
        const cancelId = cancellable.connect(() => stop('the cleanup command was cancelled'));

        Promise.all([
            readAll(process.get_stdout_pipe()!, maxOutputBytes, reads, stop),
            readAll(process.get_stderr_pipe()!, maxOutputBytes, reads, stop),
            writeAll(process.get_stdin_pipe()!, input, reads),
            waitForExit(process, reads),
        ]).then(([stdout, stderr, , exited]) => {
            if (timerId !== 0) {
                GLib.source_remove(timerId);
            }
            if (killId > 0) {
                GLib.source_remove(killId);
            }
            cancellable.disconnect(cancelId);

            try {
                const decoder = new TextDecoder('utf-8', { fatal: true });
                const ok = problem === null && exited && process.get_successful();
                resolve({ ok, stdout: decoder.decode(stdout), stderr: problem ?? decoder.decode(stderr) });
            } catch (error) {
                resolve({ ok: false, stdout: '', stderr: String(error) });
            }
        });
    });
}

export function readChunk(stream: Gio.InputStream, cancellable: Gio.Cancellable | null = null): Promise<GLib.Bytes> {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(READ_SIZE, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                resolve(source!.read_bytes_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export function signalProcessGroup(process: Gio.Subprocess, signal: 'TERM' | 'KILL'): void {
    const id = process.get_identifier();
    if (id !== null) {
        Gio.Subprocess.new(['kill', `-${signal}`, '--', `-${id}`], Gio.SubprocessFlags.NONE);
    }
}

// Everything `stream` gives, or nothing if that goes over the limit or reading fails.
async function readAll(stream: Gio.InputStream, limit: number, cancellable: Gio.Cancellable, stop: (why: string) => void): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
        let bytes: GLib.Bytes;
        try {
            bytes = await readChunk(stream, cancellable);
        } catch (error) {
            stop(String(error));
            return new Uint8Array();
        }

        if (bytes.get_size() === 0) {
            break;
        }
        size += bytes.get_size();
        if (size > limit) {
            stop('the cleanup command printed too much');
            return new Uint8Array();
        }
        chunks.push(bytes.toArray().slice());
    }

    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
    }
    return all;
}

// Fine if the command never reads it, or goes before it is all written.
function writeAll(stream: Gio.OutputStream, text: string, cancellable: Gio.Cancellable): Promise<void> {
    return new Promise(resolve => {
        const source = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode(text)));
        const flags = Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET;
        stream.splice_async(source, flags, GLib.PRIORITY_DEFAULT, cancellable, (target, result) => {
            try {
                target!.splice_finish(result);
            } catch {
                // See above.
            }
            resolve();
        });
    });
}

function waitForExit(process: Gio.Subprocess, cancellable: Gio.Cancellable): Promise<boolean> {
    return new Promise(resolve => {
        process.wait_async(cancellable, (source, result) => {
            try {
                source!.wait_finish(result);
                resolve(true);
            } catch {
                resolve(false);
            }
        });
    });
}

export function toggleRecording(): Promise<CommandResult> {
    return run(['voxtype', 'record', 'toggle']);
}

export function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? '';
}
