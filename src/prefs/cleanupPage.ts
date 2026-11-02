import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { fillPrompt } from '../cleanupRules.js';
import { firstLine, run } from '../voxtype.js';
import { buildSummaryLabel } from './memory.js';
import { claudeCleanupCommand, cleanupCommand, cleanupModel, codexCleanupCommand, OllamaModel, parseOllamaList, replaceOldWrapper } from './models.js';
import { isUsableShortcut } from './shortcut.js';
import { loadSchema, restartIfRunning } from './voxtypeConfig.js';
import { showToast } from './window.js';

const CLEANUP_COMMAND_KEY = 'output.post_process.command';
const SHORTCUT_KEY = 'cleanup-anything-shortcut';
const TEXT_AREA_LINES = 3;
const TEXT_AREA_MARGIN = 6;
const TRIGGERS = [['double-ctrl', 'Double-tap Left Ctrl'], ['shortcut', 'Custom shortcut']];
const EXAMPLE_OLLAMA_MODEL = 'llama3.2';
const COMMAND_HINT = 'Reads text on stdin and prints the result. $prompt is replaced with the LLM prompt, quoted for you. Give the model no tools, as the text could tell it to run commands.';
const EXAMPLE_LINKS = 'Examples: '
    + '<a href="claude" title="Uses your installed Claude Code with every tool off. Needs Claude Code signed in.">Claude Code</a>, '
    + '<a href="codex" title="Uses your installed Codex with its tools turned off, and a read-only sandbox in case an update turns them back on.">Codex</a>, '
    + '<a href="ollama" title="Uses a local model through Ollama. Pick one of yours in place of the model name.">Ollama</a>';
// Matches the checks in CleanupAnything.replaceField().
const REJECT_HELP = 'A reply is rejected if it is empty, or adds a link or email address.';

// Fills in once voxtype has answered, so the window opens straight away.
export function buildCleanupPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: 'cleanup',
        title: 'Cleanup',
        icon_name: 'voxtype-broom-symbolic',
    });
    fillCleanupPage(window, page, settings).catch(error => {
        logError(error as Error, 'voxtype-osd: could not build the Cleanup page');
    });
    return page;
}

async function fillCleanupPage(window: Adw.PreferencesWindow, page: Adw.PreferencesPage, settings: Gio.Settings): Promise<void> {
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
    const { group, useClaudeIfEmpty } = buildCleanupGroup(window, settings, models, String(configured ?? ''));
    page.add(group);
    page.add(buildAnythingGroup(window, settings, useClaudeIfEmpty));
}

function buildCleanupGroup(window: Adw.PreferencesWindow, settings: Gio.Settings, ollamaModels: OllamaModel[], configured: string): { group: Adw.PreferencesGroup; useClaudeIfEmpty: () => void } {
    const group = new Adw.PreferencesGroup();

    const save = async (command: string | null): Promise<boolean> => {
        const result = await run(command === null
            ? ['voxtype', 'config', 'unset', CLEANUP_COMMAND_KEY]
            : ['voxtype', 'config', 'set', CLEANUP_COMMAND_KEY, fillPrompt(command, settings.get_string('cleanup-prompt'))]);

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
    const commandHint = buildHint();
    const commandArea = buildTextArea('Cleanup command', commandHint, command => setCommand(command));
    const { command: loaded, moved } = loadCommand(settings, configured);
    commandArea.set(loaded);
    // voxtype's copy still points at a script that is gone.
    if (moved && configured !== '') {
        save(loaded);
    }

    const examples: Record<string, string> = {
        claude: claudeCleanupCommand(),
        codex: codexCleanupCommand(),
        ollama: cleanupCommand(names[0] ?? EXAMPLE_OLLAMA_MODEL),
    };
    commandHint.use_markup = true;
    commandHint.label = `${COMMAND_HINT} ${EXAMPLE_LINKS}`;
    // Only fills in the area, so nothing changes until it is applied.
    commandHint.connect('activate-link', (_label, uri: string) => {
        commandArea.fill(examples[uri]);
        return true;
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
        const command = commandArea.text() || (names.length > 0 ? cleanupCommand(names[0]) : '');
        if (enabling && command === '') {
            showToast(window, 'Enter a cleanup command first');
            setEnabled(false);
            return;
        }

        if (enabling) {
            commandArea.set(command);
        }
        settings.set_string('cleanup-command', commandArea.text());
        if (!await save(enabling ? command : null)) {
            setEnabled(!enabling);
        }
    });

    const promptArea = buildTextArea('LLM prompt', null, prompt => {
        // A blank prompt goes back to the default, as a command with an empty one would do nothing useful.
        if (prompt === '') {
            settings.reset('cleanup-prompt');
        } else {
            settings.set_string('cleanup-prompt', prompt);
        }
        promptArea.set(settings.get_string('cleanup-prompt'));

        const command = commandArea.text();
        commandArea.set(command);
        return setCommand(command);
    });
    promptArea.set(settings.get_string('cleanup-prompt'));

    // Kept apart from the switch, because the Cleanup Hotkey uses the command with dictation cleanup off.
    const setCommand = async (command: string) => {
        settings.set_string('cleanup-command', command);
        if (command === '') {
            enableRow.active = false;
        } else if (enableRow.active) {
            await save(command);
        }
    };

    const useClaude = () => {
        commandArea.set(examples.claude);
        return setCommand(examples.claude);
    };

    group.add(enableRow);

    // A shortcut for anyone who already runs Ollama; it only fills in the command.
    if (names.length > 0) {
        const sizes = new Map(ollamaModels.map(model => [model.name, model.size]));
        const currentModel = cleanupModel(commandArea.text());
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

            const command = cleanupCommand(name);
            commandArea.set(command);
            settings.set_string('cleanup-command', command);
            if (enableRow.active) {
                save(command);
            }
        });
        group.add(modelRow);
    }

    group.add(promptArea.row);
    group.add(commandArea.row);

    return {
        group,
        useClaudeIfEmpty: () => {
            if (commandArea.text() === '') {
                useClaude();
            }
        },
    };
}

// The command as typed, with $prompt in it. It only differs from voxtype's when that was edited by
// hand, or still uses the old wrapper, in which case it moves to Claude Code directly.
function loadCommand(settings: Gio.Settings, configured: string): { command: string; moved: boolean } {
    const kept = settings.get_string('cleanup-command');
    const handEdited = configured !== '' && fillPrompt(kept, settings.get_string('cleanup-prompt')) !== configured;
    const command = handEdited ? configured : kept;

    const replaced = replaceOldWrapper(command);
    if (replaced === null) {
        return { command, moved: false };
    }
    if (replaced.prompt !== null) {
        settings.set_string('cleanup-prompt', replaced.prompt);
    }
    settings.set_string('cleanup-command', replaced.command);
    return { command: replaced.command, moved: true };
}

function buildHint(): Gtk.Label {
    return new Gtk.Label({ xalign: 0, wrap: true, css_classes: ['dim-label', 'caption'] });
}

type TextArea = {
    row: Adw.PreferencesRow;
    text: () => string;
    set: (text: string) => void;
    fill: (text: string) => void;
};

// A titled box of text with an apply button, any hint below it, and a scrollbar past three lines.
function buildTextArea(title: string, hint: Gtk.Label | null, onApply: (text: string) => void): TextArea {
    const applyButton = new Gtk.Button({
        icon_name: 'object-select-symbolic',
        tooltip_text: 'Apply',
        valign: Gtk.Align.CENTER,
        visible: false,
        css_classes: ['suggested-action', 'circular'],
    });
    const header = new Gtk.Box({ spacing: 12 });
    header.append(new Gtk.Label({ label: title, xalign: 0, hexpand: true }));
    header.append(applyButton);

    const view = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, accepts_tab: false, left_margin: 8, right_margin: 8 });
    // The padding goes around the scroller and not on the view, where a fourth line would show
    // through it. The scrollbar doesn't overlay, as that kind hides until the pointer moves over it.
    const scroller = new Gtk.ScrolledWindow({
        child: view,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        overlay_scrolling: false,
        css_classes: ['voxtype-text-area'],
        margin_top: TEXT_AREA_MARGIN,
        margin_bottom: TEXT_AREA_MARGIN,
    });
    // Measured once on screen, when the font is known, so this stays three lines at any text size.
    view.connect('map', () => {
        [, scroller.height_request] = view.create_pango_layout(Array(TEXT_AREA_LINES).fill('A').join('\n')).get_pixel_size();
    });

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 10, margin_bottom: 12, margin_start: 12, margin_end: 12 });
    box.append(header);
    box.append(new Gtk.Frame({ child: scroller, css_classes: ['view'] }));
    if (hint !== null) {
        box.append(hint);
    }

    const buffer = view.buffer;
    let saved = '';
    buffer.connect('changed', () => {
        applyButton.visible = buffer.text.trim() !== saved;
    });

    const set = (text: string) => {
        saved = text;
        buffer.text = text;
        applyButton.visible = false;
    };
    applyButton.connect('clicked', () => {
        const text = buffer.text.trim();
        set(text);
        onApply(text);
    });

    return {
        row: new Adw.PreferencesRow({ title, activatable: false, child: box }),
        text: () => buffer.text.trim(),
        set,
        // One user action, so a single Ctrl+Z brings back what was there. Setting buffer.text can't be undone.
        fill: text => {
            const [start, end] = buffer.get_bounds();
            buffer.begin_user_action();
            buffer.delete(start, end);
            buffer.insert(start, text, -1);
            buffer.end_user_action();
            view.grab_focus();
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
    help.margin_top = 10;
    help.label = REJECT_HELP;
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
