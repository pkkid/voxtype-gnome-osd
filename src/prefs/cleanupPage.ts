import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { firstLine, run } from '../voxtype.js';
import { claudeCleanupCommand, cleanupCommand, cleanupModel, cleanupPrompt, OllamaModel, parseOllamaList, withCleanupPrompt } from './models.js';
import { isUsableShortcut } from './shortcut.js';
import { restartIfRunning } from './voxtypeConfig.js';
import { showToast } from './window.js';

const CLEANUP_COMMAND_KEY = 'output.post_process.command';
const SHORTCUT_KEY = 'cleanup-anything-shortcut';
const PROMPT_LINES_HEIGHT = 88;
const PROMPT_HINT = 'Write $text where your text goes. If you leave it out, the text goes after the prompt.';
const NO_PROMPT_HINT = 'Only the Claude Code command takes a prompt. Other commands carry their own.';
const TRIGGERS = [['double-ctrl', 'Double-tap Left Ctrl'], ['shortcut', 'Custom shortcut']];

// Fills in once voxtype has answered, so the window opens straight away.
export function buildCleanupPage(window: Adw.PreferencesWindow, settings: Gio.Settings, extensionPath: string): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: 'cleanup',
        title: 'Cleanup',
        icon_name: 'voxtype-broom-symbolic',
    });
    fillCleanupPage(window, page, settings, extensionPath).catch(error => {
        logError(error as Error, 'voxtype-osd: could not build the Cleanup page');
    });
    return page;
}

async function fillCleanupPage(window: Adw.PreferencesWindow, page: Adw.PreferencesPage, settings: Gio.Settings, extensionPath: string): Promise<void> {
    const [schemaResult, ollamaResult] = await Promise.all([
        run(['voxtype', 'config', 'schema', '--json']),
        run(['ollama', 'list']),
    ]);

    if (!schemaResult.ok) {
        page.add(new Adw.PreferencesGroup({
            title: 'Cleanup unavailable',
            description: `Could not ask voxtype about its settings: ${firstLine(schemaResult.stderr)}`,
        }));
        return;
    }

    const { keys } = JSON.parse(schemaResult.stdout) as { keys: { key: string; value: unknown }[] };
    const configured = keys.find(entry => entry.key === CLEANUP_COMMAND_KEY)?.value;

    const models = ollamaResult.ok ? parseOllamaList(ollamaResult.stdout) : [];
    const { group, useClaudeIfEmpty } = buildCleanupGroup(window, settings, models, String(configured ?? ''), extensionPath);
    page.add(group);
    page.add(buildAnythingGroup(window, settings, useClaudeIfEmpty));
}

function buildCleanupGroup(window: Adw.PreferencesWindow, settings: Gio.Settings, ollamaModels: OllamaModel[], configured: string, extensionPath: string): { group: Adw.PreferencesGroup; useClaudeIfEmpty: () => void } {
    const group = new Adw.PreferencesGroup({
        title: 'Text cleanup',
        description: 'Runs your text through a command, such as a script that calls a language model. The command reads the text on stdin and prints the result. Dictation cleanup does not work with live transcription, which types text before cleanup can see it.',
    });

    const save = async (command: string | null): Promise<boolean> => {
        const result = await run(command === null
            ? ['voxtype', 'config', 'unset', CLEANUP_COMMAND_KEY]
            : ['voxtype', 'config', 'set', CLEANUP_COMMAND_KEY, command]);

        if (!result.ok) {
            showToast(window, `Could not change text cleanup: ${firstLine(result.stderr)}`);
            return false;
        }

        if (command !== null) {
            settings.set_string('cleanup-command', command);
        }
        await restartIfRunning(window);
        return true;
    };

    const names = ollamaModels.map(model => model.name);
    const commandRow = new Adw.EntryRow({
        title: 'Cleanup command',
        text: configured || settings.get_string('cleanup-command'),
        show_apply_button: true,
    });
    const enableRow = new Adw.SwitchRow({ title: 'Clean up dictation', active: configured !== '' });

    let syncing = false;
    const setEnabled = (enabled: boolean) => {
        syncing = true;
        enableRow.active = enabled;
        syncing = false;
    };

    enableRow.connect('notify::active', async () => {
        if (syncing) {
            return;
        }

        const enabling = enableRow.active;
        const command = commandRow.text.trim() || (names.length > 0 ? cleanupCommand(names[0]) : '');
        if (enabling && command === '') {
            showToast(window, 'Enter a cleanup command first');
            setEnabled(false);
            return;
        }

        commandRow.text = enabling ? command : commandRow.text;
        settings.set_string('cleanup-command', commandRow.text.trim());
        if (!await save(enabling ? command : null)) {
            setEnabled(!enabling);
        }
    });

    const promptRow = buildPromptRow(prompt => {
        commandRow.text = withCleanupPrompt(commandRow.text.trim(), prompt);
        return setCommand(commandRow.text);
    });

    // Kept apart from the switch, because Cleanup Anything uses the command with dictation cleanup off.
    const setCommand = async (command: string) => {
        settings.set_string('cleanup-command', command);
        promptRow.show(command);
        if (command === '') {
            enableRow.active = false;
        } else if (enableRow.active) {
            await save(command);
        }
    };

    commandRow.connect('apply', () => setCommand(commandRow.text.trim()));

    const useClaude = () => {
        commandRow.text = claudeCleanupCommand(extensionPath);
        return setCommand(commandRow.text);
    };

    group.add(enableRow);

    // A shortcut for anyone who already runs Ollama; it only fills in the command.
    if (names.length > 0) {
        const sizes = new Map(ollamaModels.map(model => [model.name, model.size]));
        const currentModel = cleanupModel(commandRow.text);
        const values = currentModel === null ? [null, ...names] : names.includes(currentModel) ? names : [currentModel, ...names];
        const modelRow = new Adw.ComboRow({
            title: 'Ollama model',
            model: Gtk.StringList.new(values.map(name => {
                if (name === null) {
                    return 'Custom command';
                }
                return sizes.has(name) ? `${name} (${sizes.get(name)})` : name;
            })),
            selected: Math.max(0, values.indexOf(currentModel)),
        });
        modelRow.connect('notify::selected', () => {
            const name = values[modelRow.selected];
            if (name === null || name === undefined) {
                return;
            }

            commandRow.text = cleanupCommand(name);
            settings.set_string('cleanup-command', commandRow.text);
            promptRow.show(commandRow.text);
            if (enableRow.active) {
                save(commandRow.text);
            }
        });
        group.add(modelRow);
    }

    const claudeRow = new Adw.ActionRow({
        title: 'Use Claude Code',
        subtitle: 'Sets the command to one that uses your installed Claude Code with every tool turned off, and rejects replies that are more than a light edit. The model and reasoning level are the --model and --effort options in the command. Needs Python 3, and Claude Code installed and signed in.',
    });
    const claudeButton = new Gtk.Button({ label: 'Use', valign: Gtk.Align.CENTER });
    claudeButton.connect('clicked', useClaude);
    claudeRow.add_suffix(claudeButton);
    group.add(claudeRow);

    group.add(commandRow);
    promptRow.show(commandRow.text.trim());
    group.add(promptRow.row);

    return {
        group,
        useClaudeIfEmpty: () => {
            if (commandRow.text.trim() === '') {
                useClaude();
            }
        },
    };
}

// The prompt lives in the command as --prompt, so a hand edit to voxtype's config shows up here too.
function buildPromptRow(onApply: (prompt: string) => void): { row: Adw.PreferencesRow; show: (command: string) => void } {
    const hint = new Gtk.Label({ xalign: 0, wrap: true, css_classes: ['dim-label', 'caption'] });
    const applyButton = new Gtk.Button({
        icon_name: 'object-select-symbolic',
        tooltip_text: 'Apply',
        valign: Gtk.Align.CENTER,
        visible: false,
        css_classes: ['suggested-action', 'circular'],
    });
    const header = new Gtk.Box({ spacing: 12 });
    header.append(new Gtk.Label({ label: 'LLM prompt', xalign: 0, hexpand: true }));
    header.append(applyButton);

    const view = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, accepts_tab: false, top_margin: 6, bottom_margin: 6, left_margin: 8, right_margin: 8 });
    const scroller = new Gtk.ScrolledWindow({ child: view, hscrollbar_policy: Gtk.PolicyType.NEVER, min_content_height: PROMPT_LINES_HEIGHT, max_content_height: PROMPT_LINES_HEIGHT });

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 10, margin_bottom: 12, margin_start: 12, margin_end: 12 });
    box.append(header);
    box.append(new Gtk.Frame({ child: scroller }));
    box.append(hint);

    let saved = '';
    view.buffer.connect('changed', () => {
        applyButton.visible = view.buffer.text !== saved;
    });
    applyButton.connect('clicked', () => {
        saved = view.buffer.text.trim();
        applyButton.visible = false;
        onApply(saved);
    });

    const row = new Adw.PreferencesRow({ title: 'LLM prompt', activatable: false, child: box });
    return {
        row,
        show: command => {
            const prompt = cleanupPrompt(command);
            saved = prompt ?? '';
            view.buffer.text = saved;
            view.sensitive = prompt !== null;
            hint.label = prompt === null ? NO_PROMPT_HINT : PROMPT_HINT;
        },
    };
}

function buildAnythingGroup(window: Adw.PreferencesWindow, settings: Gio.Settings, useClaudeIfEmpty: () => void): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Cleanup Anything',
        description: 'Not a Voxtype feature. Cleans up the text field you are in, in any app: it selects everything in the field, runs the command above and pastes the result over it. The whole field goes to whatever service your command uses, so changing the command changes where it goes and what that service can do. Your clipboard is put back as plain text or an image, Ctrl+Z undoes the change in most apps, and terminals are skipped.',
    });

    const enableRow = new Adw.SwitchRow({ title: 'Clean up anywhere' });
    settings.bind('cleanup-anything-enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    enableRow.connect('notify::active', () => {
        if (enableRow.active) {
            useClaudeIfEmpty();
        }
    });
    group.add(enableRow);

    const triggerRow = new Adw.ComboRow({
        title: 'Trigger',
        subtitle: 'Press it again to cancel a cleanup that is still running.',
        model: Gtk.StringList.new(TRIGGERS.map(([, label]) => label)),
        selected: Math.max(0, TRIGGERS.findIndex(([value]) => value === settings.get_string('cleanup-anything-trigger'))),
    });

    const label = new Gtk.ShortcutLabel({ valign: Gtk.Align.CENTER, disabled_text: 'Not set' });
    const showShortcut = () => {
        label.accelerator = settings.get_strv(SHORTCUT_KEY)[0] ?? '';
    };
    showShortcut();

    const shortcutRow = new Adw.ActionRow({ title: 'Shortcut', activatable: true });
    shortcutRow.add_suffix(label);
    shortcutRow.connect('activated', () => {
        captureShortcut(window, accelerator => {
            settings.set_strv(SHORTCUT_KEY, [accelerator]);
            showShortcut();
        });
    });

    const showTrigger = () => {
        const [value] = TRIGGERS[triggerRow.selected];
        settings.set_string('cleanup-anything-trigger', value);
        shortcutRow.visible = value === 'shortcut';
    };
    triggerRow.connect('notify::selected', showTrigger);
    showTrigger();
    group.add(triggerRow);
    group.add(shortcutRow);

    const lengthRow = Adw.SpinRow.new_with_range(500, 50000, 500);
    lengthRow.title = 'Longest text';
    lengthRow.subtitle = 'Characters. Anything longer is left alone, which also covers Ctrl+A selecting a whole page.';
    settings.bind('cleanup-anything-max-chars', lengthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(lengthRow);

    return group;
}

function captureShortcut(window: Adw.PreferencesWindow, onCaptured: (accelerator: string) => void): void {
    const dialog = new Adw.AlertDialog({
        heading: 'Set Cleanup Anything shortcut',
        body: 'Press the new key combination.\nEsc cancels.',
    });
    dialog.add_response('cancel', 'Cancel');

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_controller, keyval: number, _keycode: number, state: Gdk.ModifierType) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
        const key = Gdk.keyval_to_lower(keyval);

        if (mask === 0 && key === Gdk.KEY_Escape) {
            dialog.close();
        } else if (isUsableShortcut(key, mask)) {
            onCaptured(Gtk.accelerator_name(key, mask)!);
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);

    dialog.present(window);
}
