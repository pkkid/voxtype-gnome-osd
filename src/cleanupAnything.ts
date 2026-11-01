import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { chooseClipboardType, configValue, DoubleTap, isTerminal, restoreOuterSpace } from './cleanupRules.js';
import { CommandResult, firstLine, run } from './voxtype.js';

const shell = Shell.Global.get();

const TITLE = 'Cleanup Anything';
const COMMAND_KEY = 'output.post_process.command';
const TIMEOUT_KEY = 'output.post_process.timeout_ms';
const DEFAULT_TIMEOUT_MS = 30000;

const COPY_TIMEOUT_MS = 600;
const POLL_MS = 40;
// Apps read the clipboard after the keys arrive, so it has to stay in place for a moment.
const PASTE_SETTLE_MS = 300;
// Long enough for the app to act on one shortcut before the next arrives.
const KEY_GAP_MS = 30;
const RELEASE_TIMEOUT_MS = 2000;

const HELD_KEYS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK
    | Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.META_MASK;

type SavedClipboard = { type: string; bytes: Uint8Array } | null;

// Double tap Left Ctrl or press a shortcut: selects and copies the focused field, runs the cleanup
// command over it, pastes the result over it and puts the clipboard back. Not a voxtype feature, but
// it shares voxtype's cleanup command. Runs in the shell, so it can reach the clipboard and send keys
// without tools like ydotool, and takes no notice of any key but its own trigger.
export class CleanupAnything {
    private readonly clipboard = St.Clipboard.get_default();
    private readonly doubleTap = new DoubleTap();
    private readonly settingsIds: number[];
    private keyboard: Clutter.VirtualInputDevice | null = null;
    private tapId = 0;
    private bound = false;
    private job: Gio.Cancellable | null = null;
    private sleeping = new Map<number, () => void>();

    constructor(private readonly settings: Gio.Settings, private readonly onBusy: (busy: boolean) => void) {
        this.settingsIds = [
            settings.connect('changed::cleanup-anything-enabled', () => this.applySettings()),
            settings.connect('changed::cleanup-anything-trigger', () => this.applySettings()),
        ];
        this.applySettings();
    }

    destroy(): void {
        this.settingsIds.forEach(id => this.settings.disconnect(id));
        this.removeTrigger();
        this.job?.cancel();
        for (const [id, wake] of this.sleeping) {
            GLib.source_remove(id);
            wake();
        }
        this.sleeping.clear();
    }

    private applySettings(): void {
        this.removeTrigger();
        if (!this.settings.get_boolean('cleanup-anything-enabled')) {
            return;
        }

        if (this.settings.get_string('cleanup-anything-trigger') === 'shortcut') {
            this.bound = true;
            Main.wm.addKeybinding('cleanup-anything-shortcut', this.settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL, () => this.trigger());
            return;
        }

        // The signal behind GNOME's Locate Pointer. It fires for every lone tap of the key in the
        // locate-pointer-key setting, Left Ctrl unless changed, whether Locate Pointer is on or not.
        this.tapId = shell.connect('locate-pointer', () => {
            if (this.doubleTap.feed(GLib.get_monotonic_time() / 1000) && (Main.actionMode as Shell.ActionMode) === Shell.ActionMode.NORMAL) {
                this.trigger();
            }
        });
    }

    private removeTrigger(): void {
        if (this.bound) {
            Main.wm.removeKeybinding('cleanup-anything-shortcut');
            this.bound = false;
        }
        if (this.tapId !== 0) {
            shell.disconnect(this.tapId);
            this.tapId = 0;
        }
    }

    // The trigger cancels a cleanup that is still running.
    private trigger(): void {
        if (this.job !== null) {
            this.job.cancel();
            return;
        }

        const window = shell.display.focus_window;
        if (window === null) {
            return;
        }
        if (isTerminal(window.get_wm_class())) {
            Main.notify(TITLE, 'Skipped this terminal, because Ctrl+C would interrupt what is running in it.');
            return;
        }

        const job = new Gio.Cancellable();
        this.job = job;
        this.onBusy(true);
        this.cleanUp(window, job).catch(error => {
            logError(error as Error, 'voxtype-osd: Cleanup Anything failed');
            Main.notifyError(TITLE, `Left your text alone: ${firstLine(String(error))}`);
        }).finally(() => {
            this.job = null;
            this.onBusy(false);
        });
    }

    private async cleanUp(window: Meta.Window, job: Gio.Cancellable): Promise<void> {
        const saved = await this.saveClipboard();
        try {
            const message = await this.replaceField(window, job);
            if (message !== null && !job.is_cancelled()) {
                Main.notify(TITLE, `Left your text alone: ${message}`);
            }
        } finally {
            this.restoreClipboard(saved);
        }
    }

    // Returns why the field was left alone, or null when there is nothing to report.
    private async replaceField(window: Meta.Window, job: Gio.Cancellable): Promise<string | null> {
        const text = await this.copyField(job);
        if (job.is_cancelled()) {
            return null;
        }
        if (text.trim() === '') {
            return 'nothing was copied.';
        }

        const limit = this.settings.get_int('cleanup-anything-max-chars');
        if (text.length > limit) {
            return `it is over the ${limit} character limit.`;
        }

        const { command, timeoutMs } = await this.findCommand();
        if (command === null) {
            return 'no cleanup command is set. Choose one on the Cleanup tab in Settings.';
        }

        const result = await runCleanup(command, text, timeoutMs, job);
        if (job.is_cancelled()) {
            return null;
        }
        if (!result.ok) {
            return `${firstLine(result.stderr) || 'the cleanup command failed'}.`.replace(/\.+$/, '.');
        }

        const cleaned = restoreOuterSpace(text, result.stdout);
        if (cleaned === text) {
            return null;
        }
        if (result.stdout.trim() === '') {
            return 'the cleanup command returned nothing.';
        }

        // Cleanup takes a few seconds, and the person may have moved on or kept typing since.
        if (shell.display.focus_window !== window) {
            return 'you moved to another window.';
        }
        if (await this.copyField(job) !== text || job.is_cancelled()) {
            return 'it changed while it was being cleaned up.';
        }

        await this.waitForKeysUp();
        this.clipboard.set_text(St.ClipboardType.CLIPBOARD, cleaned);
        await this.sleep(POLL_MS);
        this.press(Clutter.KEY_Control_L, Clutter.KEY_v);
        await this.sleep(PASTE_SETTLE_MS);
        return null;
    }

    private async findCommand(): Promise<{ command: string | null; timeoutMs: number }> {
        const [command, timeout] = await Promise.all([run(['voxtype', 'config', 'get', COMMAND_KEY]), run(['voxtype', 'config', 'get', TIMEOUT_KEY])]);

        return {
            command: (command.ok ? configValue(command.stdout) : null) ?? configValue(this.settings.get_string('cleanup-command')),
            timeoutMs: (timeout.ok ? Number(configValue(timeout.stdout)) : 0) || DEFAULT_TIMEOUT_MS,
        };
    }

    private async copyField(job: Gio.Cancellable): Promise<string> {
        await this.waitForKeysUp();
        this.clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        await this.sleep(POLL_MS);
        this.press(Clutter.KEY_Control_L, Clutter.KEY_a);
        await this.sleep(KEY_GAP_MS);
        this.press(Clutter.KEY_Control_L, Clutter.KEY_c);

        for (let waited = 0; waited < COPY_TIMEOUT_MS && !job.is_cancelled(); waited += POLL_MS) {
            await this.sleep(POLL_MS);
            const text = await this.clipboardText();
            if (text !== '') {
                return text;
            }
        }
        return '';
    }

    // Keys the person is still holding, like those of a shortcut, would change what we send.
    private async waitForKeysUp(): Promise<void> {
        for (let waited = 0; waited < RELEASE_TIMEOUT_MS; waited += POLL_MS) {
            const [, , mask] = shell.get_pointer();
            if ((mask & HELD_KEYS) === 0) {
                return;
            }
            await this.sleep(POLL_MS);
        }
        throw new Error('keys were still held down');
    }

    private press(modifier: number, key: number): void {
        this.keyboard ??= shell.stage.get_context().get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        const send = (keyval: number, state: Clutter.KeyState) => this.keyboard!.notify_keyval(GLib.get_monotonic_time(), keyval, state);
        send(modifier, Clutter.KeyState.PRESSED);
        send(key, Clutter.KeyState.PRESSED);
        send(key, Clutter.KeyState.RELEASED);
        send(modifier, Clutter.KeyState.RELEASED);
    }

    private clipboardText(): Promise<string> {
        return new Promise(resolve => {
            this.clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text ?? ''));
        });
    }

    private saveClipboard(): Promise<SavedClipboard> {
        const type = chooseClipboardType(this.clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD));
        if (type === null) {
            return Promise.resolve(null);
        }

        return new Promise(resolve => {
            this.clipboard.get_content(St.ClipboardType.CLIPBOARD, type, (_clipboard, bytes) => {
                // The bytes only live as long as this callback, so they have to be copied.
                resolve(bytes === null ? null : { type, bytes: (bytes instanceof GLib.Bytes ? bytes.toArray() : bytes).slice() });
            });
        });
    }

    private restoreClipboard(saved: SavedClipboard): void {
        if (saved === null) {
            this.clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        } else {
            this.clipboard.set_content(St.ClipboardType.CLIPBOARD, saved.type, saved.bytes);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this.sleeping.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this.sleeping.set(id, resolve);
        });
    }
}

// Pipes the text through the command. It gets its own process group, because cleanup commands tend
// to start other programs, and stopping only the shell would leave them running.
function runCleanup(command: string, input: string, timeoutMs: number, job: Gio.Cancellable): Promise<CommandResult> {
    return new Promise(resolve => {
        let process: Gio.Subprocess;
        try {
            process = Gio.Subprocess.new(['setsid', 'sh', '-c', command], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            resolve({ ok: false, stdout: '', stderr: String(error) });
            return;
        }

        const stop = () => {
            const id = process.get_identifier();
            if (id !== null) {
                Gio.Subprocess.new(['kill', '-TERM', '--', `-${id}`], Gio.SubprocessFlags.NONE);
            }
        };

        let timedOut = false;
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timedOut = true;
            stop();
            return GLib.SOURCE_REMOVE;
        });
        const cancelId = job.connect(stop);

        process.communicate_utf8_async(input, null, (source, result) => {
            if (!timedOut) {
                GLib.source_remove(timer);
            }
            job.disconnect(cancelId);
            try {
                const [, stdout, stderr] = source!.communicate_utf8_finish(result);
                resolve({ ok: source!.get_successful(), stdout: stdout ?? '', stderr: timedOut ? 'the cleanup command timed out' : stderr ?? '' });
            } catch (error) {
                resolve({ ok: false, stdout: '', stderr: String(error) });
            }
        });
    });
}
