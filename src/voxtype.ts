import Gio from 'gi://Gio';

// Shared by the shell extension and the preferences window, so only Gio here.

export type CommandResult = {
    ok: boolean;
    stdout: string;
    stderr: string;
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

export function toggleRecording(): Promise<CommandResult> {
    return run(['voxtype', 'record', 'toggle']);
}

export function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? '';
}
