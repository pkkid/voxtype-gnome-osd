import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { addsLink, chooseClipboardType, configValue, DoubleTap, fillPrompt, isTerminal, restoreOuterSpace } from './cleanupRules.js';
import { firstLine, run, runLimited } from './voxtype.js';

const shell = Shell.Global.get();

function inNormalMode(): boolean {
    return (Main.actionMode as Shell.ActionMode) === Shell.ActionMode.NORMAL;
}

const TITLE = 'Cleanup Hotkey';
const COMMAND_KEY = 'output.post_process.command';
const TIMEOUT_KEY = 'output.post_process.timeout_ms';
const DEFAULT_TIMEOUT_MS = 30000;

const COPY_TIMEOUT_MS = 600;
const CLIPBOARD_TIMEOUT_MS = 2000;
// Far more than any cleaned up text, which is at most a little longer than the longest field.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const POLL_MS = 40;
// Apps read the clipboard after the keys arrive, so it has to stay in place for a moment.
const PASTE_SETTLE_MS = 300;
// Long enough for the app to act on one shortcut before the next arrives.
const KEY_GAP_MS = 30;
const RELEASE_TIMEOUT_MS = 2000;

const HELD_KEYS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK
    | Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.META_MASK;

type SavedClipboard = { type: string; bytes: Uint8Array } | null;

// Why the field was left alone. Told to the person rather than logged as a failure.
class LeftAlone extends Error {}

// Double tap Left Ctrl or press a shortcut: copies the selected text, or selects and copies the whole
// focused field when nothing is selected, runs the cleanup command over it, pastes the result over it
// and puts the clipboard back. Not a voxtype feature, but it shares voxtype's cleanup command. Runs in
// the shell, so it can reach the clipboard and send keys without tools like ydotool, and takes no
// notice of any key but its own trigger.
export class CleanupAnything {
    private readonly clipboard = St.Clipboard.get_default();
    private readonly doubleTap = new DoubleTap();
    private keyboard: Clutter.VirtualInputDevice | null = null;
    private bound = false;
    private job: Gio.Cancellable | null = null;
    private sleeping = new Map<number, () => void>();
    private destroyed = false;

    constructor(private readonly settings: Gio.Settings, private readonly onBusy: (busy: boolean) => void) {
        settings.connectObject(
            'changed::cleanup-anything-enabled', () => this.applySettings(),
            'changed::cleanup-anything-trigger', () => this.applySettings(),
            this);
        this.applySettings();
    }

    destroy(): void {
        this.destroyed = true;
        this.settings.disconnectObject(this);
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
        shell.connectObject('locate-pointer', () => {
            if (this.doubleTap.feed(GLib.get_monotonic_time() / 1000) && inNormalMode()) {
                this.trigger();
            }
        }, this);
    }

    private removeTrigger(): void {
        if (this.bound) {
            Main.wm.removeKeybinding('cleanup-anything-shortcut');
            this.bound = false;
        }
        shell.disconnectObject(this);
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
            if (!(error instanceof LeftAlone)) {
                logError(error as Error, 'voxtype-osd: Cleanup Anything failed');
                Main.notifyError(TITLE, `Left your text alone: ${firstLine(String(error))}`);
            } else if (!job.is_cancelled()) {
                Main.notify(TITLE, `Left your text alone: ${error.message}`);
            }
        }).finally(() => {
            this.job = null;
            this.onBusy(false);
        });
    }

    private async cleanUp(window: Meta.Window, job: Gio.Cancellable): Promise<void> {
        const saved = await this.saveClipboard();
        try {
            await this.replaceField(window, job);
        } finally {
            this.restoreClipboard(saved);
        }
    }

    private async replaceField(window: Meta.Window, job: Gio.Cancellable): Promise<void> {
        const { text, selectAll } = await this.copyText(window, job);
        if (job.is_cancelled()) {
            return;
        }
        if (text.trim() === '') {
            throw new LeftAlone('nothing was copied.');
        }

        const limit = this.settings.get_int('cleanup-anything-max-chars');
        if (text.length > limit) {
            throw new LeftAlone(`it is over the ${limit} character limit.`);
        }

        const { command, timeoutMs } = await this.findCommand();
        if (command === null) {
            throw new LeftAlone('no cleanup command is set. Choose one on the Cleanup tab in Settings.');
        }

        const result = await runLimited(['sh', '-c', command], { input: text, timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, cancellable: job });
        if (job.is_cancelled()) {
            return;
        }
        if (!result.ok) {
            throw new LeftAlone(`${firstLine(result.stderr) || 'the cleanup command failed'}.`.replace(/\.+$/, '.'));
        }

        const cleaned = restoreOuterSpace(text, result.stdout);
        if (cleaned === text) {
            return;
        }
        if (result.stdout.trim() === '') {
            throw new LeftAlone('the cleanup command returned nothing.');
        }
        if (addsLink(text, cleaned)) {
            throw new LeftAlone('the cleanup added a link or email address.');
        }

        // Cleanup takes a few seconds, and the person may have moved on or kept typing since.
        if (await this.copy(window, job, selectAll) !== text) {
            throw new LeftAlone('it changed while it was being cleaned up.');
        }

        await this.waitForKeysUp(job);
        this.clipboard.set_text(St.ClipboardType.CLIPBOARD, cleaned);
        await this.sleep(POLL_MS);
        this.press(window, job, Clutter.KEY_v);
        await this.sleep(PASTE_SETTLE_MS);
    }

    private async findCommand(): Promise<{ command: string | null; timeoutMs: number }> {
        const [command, timeout] = await Promise.all([run(['voxtype', 'config', 'get', COMMAND_KEY]), run(['voxtype', 'config', 'get', TIMEOUT_KEY])]);
        // What voxtype has is already filled in. What is kept here while dictation cleanup is off is not.
        const kept = configValue(this.settings.get_string('cleanup-command'));

        return {
            command: (command.ok ? configValue(command.stdout) : null) ?? (kept === null ? null : fillPrompt(kept, this.settings.get_string('cleanup-prompt'))),
            timeoutMs: (timeout.ok ? Number(configValue(timeout.stdout)) : 0) || DEFAULT_TIMEOUT_MS,
        };
    }

    // The selected text when there is some, otherwise the whole field. Apps put what is selected on
    // the primary selection, but some leave it there once the selection is gone, so a plain Ctrl+C has
    // to copy the same text before it counts. Editors that copy the whole line when nothing is
    // selected copy something else.
    private async copyText(window: Meta.Window, job: Gio.Cancellable): Promise<{ text: string; selectAll: boolean }> {
        const selected = await this.clipboardText(St.ClipboardType.PRIMARY);
        if (selected.trim() !== '') {
            const text = await this.copy(window, job, false);
            if (text === selected || job.is_cancelled()) {
                return { text, selectAll: false };
            }
        }
        return { text: await this.copy(window, job, true), selectAll: true };
    }

    private async copy(window: Meta.Window, job: Gio.Cancellable, selectAll: boolean): Promise<string> {
        await this.waitForKeysUp(job);
        this.clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        await this.sleep(POLL_MS);
        if (selectAll) {
            this.press(window, job, Clutter.KEY_a);
            await this.sleep(KEY_GAP_MS);
        }
        this.press(window, job, Clutter.KEY_c);

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
    private async waitForKeysUp(job: Gio.Cancellable): Promise<void> {
        for (let waited = 0; waited < RELEASE_TIMEOUT_MS; waited += POLL_MS) {
            const [, , mask] = shell.get_pointer();
            if ((mask & HELD_KEYS) === 0 || job.is_cancelled()) {
                return;
            }
            await this.sleep(POLL_MS);
        }
        throw new Error('keys were still held down');
    }

    // The only way keys leave here. Everything before this can take seconds, and in that time the
    // person can cancel, move on, or the overview or the lock screen can open, so it checks every time.
    private press(window: Meta.Window, job: Gio.Cancellable, key: number): void {
        if (job.is_cancelled()) {
            throw new LeftAlone('it was cancelled.');
        }
        if (shell.display.focus_window !== window || !inNormalMode()) {
            throw new LeftAlone('you moved to another window.');
        }

        this.keyboard ??= shell.stage.get_context().get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        const send = (keyval: number, state: Clutter.KeyState) => this.keyboard!.notify_keyval(GLib.get_monotonic_time(), keyval, state);
        send(Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        send(key, Clutter.KeyState.PRESSED);
        send(key, Clutter.KeyState.RELEASED);
        send(Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }

    // An app that has stopped answering never hands the clipboard over.
    private clipboardAnswer<T>(request: Promise<T>): Promise<T> {
        return Promise.race([request, this.sleep(CLIPBOARD_TIMEOUT_MS).then(() => {
            throw new LeftAlone('the clipboard did not answer.');
        })]);
    }

    private clipboardText(type = St.ClipboardType.CLIPBOARD): Promise<string> {
        return this.clipboardAnswer(new Promise(resolve => {
            this.clipboard.get_text(type, (_clipboard, text) => resolve(text ?? ''));
        }));
    }

    private saveClipboard(): Promise<SavedClipboard> {
        const type = chooseClipboardType(this.clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD));
        if (type === null) {
            return Promise.resolve(null);
        }

        return this.clipboardAnswer(new Promise(resolve => {
            this.clipboard.get_content(St.ClipboardType.CLIPBOARD, type, (_clipboard, bytes) => {
                // The bytes only live as long as this callback, so they have to be copied.
                resolve(bytes === null ? null : { type, bytes: (bytes instanceof GLib.Bytes ? bytes.toArray() : bytes).slice() });
            });
        }));
    }

    private restoreClipboard(saved: SavedClipboard): void {
        if (saved === null) {
            this.clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        } else {
            this.clipboard.set_content(St.ClipboardType.CLIPBOARD, saved.type, saved.bytes);
        }
    }

    private sleep(ms: number): Promise<void> {
        if (this.destroyed) {
            return Promise.resolve();
        }

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
