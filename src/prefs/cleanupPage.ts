import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { firstLine, run } from '../voxtype.js';
import { buildSummaryLabel } from './memory.js';
import { claudeCleanupCommand, cleanupCommand, cleanupModel, cleanupPrompt, codexCleanupCommand, OllamaModel, parseOllamaList, withCleanupPrompt } from './models.js';
import { isUsableShortcut } from './shortcut.js';
import { loadSchema, restartIfRunning } from './voxtypeConfig.js';
import { showToast } from './window.js';

const CLEANUP_COMMAND_KEY = 'output.post_process.command';
const SHORTCUT_KEY = 'cleanup-anything-shortcut';
const PROMPT_LINES_HEIGHT = 88;
const PROMPT_HINT = 'Write $text where your text goes. If you leave it out, the text goes after the prompt.';
const NO_PROMPT_HINT = 'Only the Claude Code command takes a prompt. Other commands carry their own.';
const TRIGGERS = [['double-ctrl', 'Double-tap Left Ctrl'], ['shortcut', 'Custom shortcut']];
const EXAMPLE_OLLAMA_MODEL = 'llama3.2';
const COMMAND_HINT = 'Runs after dictation, or when you use the Cleanup Hotkey below. It reads the text on stdin and prints the result.';
const EXAMPLE_LINKS = 'Examples: '
    + '<a href="claude" title="Uses your installed Claude Code with every tool off. Set the model and reasoning level with --model and --effort. Needs Python 3, and Claude Code signed in.">Claude Code</a>, '
    + '<a href="codex" title="Uses your installed Codex. It can not change files, but it can still run read-only commands, so text you clean up could trick it into pasting out what it reads.">Codex</a>, '
    + '<a href="ollama" title="Uses a local model through Ollama. Pick one of yours in place of the model name.">Ollama</a>';
// Matches the checks in bin/voxtype-cleanup.py and CleanupAnything.replaceField().
const LEFT_ALONE_HELP = `Your text is left alone if:
\u2022 it is empty, or over the Longest text limit
\u2022 it is in a terminal
\u2022 the command fails, times out or returns nothing
\u2022 it changes while the command runs
\u2022 you move to another window or cancel

With the Claude Code example, a reply is also rejected if it:
\u2022 adds lines
\u2022 adds a link or email address
\u2022 drops more than half of the original
\u2022 is more than 30% new text

Other commands have no such checks, so whatever they print is pasted in.`;

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
    const [schema, ollamaResult] = await Promise.all([
        loadSchema(),
        run(['ollama', 'list']),
    ]);

    if (typeof schema === 'string') {
        page.add(new Adw.PreferencesGroup({
            title: 'Cleanup unavailable',
            description: `Could not ask voxtype about its settings: ${schema}`,
        }));
        return;
    }

    const configured = schema.keys.find(entry => entry.key === CLEANUP_COMMAND_KEY)?.value;

    const models = ollamaResult.ok ? parseOllamaList(ollamaResult.stdout) : [];
    const { group, useClaudeIfEmpty } = buildCleanupGroup(window, settings, models, String(configured ?? ''), extensionPath);
    page.add(group);
    page.add(buildAnythingGroup(window, settings, useClaudeIfEmpty));
}

function buildCleanupGroup(window: Adw.PreferencesWindow, settings: Gio.Settings, ollamaModels: OllamaModel[], configured: string, extensionPath: string): { group: Adw.PreferencesGroup; useClaudeIfEmpty: () => void } {
    const group = new Adw.PreferencesGroup();

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
    const enableRow = new Adw.SwitchRow({
        title: 'Clean up dictation',
        subtitle: 'Using your own model, run the command below after dictation to clean up the result. This will not work with live transcription.',
        active: configured !== '',
    });

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

    // Kept apart from the switch, because the Cleanup Hotkey uses the command with dictation cleanup off.
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

    promptRow.show(commandRow.text.trim());
    group.add(promptRow.row);
    group.add(commandRow);
    group.add(buildCommandHint(commandRow, {
        claude: claudeCleanupCommand(extensionPath),
        codex: codexCleanupCommand(),
        ollama: cleanupCommand(names[0] ?? EXAMPLE_OLLAMA_MODEL),
    }));

    return {
        group,
        useClaudeIfEmpty: () => {
            if (commandRow.text.trim() === '') {
                useClaude();
            }
        },
    };
}

// Sits right under the command, as it is the last row. A link only fills in the row, so nothing
// changes until it is applied.
function buildCommandHint(commandRow: Adw.EntryRow, examples: Record<string, string>): Gtk.Label {
    const fill = buildUndoableFill(commandRow);
    const label = buildSummaryLabel();
    label.use_markup = true;
    label.label = `${COMMAND_HINT}\n${EXAMPLE_LINKS}`;
    label.connect('activate-link', (_label, uri: string) => {
        fill(examples[uri]);
        return true;
    });
    return label;
}

// Setting a row's text wipes GTK's undo history, and the way around that takes two presses of Ctrl+Z
// with an empty row in between. So this keeps what the first fill replaced and restores it in one.
function buildUndoableFill(row: Adw.EntryRow): (text: string) => void {
    let replaced: string | null = null;
    let filled = '';

    const keys = new Gtk.EventControllerKey({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
    keys.connect('key-pressed', (_controller, keyval: number, _keycode: number, state: Gdk.ModifierType) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
        if (replaced === null || row.text !== filled || mask !== Gdk.ModifierType.CONTROL_MASK || Gdk.keyval_to_lower(keyval) !== Gdk.KEY_z) {
            return Gdk.EVENT_PROPAGATE;
        }

        row.text = replaced;
        row.set_position(-1);
        replaced = null;
        return Gdk.EVENT_STOP;
    });
    row.add_controller(keys);

    return text => {
        if (replaced === null || row.text !== filled) {
            replaced = row.text;
        }
        filled = text;
        row.text = text;
        row.grab_focus();
        row.set_position(-1);
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
        title: 'Cleanup Hotkey',
        description: 'Cleans up the text field you are in, in any app. It selects the whole field, runs the command above and pastes the result. The whole field goes to whatever service that command uses. Undo depends on the app, so check the result.',
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

    const help = buildSummaryLabel();
    help.label = LEFT_ALONE_HELP;
    group.add(help);

    return group;
}

function captureShortcut(window: Adw.PreferencesWindow, onCaptured: (accelerator: string) => void): void {
    const dialog = new Adw.AlertDialog({
        heading: 'Set Cleanup Hotkey shortcut',
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
