import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { firstLine, run } from '../voxtype.js';
import { RunningCommand, runWithLines } from './download.js';
import { isGpuEnabled, setGpuEnabled } from './gpu.js';
import { buildMemoryGroup } from './memory.js';
import {
    DictationModel,
    dictationModels,
    formatBytes,
    gpuAvailable,
    gpuLabel,
    InstalledModel,
    isActiveModel,
    ModelCatalog,
    modelDisplayName,
    modelFileNames,
    parseDownloadEvent,
    parseModelsDir,
} from './models.js';
import { pathSize } from './storage.js';
import { restartIfRunning, setConfig } from './voxtypeConfig.js';
import { showToast } from './window.js';

const PROGRESS_WIDTH = 120;
const MENU_TEXT_WIDTH = 300;
const MENU_TEXT_CHARS = 42;
const MENU_MAX_HEIGHT = 420;
const GPU_CHECK_DELAY_SECS = 4;

type SchemaKey = {
    key: string;
    label: string;
    description: string;
    value: string | number | boolean | null;
    compiled: boolean;
};

// Only one download runs at a time, because a finished one rebuilds the page around it.
type PageState = {
    window: Adw.PreferencesWindow;
    page: Adw.PreferencesPage;
    groups: Adw.PreferencesGroup[];
    download: RunningCommand | null;
    closed: boolean;
};

// Fills in once voxtype has answered, so the window opens straight away.
export function buildModelsPage(window: Adw.PreferencesWindow): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: 'models',
        title: 'Models',
        icon_name: 'drive-harddisk-symbolic',
    });
    const state: PageState = { window, page, groups: [], download: null, closed: false };

    window.connect('close-request', () => {
        state.closed = true;
        state.download?.cancel();
        return false;
    });

    refreshPage(state);
    return page;
}

function refreshPage(state: PageState): void {
    fillModelsPage(state).catch(error => {
        logError(error as Error, 'voxtype-osd: could not build the Models page');
    });
}

async function fillModelsPage(state: PageState): Promise<void> {
    const [schemaResult, catalogResult, catalogText, variantsResult, accelResult] = await Promise.all([
        run(['voxtype', 'config', 'schema', '--json']),
        run(['voxtype', 'info', 'models', '--json']),
        run(['voxtype', 'info', 'models']),
        run(['voxtype', 'info', 'variants', '--json']),
        run(['voxtype', 'info', 'accel', '--json']),
    ]);

    state.groups.forEach(group => state.page.remove(group));
    state.groups = [];

    const add = (group: Adw.PreferencesGroup) => {
        state.groups.push(group);
        state.page.add(group);
    };

    if (!schemaResult.ok || !catalogResult.ok) {
        add(new Adw.PreferencesGroup({
            title: 'Models unavailable',
            description: `Could not ask voxtype about its models: ${firstLine(schemaResult.stderr || catalogResult.stderr)}`,
        }));
        return;
    }

    const schema = JSON.parse(schemaResult.stdout) as { keys: SchemaKey[] };
    const keys = new Map(schema.keys.map(entry => [entry.key, entry]));
    const models = dictationModels(JSON.parse(catalogResult.stdout) as ModelCatalog);
    const modelsDir = parseModelsDir(catalogText.stdout) ?? GLib.build_filenamev([GLib.get_user_data_dir(), 'voxtype', 'models']);
    const isSupported = (model: DictationModel) => keys.get(`${model.engine}.model`)?.compiled === true;

    const gpuRow = keys.get('engine')?.value === 'whisper' && variantsResult.ok && gpuAvailable(variantsResult.stdout)
        ? buildGpuRow(state, accelResult.ok ? accelResult.stdout : '')
        : null;

    add(buildDictationGroup(state, models, isSupported, keys, modelsDir, gpuRow));

    const onDemand = keys.get(`${keys.get('engine')?.value}.on_demand_loading`);
    add(buildMemoryGroup(state.window, onDemand?.compiled === true ? onDemand : null));
}

// Voxtype needs a moment to load the model, and only then can it say where the model ended up.
function buildGpuRow(state: PageState, accelJson: string): Adw.SwitchRow {
    const row = new Adw.SwitchRow({
        title: 'Run models on the GPU',
        subtitle: ['Much faster, especially with large models, but uses video memory. Restarts Voxtype.', gpuLabel(accelJson)].filter(Boolean).join(' '),
        active: isGpuEnabled(),
    });

    let reverting = false;
    row.connect('notify::active', async () => {
        if (reverting) {
            return;
        }

        const result = await setGpuEnabled(row.active);
        if (!result.ok) {
            showToast(state.window, `Could not change GPU use: ${firstLine(result.stderr)}`);
            reverting = true;
            row.active = !row.active;
            reverting = false;
            return;
        }

        await restartIfRunning(state.window);
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, GPU_CHECK_DELAY_SECS, () => {
            if (!state.closed && state.download === null) {
                refreshPage(state);
            }
            return GLib.SOURCE_REMOVE;
        });
    });

    return row;
}

function installedSubtitle(model: DictationModel, modelsDir: string): string {
    return [model.note?.bestFor, formatBytes(modelSize(modelsDir, model)), model.note?.recommended].filter(Boolean).join(' · ');
}

function buildDictationGroup(state: PageState, models: DictationModel[], isSupported: (model: DictationModel) => boolean, keys: Map<string, SchemaKey>, modelsDir: string, gpuRow: Adw.SwitchRow | null): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Dictation models',
        description: 'Turn your speech into text. Larger models are more accurate but slower. Choosing one restarts Voxtype.',
    });

    if (gpuRow !== null) {
        group.add(gpuRow);
    }

    const available = models.filter(({ installed }) => !installed);
    if (available.length > 0) {
        group.add(buildDownloadRow(state, [...available.filter(isSupported), ...available.filter(model => !isSupported(model))], isSupported, modelsDir));
    }

    let activeEngine = keys.get('engine')?.value ?? null;
    let firstCheck: Gtk.CheckButton | null = null;
    let current: Gtk.CheckButton | null = null;
    let reverting = false;

    for (const model of models.filter(({ installed }) => installed)) {
        const row = new Adw.ActionRow({
            title: modelDisplayName(model),
            subtitle: installedSubtitle(model, modelsDir),
            sensitive: isSupported(model),
        });
        group.add(row);

        const active = model.engine === activeEngine && isActiveModel(model, keys.get(`${model.engine}.model`)?.value);
        const check = new Gtk.CheckButton({ active, valign: Gtk.Align.CENTER });
        check.set_group(firstCheck);
        firstCheck ??= check;
        const inUse = new Gtk.Label({ label: 'In use', visible: active, css_classes: ['dim-label'] });

        row.add_prefix(check);
        row.add_suffix(inUse);
        row.activatable_widget = check;

        if (active) {
            current = check;
        }

        check.connect('notify::active', async () => {
            inUse.visible = check.active;
            if (!check.active || reverting) {
                return;
            }

            const previous = current;
            current = check;
            if (await switchModel(state.window, model, activeEngine)) {
                activeEngine = model.engine;
                return;
            }

            current = previous;
            reverting = true;
            if (previous !== null) {
                previous.active = true;
            } else {
                check.active = false;
            }
            reverting = false;
        });
    }

    return group;
}

// `voxtype setup model --set` refuses a model that is not downloaded; `voxtype config set` would not.
async function switchModel(window: Adw.PreferencesWindow, model: InstalledModel, activeEngine: unknown): Promise<boolean> {
    const result = await run(['voxtype', 'setup', 'model', '--set', model.downloadArg]);
    if (!result.ok) {
        showToast(window, `Could not switch to ${modelDisplayName(model)}`);
        return false;
    }

    if (model.engine !== activeEngine && !await setConfig(window, 'engine', model.engine)) {
        return false;
    }

    await restartIfRunning(window);
    return true;
}

function buildDownloadRow(state: PageState, models: DictationModel[], isSupported: (model: DictationModel) => boolean, modelsDir: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title: 'Download', subtitle: 'Add another dictation model.' });
    const progress = new Gtk.ProgressBar({ valign: Gtk.Align.CENTER, visible: false, width_request: PROGRESS_WIDTH });
    const cancelButton = new Gtk.Button({
        icon_name: 'process-stop-symbolic',
        tooltip_text: 'Cancel download',
        valign: Gtk.Align.CENTER,
        visible: false,
        css_classes: ['flat'],
    });
    cancelButton.connect('clicked', () => state.download?.cancel());

    // A menu rather than a dropdown: a dropdown always has something selected, and choosing that
    // same model again would do nothing.
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['navigation-sidebar'] });
    const popover = new Gtk.Popover({
        child: new Gtk.ScrolledWindow({
            child: list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            max_content_height: MENU_MAX_HEIGHT,
        }),
    });
    const menuButton = new Gtk.MenuButton({ label: 'Choose a model', valign: Gtk.Align.CENTER, popover });

    for (const model of models) {
        const supported = isSupported(model);
        list.append(new Gtk.ListBoxRow({ child: buildMenuEntry(model, supported), sensitive: supported, activatable: supported }));
    }

    list.connect('row-activated', (_list, listRow) => {
        const model = models[listRow.get_index()];
        popover.popdown();
        confirmDownload(state.window, model, () => {
            row.subtitle = `Downloading ${modelDisplayName(model)}`;
            menuButton.visible = false;
            progress.visible = true;
            cancelButton.visible = true;
            startDownload(state, model, progress, modelsDir);
        });
    });

    row.add_suffix(progress);
    row.add_suffix(cancelButton);
    row.add_suffix(menuButton);
    return row;
}

function buildMenuEntry(model: DictationModel, supported: boolean): Gtk.Box {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        width_request: MENU_TEXT_WIDTH,
        spacing: 2,
        margin_top: 4,
        margin_bottom: 4,
    });
    const details = [
        model.note?.bestFor,
        model.note?.size,
        model.note?.recommended,
        supported ? null : 'Needs the ONNX build of Voxtype',
    ].filter(Boolean).join(' · ');

    box.append(new Gtk.Label({ label: modelDisplayName(model), halign: Gtk.Align.START }));
    box.append(new Gtk.Label({
        label: details,
        halign: Gtk.Align.START,
        xalign: 0,
        wrap: true,
        max_width_chars: MENU_TEXT_CHARS,
        css_classes: ['caption', 'dimmed'],
    }));
    return box;
}

function confirmDownload(window: Adw.PreferencesWindow, model: DictationModel, onConfirmed: () => void): void {
    const dialog = new Adw.AlertDialog({
        heading: `Download ${modelDisplayName(model)}?`,
        body: [model.note?.bestFor, model.note?.recommended, model.note ? `Download size: ${model.note.size}` : null].filter(Boolean).join('\n'),
        default_response: 'download',
        close_response: 'cancel',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('download', 'Download');
    dialog.set_response_appearance('download', Adw.ResponseAppearance.SUGGESTED);
    dialog.connect('response', (_dialog, response: string) => {
        if (response === 'download') {
            onConfirmed();
        }
    });
    dialog.present(window);
}

async function startDownload(state: PageState, model: DictationModel, progress: Gtk.ProgressBar, modelsDir: string): Promise<void> {
    const argv = ['voxtype', 'setup', '--download', '--model', model.downloadArg, '--progress-format', 'json'];
    let command: RunningCommand;
    let cancelled = false;
    let file = '';
    let failure = '';

    try {
        command = runWithLines(argv, line => {
            const event = parseDownloadEvent(line);
            if (event?.kind === 'progress') {
                file = event.file;
                progress.fraction = event.fraction;
            } else if (event?.kind === 'error') {
                failure = event.message;
            }
        });
    } catch (error) {
        showToast(state.window, `Could not download ${modelDisplayName(model)}: ${String(error)}`);
        refreshPage(state);
        return;
    }

    state.download = {
        cancel: () => {
            cancelled = true;
            command.cancel();
        },
        finished: command.finished,
    };

    const succeeded = await command.finished;
    state.download = null;

    if (cancelled) {
        removePartialDownload(modelsDir, file);
    } else if (!succeeded) {
        showToast(state.window, `Could not download ${modelDisplayName(model)}: ${failure}`);
    }

    if (!state.closed) {
        refreshPage(state);
    }
}

// voxtype keeps an unfinished download next to the model as .<file>.part.
function removePartialDownload(modelsDir: string, file: string): void {
    try {
        Gio.File.new_for_path(GLib.build_filenamev([modelsDir, `.${file}.part`])).delete(null);
    } catch {
        // Nothing was written yet.
    }
}

function modelSize(modelsDir: string, model: InstalledModel): number {
    for (const name of modelFileNames(model)) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([modelsDir, name]));
        if (file.query_exists(null)) {
            return pathSize(file);
        }
    }
    return 0;
}
