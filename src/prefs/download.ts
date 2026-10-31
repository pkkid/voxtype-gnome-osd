import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export type RunningCommand = {
    cancel: () => void;
    finished: Promise<boolean>;
};

const READ_SIZE = 4096;

// Runs a long command, passing on each line it prints as it arrives. Progress bars rewrite their
// line with a carriage return rather than ending it, so that counts as a line ending too.
//
// The command gets its own process group, because voxtype downloads through a curl child that would
// otherwise carry on after voxtype itself is stopped.
export function runWithLines(argv: string[], onLine: (line: string) => void): RunningCommand {
    const process = Gio.Subprocess.new(['setsid', ...argv], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    const stdout = process.get_stdout_pipe()!;

    const pump = async () => {
        // GJS has no streaming decode, but the lines are ASCII so a chunk cannot end inside a character.
        const decoder = new TextDecoder();
        let pending = '';

        for (;;) {
            const bytes = await new Promise<GLib.Bytes>((resolve, reject) => {
                stdout.read_bytes_async(READ_SIZE, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try {
                        resolve(source!.read_bytes_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            if (bytes.get_size() === 0) {
                break;
            }

            pending += decoder.decode(bytes.toArray());
            const lines = pending.split(/[\r\n]+/);
            pending = lines.pop() ?? '';
            lines.forEach(onLine);
        }

        if (pending !== '') {
            onLine(pending);
        }
    };

    const exited = new Promise<boolean>(resolve => {
        process.wait_async(null, (source, result) => {
            try {
                source!.wait_finish(result);
                resolve(source!.get_successful());
            } catch {
                resolve(false);
            }
        });
    });

    return {
        cancel: () => {
            Gio.Subprocess.new(['kill', '-TERM', '--', `-${process.get_identifier()}`], Gio.SubprocessFlags.NONE);
        },
        finished: Promise.all([pump().catch(logError), exited]).then(([, succeeded]) => succeeded),
    };
}
