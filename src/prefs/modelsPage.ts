import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { firstLine, run } from '../voxtype.js';
import { RunningCommand, runWithLines } from './download.js';
import { hasGpuDropIn, removeGpuDropIn } from './gpu.js';
import { buildRunsGroup } from './memory.js';
import {
    Builds,
    buildSwitchCommands,
    DictationModel,
    dictationModels,
    formatBytes,
    gpuCapable,
    gpuLabel,
    InstalledModel,
    isActiveModel,
    liveCapable,
    ModelCatalog,
    modelDisplayName,
    modelFamily,
    modelFileNames,
    parseBuilds,
    parseDownloadEvent,
    parseModelsDir,
    switchSummary,
} from './models.js';
import { refreshSchemaPages } from './schemaPage.js';
import { deletePath, pathSize } from './storage.js';
import { restartIfRunning, setConfig } from './voxtypeConfig.js';
import { showToast } from './window.js';

const PROGRESS_WIDTH = 120;
const DETAIL_CHARS = 70;
const DOWNLOAD_LIST_HEIGHT = 300;
const DOWNLOAD_ENTRY_HEIGHT = 74;
const GPU_CHECK_DELAY_SECS = 4;
const USE_GPU_KEY = 'use-gpu';
const LIVE_ALTERNATIVES: Record<string, string> = { parakeet: 'Parakeet Unified' };

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
    settings: Gio.Settings;
    page: Adw.PreferencesPage;
    groups: Adw.PreferencesGroup[];
    download: RunningCommand | null;
    downloadsOpen: boolean;
    // Only the latest pass over voxtype's answers may fill the page.
    fills: number;
    closed: boolean;
};

// What one pass over voxtype's answers found.
type Facts = {
    state: PageState;
    keys: Map<string, SchemaKey>;
    builds: Builds;
    modelsDir: string;
    activeEngine: unknown;
    active: DictationModel | null;
    liveOn: boolean;
};

// Fills in once voxtype has answered, so the window opens straight away.
export function buildModelsPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        name: 'models',
        title: 'Models',
        icon_name: 'drive-harddisk-symbolic',
    });
    const state: PageState = { window, settings, page, groups: [], download: null, downloadsOpen: false, fills: 0, closed: false };

    window.connect('close-request', () => {
        state.closed = true;
        state.download?.cancel();
        return false;
    });

    // Coming back catches changes on other pages, like live transcription.
    page.connect('map', () => {
        if (state.download === null) {
            refreshPage(state);
        }
    });

    refreshPage(state);
    return page;
}

function refreshPage(state: PageState): void {
    fillModelsPage(state).catch(error => {
        logError(error as Error, 'voxtype-osd: could not build the Models page');
    });
}

// Voxtype needs a moment to load the model, and only then can it say where the model ended up.
function refreshOnceLoaded(state: PageState): void {
    refreshPage(state);
    refreshSchemaPages(state.window);
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, GPU_CHECK_DELAY_SECS, () => {
        if (!state.closed && state.download === null) {
            refreshPage(state);
        }
        return GLib.SOURCE_REMOVE;
    });
}

async function fillModelsPage(state: PageState): Promise<void> {
    state.fills += 1;
    const fill = state.fills;
    const [schemaResult, catalogResult, catalogText, variantsResult, accelResult] = await Promise.all([
        run(['voxtype', 'config', 'schema', '--json']),
        run(['voxtype', 'info', 'models', '--json']),
        run(['voxtype', 'info', 'models']),
        run(['voxtype', 'info', 'variants', '--json']),
        run(['voxtype', 'info', 'accel', '--json']),
    ]);

    if (fill !== state.fills) {
        return;
    }

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
    const activeEngine = keys.get('engine')?.value ?? null;
    const isActive = (model: DictationModel) => model.engine === activeEngine && isActiveModel(model, keys.get(`${model.engine}.model`)?.value);
    const facts: Facts = {
        state,
        keys,
        builds: variantsResult.ok ? parseBuilds(variantsResult.stdout) : parseBuilds(''),
        modelsDir: parseModelsDir(catalogText.stdout) ?? GLib.build_filenamev([GLib.get_user_data_dir(), 'voxtype', 'models']),
        activeEngine,
        active: models.find(isActive) ?? null,
        liveOn: keys.get(`${activeEngine}.streaming`)?.value === true,
    };

    add(buildModelsGroup(facts, models));

    const onDemand = keys.get(`${activeEngine}.on_demand_loading`);
    add(buildRunsGroup(state.window, {
        gpuRow: buildGpuRow(facts, accelResult.ok ? accelResult.stdout : ''),
        onDemand: onDemand?.compiled === true ? onDemand : null,
        liveLocked: activeEngine === 'whisper' && facts.liveOn,
    }));
}

function isSupported({ keys, builds }: Facts, model: DictationModel): boolean {
    return keys.get(`${model.engine}.model`)?.compiled === true
        || (builds.canSwitch && (modelFamily(model) === 'whisper' || builds.onnxBinary !== null));
}

function isLiveCapable({ keys }: Facts, model: DictationModel): boolean {
    return liveCapable(model, keys.has(`${model.engine}.streaming`));
}

// What is on now is the best guide to what the user wants, so it is what survives a trip through a
// model that cannot use the GPU.
function buildGpuRow(facts: Facts, accelJson: string): Adw.SwitchRow | null {
    const { state, builds, active, activeEngine } = facts;
    if (!builds.canSwitch || (!builds.whisperGpu && !builds.onnxGpu)) {
        return null;
    }

    const capable = gpuCapable({ engine: String(activeEngine) }, builds);
    const on = builds.onGpu || (builds.family === 'whisper' && hasGpuDropIn());
    if (capable) {
        state.settings.set_boolean(USE_GPU_KEY, on);
    }

    const engine = active === null ? 'This model' : modelDisplayName(active).split(' ')[0];
    const subtitle = !capable
        ? `${engine} can't use your GPU on this computer, so it runs on your CPU.`
        : on
            ? ['Much faster, but uses GPU memory.', gpuLabel(accelJson)].filter(Boolean).join(' ')
            : 'Saves GPU memory, but dictation is slower.';

    const row = new Adw.SwitchRow({ title: 'Use your GPU', subtitle, active: capable && on, sensitive: capable });

    let reverting = false;
    row.connect('notify::active', async () => {
        if (reverting) {
            return;
        }

        const enable = row.active;
        const argument = enable ? '--enable' : '--disable';
        const confirmed = await confirm(state.window, {
            heading: enable ? 'Use your GPU?' : 'Stop using your GPU?',
            lines: [
                enable ? 'Dictation moves to your <b>GPU</b>. Much faster, but uses GPU memory.' : 'Dictation moves to your <b>CPU</b>. Saves GPU memory, but is slower.',
                `Voxtype switches to its ${enable ? 'GPU' : 'CPU'} version. <b>You'll be asked for your password.</b>`,
                'Voxtype restarts.',
            ],
            commands: [['setup', 'gpu', argument]],
            action: enable ? 'Use GPU' : 'Stop Using GPU',
        });

        const result = confirmed ? await runAsAdmin([['setup', 'gpu', argument]]) : null;
        if (result !== true) {
            if (typeof result === 'string') {
                showToast(state.window, `Could not change GPU use: ${result}`);
            }
            reverting = true;
            row.active = !enable;
            reverting = false;
            return;
        }

        state.settings.set_boolean(USE_GPU_KEY, enable);
        await removeGpuDropIn();
        await restartIfRunning(state.window);
        refreshOnceLoaded(state);
    });

    return row;
}

// Runs `voxtype` as root with one password prompt. True when it worked, null when the user backed
// out of the prompt, and otherwise what went wrong.
async function runAsAdmin(commands: string[][]): Promise<true | null | string> {
    const voxtype = GLib.find_program_in_path('voxtype') ?? 'voxtype';
    const steps = commands.map(command => [voxtype, ...command]);
    const argv = steps.length === 1 ? steps[0] : ['/bin/sh', '-c', steps.map(step => step.map(word => GLib.shell_quote(word)).join(' ')).join(' && ')];

    const result = await run(['pkexec', ...argv]);
    if (result.ok) {
        return true;
    }
    return /dismissed|not authorized/i.test(result.stderr) ? null : firstLine(result.stderr);
}

type Confirmation = {
    heading: string;
    lines: string[];
    commands?: string[][];
    action: string;
};

function confirm(window: Adw.PreferencesWindow, { heading, lines, commands = [], action }: Confirmation): Promise<boolean> {
    return new Promise(resolve => {
        // The body of an alert is centered, which is hard to follow as a list.
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        content.append(new Gtk.Label({
            label: lines.map(line => `• ${line}`).join('\n'),
            use_markup: true,
            wrap: true,
            xalign: 0,
        }));

        if (commands.length > 0) {
            content.append(new Gtk.Expander({
                label: 'What this changes on your computer',
                child: new Gtk.Label({
                    label: commands.map(command => `pkexec voxtype ${command.join(' ')}`).join('\n'),
                    halign: Gtk.Align.START,
                    margin_top: 6,
                    selectable: true,
                    css_classes: ['caption', 'monospace'],
                }),
            }));
        }

        const dialog = new Adw.AlertDialog({
            heading,
            extra_child: content,
            default_response: 'confirm',
            close_response: 'cancel',
        });

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('confirm', action);
        dialog.set_response_appearance('confirm', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response: string) => resolve(response === 'confirm'));
        dialog.present(window);
    });
}

// A row's own title and subtitle have no room for a line of pills, so it carries its own text.
function buildModelText(title: string, detail: string | undefined, pills: string[], compact = false): Gtk.Box {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        spacing: 2,
        margin_top: compact ? 4 : 8,
        margin_bottom: compact ? 4 : 8,
        css_classes: compact ? ['voxtype-download-text'] : [],
    });
    box.append(new Gtk.Label({ label: title, halign: Gtk.Align.START, xalign: 0, wrap: true, css_classes: compact ? ['voxtype-compact-title'] : [] }));
    if (detail !== undefined) {
        box.append(new Gtk.Label({
            label: detail,
            halign: Gtk.Align.FILL,
            xalign: 0,
            wrap: true,
            max_width_chars: DETAIL_CHARS,
            css_classes: compact ? ['voxtype-compact-detail', 'dimmed'] : ['caption', 'dimmed'],
        }));
    }

    const line = new Gtk.Box({ spacing: 6, margin_top: 4 });
    pills.forEach((pill, index) => line.append(new Gtk.Label({ label: pill, css_classes: index === 0 ? ['voxtype-pill', 'voxtype-pill-size'] : ['voxtype-pill'] })));
    box.append(line);
    return box;
}

function installedSize(modelsDir: string, model: DictationModel): string {
    const bytes = modelSize(modelsDir, model);
    return bytes > 0 || model.note === null ? formatBytes(bytes) : model.note.size;
}

function modelPills(facts: Facts, model: DictationModel, size: string): string[] {
    return [
        size,
        ...(gpuCapable(model, facts.builds) ? ['GPU capable'] : []),
        ...(isLiveCapable(facts, model) ? ['Live transcription capable'] : []),
    ];
}

function buildModelsGroup(facts: Facts, models: DictationModel[]): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Your models',
        description: 'Pick the model that turns your speech into text. Voxtype uses one at a time, and choosing one restarts it.',
    });

    // Never shown. GTK only draws radio buttons in a group, and one alone is a checkbox that can be
    // unticked, so even a single model needs something to be grouped with.
    const noModel = new Gtk.CheckButton();
    const installed = models.filter(model => model.installed);
    let current: Gtk.CheckButton | null = null;
    let reverting = false;

    for (const model of installed) {
        const active = model === facts.active;
        const row = new Adw.ActionRow();
        const check = new Gtk.CheckButton({
            active,
            group: noModel,
            valign: Gtk.Align.CENTER,
            sensitive: isSupported(facts, model),
            // With nothing else to choose, "In use" says it all.
            visible: installed.length > 1 || !active,
        });

        row.add_prefix(buildModelText(modelDisplayName(model), model.note?.bestFor, modelPills(facts, model, installedSize(facts.modelsDir, model))));
        row.add_prefix(check);
        if (check.visible) {
            row.activatable_widget = check;
        }

        if (active) {
            current = check;
            row.add_suffix(new Gtk.Label({ label: 'In use', css_classes: ['dim-label'] }));
        } else {
            const remove = new Gtk.Button({ label: 'Remove', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
            remove.connect('clicked', () => removeModel(facts, model));
            row.add_suffix(remove);
        }
        group.add(row);

        check.connect('notify::active', async () => {
            if (!check.active || reverting) {
                return;
            }

            const previous = current;
            current = check;
            if (await switchModel(facts, model)) {
                refreshOnceLoaded(facts.state);
                return;
            }

            current = previous;
            reverting = true;
            (previous ?? noModel).active = true;
            reverting = false;
        });
    }

    const available = models.filter(({ installed }) => !installed);
    if (available.length > 0) {
        group.add(buildDownloadRow(facts, [...available.filter(model => isSupported(facts, model)), ...available.filter(model => !isSupported(facts, model))]));
    }

    return group;
}

// `voxtype setup model --set` refuses a model that is not downloaded; `voxtype config set` would not.
// It goes after the build switch, because a Whisper build cannot select anything else.
async function switchModel(facts: Facts, model: DictationModel): Promise<boolean> {
    const { state, builds, activeEngine, liveOn } = facts;
    const useGpu = state.settings.get_boolean(USE_GPU_KEY);
    const commands = buildSwitchCommands(builds, modelFamily(model), useGpu);
    const dropsLive = liveOn && !isLiveCapable(facts, model);
    const lines = switchSummary({
        changesBuild: commands.length > 0,
        onGpu: builds.onGpu,
        capable: gpuCapable(model, builds),
        useGpu,
        dropsLive,
        alternative: LIVE_ALTERNATIVES[model.engine] ?? null,
    });
    const name = modelDisplayName(model);

    if (lines.length > 0 && !await confirm(state.window, { heading: `Switch to ${name}?`, lines, commands, action: 'Switch' })) {
        return false;
    }

    if (commands.length > 0) {
        const result = await runAsAdmin(commands);
        if (result !== true) {
            if (result !== null) {
                showToast(state.window, `Could not switch to ${name}: ${result}`);
            }
            return false;
        }
        await removeGpuDropIn();
    }

    const result = await run(['voxtype', 'setup', 'model', '--set', model.downloadArg]);
    if (!result.ok) {
        showToast(state.window, `Could not switch to ${name}`);
        return false;
    }

    if (model.engine !== activeEngine && !await setConfig(state.window, 'engine', model.engine)) {
        return false;
    }

    if (dropsLive) {
        await setConfig(state.window, `${activeEngine}.streaming`, 'false');
    } else if (liveOn && model.engine !== activeEngine) {
        await setConfig(state.window, `${model.engine}.streaming`, 'true');
    }

    await restartIfRunning(state.window);
    return true;
}

async function removeModel(facts: Facts, model: DictationModel): Promise<void> {
    const { state, modelsDir } = facts;
    const name = modelDisplayName(model);
    const confirmed = await confirm(state.window, {
        heading: `Remove ${name}?`,
        lines: [`Frees up <b>${installedSize(modelsDir, model)}</b> of disk space.`, 'You can download it again at any time.'],
        action: 'Remove',
    });
    if (!confirmed) {
        return;
    }

    const paths = modelFileNames(model).map(file => Gio.File.new_for_path(GLib.build_filenamev([modelsDir, file])));
    const target = paths.find(file => file.query_exists(null));
    if (target === undefined || !deletePath(target)) {
        showToast(state.window, `Could not remove ${name}`);
    }
    refreshPage(state);
}

function buildDownloadRow(facts: Facts, models: DictationModel[]): Adw.ExpanderRow {
    const { state } = facts;
    const row = new Adw.ExpanderRow({
        title: 'Download a model',
        subtitle: 'Larger models are more accurate but slower.',
        expanded: state.downloadsOpen,
    });
    row.add_css_class('voxtype-download-row');
    row.connect('notify::expanded', () => {
        state.downloadsOpen = row.expanded;
    });

    // An expander row has no height limit of its own, so it holds one row with a list that scrolls.
    // Wrapped labels make that list ask for far too little, so the height is set from the entries.
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['voxtype-download-list'] });
    row.add_row(new Gtk.ListBoxRow({
        activatable: false,
        selectable: false,
        child: new Gtk.ScrolledWindow({
            child: list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: Math.min(DOWNLOAD_LIST_HEIGHT, models.length * DOWNLOAD_ENTRY_HEIGHT),
            max_content_height: DOWNLOAD_LIST_HEIGHT,
        }),
    }));

    const buttons: Gtk.Button[] = [];
    for (const model of models) {
        const supported = isSupported(facts, model);
        const entry = new Adw.ActionRow();
        const detail = supported ? model.note?.details : 'Needs another version of Voxtype, which is not installed here.';
        const progress = new Gtk.ProgressBar({ valign: Gtk.Align.CENTER, visible: false, width_request: PROGRESS_WIDTH });
        const cancelButton = new Gtk.Button({
            icon_name: 'process-stop-symbolic',
            tooltip_text: 'Cancel download',
            valign: Gtk.Align.CENTER,
            visible: false,
            css_classes: ['flat'],
        });
        const button = new Gtk.Button({ label: 'Download', valign: Gtk.Align.CENTER, sensitive: supported && state.download === null, css_classes: ['voxtype-compact-button'] });
        buttons.push(button);

        cancelButton.connect('clicked', () => state.download?.cancel());
        button.connect('clicked', async () => {
            const lines = [model.note?.details, model.note ? `Download size: <b>${model.note.size}</b>` : null].filter(line => typeof line === 'string');
            if (!await confirm(state.window, { heading: `Download ${modelDisplayName(model)}?`, lines, action: 'Download' })) {
                return;
            }

            buttons.forEach(other => {
                other.sensitive = false;
            });
            button.visible = false;
            progress.visible = true;
            cancelButton.visible = true;
            startDownload(facts, model, progress);
        });

        entry.add_prefix(buildModelText(modelDisplayName(model), detail, modelPills(facts, model, model.note?.size ?? ''), true));
        entry.add_suffix(progress);
        entry.add_suffix(cancelButton);
        entry.add_suffix(button);
        list.append(entry);
    }

    return row;
}

// A Whisper build refuses to fetch other models, but an ONNX program needs no switching to run once.
async function startDownload({ state, builds, modelsDir }: Facts, model: DictationModel, progress: Gtk.ProgressBar): Promise<void> {
    const voxtype = modelFamily(model) === 'onnx' && builds.family === 'whisper' && builds.onnxBinary !== null ? builds.onnxBinary : 'voxtype';
    const argv = [voxtype, 'setup', '--download', '--model', model.downloadArg, '--progress-format', 'json'];
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
