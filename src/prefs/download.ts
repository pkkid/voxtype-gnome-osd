import Gio from 'gi://Gio';

import { readChunk, signalProcessGroup } from '../voxtype.js';

export type RunningCommand = {
    cancel: () => void;
    finished: Promise<boolean>;
};

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
            const bytes = await readChunk(stdout);
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
        cancel: () => signalProcessGroup(process, 'TERM'),
        finished: Promise.all([pump().catch(logError), exited]).then(([, succeeded]) => succeeded),
    };
}
