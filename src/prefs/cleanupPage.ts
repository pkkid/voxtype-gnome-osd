import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { firstLine, run } from '../voxtype.js';
import { cleanupCommand, cleanupModel, OllamaModel, parseOllamaList } from './models.js';
import { restartIfRunning } from './voxtypeConfig.js';
import { showToast } from './window.js';

const CLEANUP_COMMAND_KEY = 'output.post_process.command';

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

    page.add(buildCleanupGroup(window, settings, ollamaResult.ok ? parseOllamaList(ollamaResult.stdout) : [], String(configured ?? '')));
}

function buildCleanupGroup(window: Adw.PreferencesWindow, settings: Gio.Settings, ollamaModels: OllamaModel[], configured: string): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Text cleanup',
        description: 'Pipes your dictation through a command before it is typed, such as a script that calls a language model. The command reads the text on stdin and prints the result. Does not work with live transcription, which types text before cleanup can see it.',
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
    const enableRow = new Adw.SwitchRow({ title: 'Clean up text', active: configured !== '' });

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
        if (!await save(enabling ? command : null)) {
            setEnabled(!enabling);
        }
    });

    commandRow.connect('apply', async () => {
        const command = commandRow.text.trim();
        if (command === '') {
            enableRow.active = false;
        } else if (await save(command)) {
            setEnabled(true);
        }
    });

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
            if (enableRow.active) {
                save(commandRow.text);
            }
        });
        group.add(modelRow);
    }

    group.add(commandRow);
    return group;
}
