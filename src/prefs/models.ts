// Pure helpers for the Models page. No GI imports so the unit tests can load this.

type CatalogModel = {
    name: string;
    download_arg: string;
    installed: boolean;
};

// The shape of `voxtype info models --json`.
export type ModelCatalog = {
    engines: Record<string, { models: CatalogModel[] }>;
};

export type InstalledModel = {
    engine: string;
    name: string;
    // The name `voxtype setup` knows it by, which for some engines differs from the catalog name.
    downloadArg: string;
};

export type OllamaModel = {
    name: string;
    size: string;
    bytes: number;
};

export type ModelNote = {
    bestFor: string;
    // Why someone would pick this one, for the download list.
    details: string;
    size: string;
};

export type DictationModel = InstalledModel & {
    installed: boolean;
    note: ModelNote | null;
};

export type DownloadEvent =
    | { kind: 'progress'; fraction: number; file: string }
    | { kind: 'done' }
    | { kind: 'error'; message: string };

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

// No emojis because ydotool cannot type them, and "only" because these models like to add a preamble.
const CLEANUP_PROMPT = 'Clean up this dictated text. Remove filler words, fix grammar and punctuation. Output ONLY the cleaned text, with no quotes, notes or emojis:';

// Must match DEFAULT_PROMPT in the wrapper, which a test checks.
export const DEFAULT_CLEANUP_PROMPT = 'Clean up this text. Fix spelling, grammar and punctuation, and remove filler words like um and uh. Output only the cleaned text: $text';

const CLEANUP_WRAPPER = 'bin/voxtype-cleanup.py';
const PROMPT_FLAG = '--prompt';

// From the model tables on voxtype.io, in the same order, keyed by the name `voxtype setup` takes.
// tiny.en is listed there as 39 MB, but the file is 75 MB. omnilingual-300m is listed as
// omnilingual-large, but voxtype's catalog does not know that name. voxtype.io lists one Parakeet
// model, so the others are described from the model list in voxtype's source.
export const MODEL_NOTES: Record<string, ModelNote> = {
    'tiny.en': { bestFor: 'Quick notes, low-end hardware', details: 'The smallest and fastest. Good for older computers. English only.', size: '75 MB' },
    'base.en': { bestFor: 'Most users', details: 'Quick and light. A good place to start. English only.', size: '142 MB' },
    'small.en': { bestFor: 'Higher accuracy needs', details: 'More accurate than Base, with a much smaller download than Turbo. English only.', size: '466 MB' },
    'medium.en': { bestFor: 'Professional transcription', details: 'More accurate than Small, and slower. English only.', size: '1.5 GB' },
    'tiny': { bestFor: 'Quick notes, any language', details: 'The smallest and fastest. Understands many languages.', size: '75 MB' },
    'base': { bestFor: 'General multilingual use', details: 'Quick and light. Understands many languages.', size: '142 MB' },
    'small': { bestFor: 'Better multilingual accuracy', details: 'More accurate than Base. Understands many languages.', size: '466 MB' },
    'medium': { bestFor: 'Professional multilingual', details: 'More accurate than Small, and slower. Understands many languages.', size: '1.5 GB' },
    'large-v3': { bestFor: 'Maximum accuracy', details: 'The most accurate Whisper model, and the biggest. Understands many languages.', size: '3.1 GB' },
    'large-v3-turbo': { bestFor: 'Fast + accurate', details: 'More accurate than Base, and understands many languages. Best on a GPU.', size: '1.6 GB' },
    'parakeet-unified-en-0.6b': { bestFor: 'Types as you speak', details: 'The only Parakeet model that can do live transcription. English only.', size: '2.7 GB' },
    'parakeet-tdt-0.6b-v3': { bestFor: 'Full size, built-in punctuation', details: 'Voxtype\'s default Parakeet model. Adds punctuation for you. English only.', size: '2.6 GB' },
    'parakeet-tdt-0.6b-v3-int8': { bestFor: 'Smaller and faster than the full v3', details: 'The same model made smaller, with built-in punctuation. English only.', size: '670 MB' },
    'parakeet-tdt-0.6b-v2': { bestFor: 'Best English accuracy', details: 'Voxtype lists this as its most accurate English model. English only.', size: '2.4 GB' },
    'parakeet-tdt-0.6b-v2-int8': { bestFor: 'Smaller and faster than the full v2', details: 'The same model made smaller. English only.', size: '640 MB' },
    'moonshine-base': { bestFor: 'Fastest CPU inference, English', details: 'Built for speed on a CPU. English only.', size: '237 MB' },
    'sensevoice-small': { bestFor: 'Chinese, Japanese, Korean, Cantonese, English', details: 'Understands Chinese, Japanese, Korean, Cantonese and English.', size: '239 MB' },
    'paraformer-zh': { bestFor: 'Chinese + English bilingual', details: 'Understands Chinese and English, even mixed together.', size: '487 MB' },
    'dolphin-base': { bestFor: '40 languages + 22 Chinese dialects', details: 'Understands 40 languages and 22 Chinese dialects.', size: '198 MB' },
    'omnilingual-300m': { bestFor: '1600+ languages, rare and low-resource', details: 'Understands over 1600 languages, including rare ones.', size: '3.9 GB' },
};

// The only Parakeet model voxtype's live transcription can load.
export const LIVE_PARAKEET_MODEL = 'parakeet-unified-en-0.6b';

const ENGINE_NAMES: Record<string, string> = {
    cohere: 'Cohere',
    dolphin: 'Dolphin',
    moonshine: 'Moonshine',
    omnilingual: 'Omnilingual',
    openvino: 'OpenVINO',
    paraformer: 'Paraformer',
    parakeet: 'Parakeet',
    sensevoice: 'SenseVoice',
    whisper: 'Whisper',
};

const MODEL_WORDS: Record<string, string> = {
    ar: 'Arabic',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    tdt: 'TDT',
    zh: 'Chinese',
};

export function installedModels(catalog: ModelCatalog): InstalledModel[] {
    return Object.entries(catalog.engines).flatMap(([engine, { models }]) => models
        .filter(model => model.installed)
        .map(model => ({ engine, name: model.name, downloadArg: model.download_arg })));
}

// Models voxtype.io describes, in its order, then anything else that is downloaded.
export function dictationModels(catalog: ModelCatalog): DictationModel[] {
    const models = Object.entries(catalog.engines).flatMap(([engine, { models: listed }]) => listed.map(model => ({
        engine,
        name: model.name,
        downloadArg: model.download_arg,
        installed: model.installed,
        note: MODEL_NOTES[model.download_arg] ?? null,
    })));
    const order = Object.keys(MODEL_NOTES);
    const described = models.filter(model => model.note !== null)
        .sort((a, b) => order.indexOf(a.downloadArg) - order.indexOf(b.downloadArg));

    return [...described, ...models.filter(model => model.note === null && model.installed)];
}

// A readable name like "Whisper English Small", built from names like small.en. Whisper models
// come in English and multilingual versions; other engines put their own name first, as in
// moonshine-base.
export function modelDisplayName(model: InstalledModel): string {
    const engine = ENGINE_NAMES[model.engine] ?? model.engine;

    if (model.engine === 'whisper') {
        const english = model.name.endsWith('.en');
        return `${engine} ${english ? 'English' : 'Multilingual'} ${readableWords(model.name.replace(/\.en$/, ''))}`;
    }

    const prefix = new RegExp(`^${model.engine}-`, 'i');
    return `${engine} ${readableWords(model.downloadArg.replace(prefix, ''))}`;
}

function readableWords(name: string): string {
    return name.split('-').map(word => MODEL_WORDS[word] ?? (/^[a-z]+$/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ');
}

// One line of `voxtype setup --download --progress-format json`.
export function parseDownloadEvent(line: string): DownloadEvent | null {
    let event: { event?: string; pct?: number; file?: string; message?: string };
    try {
        event = JSON.parse(line) as typeof event;
    } catch {
        return null;
    }

    if (event?.event === 'progress') {
        return { kind: 'progress', fraction: (event.pct ?? 0) / 100, file: event.file ?? '' };
    }
    if (event?.event === 'done') {
        return { kind: 'done' };
    }
    return event?.event === 'error' ? { kind: 'error', message: event.message ?? '' } : null;
}

export function isActiveModel(model: InstalledModel, configured: unknown): boolean {
    return configured === model.name || configured === model.downloadArg;
}

// Where a model may live under the models folder: whisper uses a ggml file, other engines a directory.
export function modelFileNames(model: InstalledModel): string[] {
    return model.engine === 'whisper' ? [`ggml-${model.name}.bin`] : [model.downloadArg, model.name];
}

// `voxtype info models --json` leaves the folder out, but the text form opens with it.
export function parseModelsDir(text: string): string | null {
    return /^Model catalog\s+\((.+)\)\s*$/m.exec(text)?.[1] ?? null;
}

// `ollama list` prints a header, then NAME, ID, SIZE and MODIFIED columns padded with spaces.
export function parseOllamaList(text: string): OllamaModel[] {
    return text.split('\n').slice(1).flatMap(line => {
        const [name, , size] = line.trim().split(/\s{2,}|\t+/);
        return name && size ? [{ name, size, bytes: parseOllamaSize(size) }] : [];
    });
}

// Ollama counts in thousands, unlike voxtype.
function parseOllamaSize(size: string): number {
    const match = /^([\d.]+)\s*([KMGT]?B)$/i.exec(size);
    if (match === null) {
        return 0;
    }
    return Number(match[1]) * 1000 ** BYTE_UNITS.indexOf(match[2].toUpperCase());
}

// Voxtype is several programs, and /usr/bin/voxtype points at one of them. The Whisper ones run
// Whisper models, some on the GPU through Vulkan. The ONNX ones run everything else, some on the GPU
// through CUDA or MIGraphX, and Whisper too, but only on the CPU.
export type BuildFamily = 'whisper' | 'onnx';

export type Builds = {
    // Only package installs have other programs to switch to.
    canSwitch: boolean;
    family: BuildFamily;
    onGpu: boolean;
    whisperGpu: boolean;
    onnxGpu: boolean;
    // An ONNX program that runs here, which a Whisper one can hand work to without being switched.
    onnxBinary: string | null;
};

type BuildVariant = { variant: string; binary_name: string; installed: boolean; runs_on_this_cpu: boolean; gpu_available: boolean };

const NO_BUILDS: Builds = { canSwitch: false, family: 'whisper', onGpu: false, whisperGpu: false, onnxGpu: false, onnxBinary: null };

// From `voxtype info variants --json`. binary_path is what starts next, which after a switch is
// newer than running_variant.
export function parseBuilds(variantsJson: string): Builds {
    let report: { install_kind?: string; binary_path?: string; package_lib_dir?: string; variants: BuildVariant[] };
    try {
        report = JSON.parse(variantsJson) as typeof report;
    } catch {
        return NO_BUILDS;
    }

    const usable = report.variants.filter(({ installed, runs_on_this_cpu, gpu_available }) => installed && runs_on_this_cpu && gpu_available);
    const onGpu = (variant: string) => /vulkan|cuda|migraphx/.test(variant);
    const family = (variant: string): BuildFamily => variant.startsWith('onnx') ? 'onnx' : 'whisper';
    const current = report.variants.find(({ binary_name }) => report.binary_path?.endsWith(`/${binary_name}`))?.variant ?? '';
    const onnxCpu = usable.find(({ variant }) => family(variant) === 'onnx' && !onGpu(variant));

    return {
        canSwitch: report.install_kind === 'package',
        family: family(current),
        onGpu: onGpu(current),
        whisperGpu: usable.some(({ variant }) => family(variant) === 'whisper' && onGpu(variant)),
        onnxGpu: usable.some(({ variant }) => family(variant) === 'onnx' && onGpu(variant)),
        onnxBinary: onnxCpu && report.package_lib_dir ? `${report.package_lib_dir}/${onnxCpu.binary_name}` : null,
    };
}

export function modelFamily(model: { engine: string }): BuildFamily {
    return model.engine === 'whisper' ? 'whisper' : 'onnx';
}

export function gpuCapable(model: { engine: string }, builds: Builds): boolean {
    return modelFamily(model) === 'whisper' ? builds.whisperGpu : builds.onnxGpu;
}

// `streamingKnown` is whether voxtype has a streaming setting for the model's engine at all.
export function liveCapable(model: { engine: string; name: string }, streamingKnown: boolean): boolean {
    return streamingKnown && (model.engine !== 'parakeet' || model.name === LIVE_PARAKEET_MODEL);
}

// What to hand `voxtype setup` so the next start can run a model of this family. Neither step does
// the GPU choice on its own: leaving ONNX lands on the CPU, and entering it picks the GPU if it can.
// `setup gpu --enable` fails from ONNX on a machine with no ONNX GPU program, so it is never asked.
export function buildSwitchCommands(builds: Builds, target: BuildFamily, useGpu: boolean): string[][] {
    if (!builds.canSwitch || builds.family === target) {
        return [];
    }

    if (target === 'onnx') {
        return [['setup', 'onnx', '--enable'], ...(builds.onnxGpu && !useGpu ? [['setup', 'gpu', '--disable']] : [])];
    }
    return [['setup', 'onnx', '--disable'], ...(builds.whisperGpu ? [['setup', 'gpu', useGpu ? '--enable' : '--disable']] : [])];
}

type SwitchChange = {
    changesBuild: boolean;
    onGpu: boolean;
    capable: boolean;
    useGpu: boolean;
    dropsLive: boolean;
    alternative: string | null;
};

// The confirmation for changing models, as Pango markup. Empty when there is nothing to warn about.
export function switchSummary({ changesBuild, onGpu, capable, useGpu, dropsLive, alternative }: SwitchChange): string[] {
    const lines: string[] = [];

    if (changesBuild) {
        const willUseGpu = capable && useGpu;
        if (willUseGpu) {
            lines.push(onGpu ? 'Dictation stays on your GPU.' : 'Dictation moves to your <b>GPU</b>, because "Use your GPU" is on.');
        } else if (onGpu) {
            lines.push('Dictation moves to your <b>CPU</b>, because this model can\'t use your GPU on this computer. It may take longer to finish.');
        } else {
            lines.push(capable ? 'Dictation stays on your CPU, because "Use your GPU" is off.' : 'Dictation stays on your CPU.');
        }
        lines.push('Voxtype switches to the version that runs this model. <b>You\'ll be asked for your password.</b>');
    }
    if (dropsLive) {
        lines.push(`<b>Live transcription turns off</b>, because this model can't do it.${alternative ? ` ${alternative} can.` : ''}`);
    }

    return lines.length > 0 ? [...lines, 'Voxtype restarts.'] : [];
}

// Where the running daemon actually ended up, from `voxtype info accel --json`.
export function gpuLabel(accelJson: string): string {
    try {
        const { state } = JSON.parse(accelJson) as { state?: string };
        switch (state) {
        case 'gpu':
            return 'Running on the GPU now.';
        case 'cpu-fallback':
            return 'Could not use the GPU, so it fell back to the CPU.';
        case 'cpu-only':
            return 'Running on the CPU now.';
        default:
            return '';
        }
    } catch {
        return '';
    }
}

// Which memory the running daemon's model lives in, or null when voxtype cannot tell.
export function modelLocation(accelJson: string): 'gpu' | 'cpu' | null {
    try {
        const { state } = JSON.parse(accelJson) as { state?: string };
        if (state === 'gpu') {
            return 'gpu';
        }
        return state === 'cpu-only' || state === 'cpu-fallback' ? 'cpu' : null;
    } catch {
        return null;
    }
}

// voxtype only knows where a model went once one has loaded, so before that it reports "unknown".
export function modelPlace(location: 'gpu' | 'cpu' | null, isOnDemand: boolean): string {
    if (location === null) {
        return isOnDemand ? 'Model is not loaded until you dictate.' : 'Voxtype has not reported where the model is loaded yet.';
    }

    const place = location === 'gpu' ? 'GPU memory' : 'system memory';
    return isOnDemand ? `Model is loaded in ${place} only while you dictate.` : `Model is loaded in ${place}.`;
}

// Whether the running daemon is a GPU build, which holds until a model proves otherwise.
export function onGpuBuild(accelJson: string): boolean {
    try {
        return (JSON.parse(accelJson) as { backend?: string | null }).backend != null;
    } catch {
        return false;
    }
}

// The video memory the daemon holds, in bytes, from the evidence in `voxtype info accel --json`.
export function gpuMemory(accelJson: string): number | null {
    try {
        const { evidence } = JSON.parse(accelJson) as { evidence?: string[] };
        const held = evidence?.map(line => /^vram: (\d+) MiB/.exec(line)).find(match => match !== null && match !== undefined);
        return held ? Number(held[1]) * 1024 ** 2 : null;
    } catch {
        return null;
    }
}

export function formatBytes(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

export function cleanupCommand(model: string): string {
    return `ollama run ${shellQuote(model)} ${shellQuote(CLEANUP_PROMPT)}`;
}

// Runs the wrapper that ships with the extension, which uses the installed Claude Code with no tools.
export function claudeCleanupCommand(extensionPath: string): string {
    return `python3 ${shellQuote(`${extensionPath}/${CLEANUP_WRAPPER}`)} --model haiku --effort low --prompt ${shellQuote(DEFAULT_CLEANUP_PROMPT)}`;
}

// The prompt the wrapper in a cleanup command uses, or null for a command that takes no prompt, or
// one this cannot safely rewrite, like a pipeline.
export function cleanupPrompt(command: string): string | null {
    const words = shellWords(command);
    if (words === null || !words.some(word => word.endsWith(CLEANUP_WRAPPER))) {
        return null;
    }

    const index = words.indexOf(PROMPT_FLAG);
    const inline = words.find(word => word.startsWith(`${PROMPT_FLAG}=`));
    return (index === -1 ? inline?.slice(PROMPT_FLAG.length + 1) : words[index + 1]) || DEFAULT_CLEANUP_PROMPT;
}

// The same command with its prompt replaced. A blank prompt goes back to the wrapper's own default.
export function withCleanupPrompt(command: string, prompt: string): string {
    const words = (shellWords(command) ?? []).filter((word, index, all) => word !== PROMPT_FLAG && all[index - 1] !== PROMPT_FLAG && !word.startsWith(`${PROMPT_FLAG}=`));
    return [...words, ...(prompt.trim() === '' ? [] : [PROMPT_FLAG, prompt])].map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : shellQuote(word)).join(' ');
}

// Splits a simple command into words, or gives null if it uses anything more than quotes and spaces.
function shellWords(command: string): string[] | null {
    const words: string[] = [];
    let word: string | null = null;
    let quote = '';

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];

        if (quote === "'") {
            quote = char === "'" ? '' : quote;
            word += char === "'" ? '' : char;
        } else if (quote === '"') {
            if (char === '$' || char === '`') {
                return null;
            }
            quote = char === '"' ? '' : quote;
            const escaped = char === '\\' && /["\\]/.test(command[index + 1] ?? '');
            word += escaped ? command[++index] : char === '"' ? '' : char;
        } else if (/\s/.test(char)) {
            if (word !== null) {
                words.push(word);
                word = null;
            }
        } else if (/[|&;<>()$`*?#~]/.test(char)) {
            return null;
        } else if (char === '\\') {
            word = (word ?? '') + (command[++index] ?? '');
        } else {
            quote = char === "'" || char === '"' ? char : '';
            word = (word ?? '') + (quote === '' ? char : '');
        }
    }

    if (quote !== '') {
        return null;
    }
    return word === null ? words : [...words, word];
}

// The Ollama model a cleanup command runs, or null for any other command.
export function cleanupModel(command: string): string | null {
    return /^\s*ollama\s+run\s+'?([^\s']+)'?/.exec(command)?.[1] ?? null;
}

function shellQuote(text: string): string {
    return `'${text.replace(/'/g, `'\\''`)}'`;
}
