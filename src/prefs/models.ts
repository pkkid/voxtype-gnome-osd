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
    size: string;
    recommended?: string;
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

// From the model tables on voxtype.io, in the same order, keyed by the name `voxtype setup` takes.
// tiny.en is listed there as 39 MB, but the file is 75 MB. omnilingual-300m is listed as
// omnilingual-large, but voxtype's catalog does not know that name.
export const MODEL_NOTES: Record<string, ModelNote> = {
    'tiny.en': { bestFor: 'Quick notes, low-end hardware', size: '75 MB' },
    'base.en': { bestFor: 'Most users', size: '142 MB', recommended: 'Recommended' },
    'small.en': { bestFor: 'Higher accuracy needs', size: '466 MB' },
    'medium.en': { bestFor: 'Professional transcription', size: '1.5 GB' },
    'tiny': { bestFor: 'Quick notes, any language', size: '75 MB' },
    'base': { bestFor: 'General multilingual use', size: '142 MB' },
    'small': { bestFor: 'Better multilingual accuracy', size: '466 MB' },
    'medium': { bestFor: 'Professional multilingual', size: '1.5 GB' },
    'large-v3': { bestFor: 'Maximum accuracy', size: '3.1 GB' },
    'large-v3-turbo': { bestFor: 'Fast + accurate', size: '1.6 GB', recommended: 'Recommended with a GPU' },
    'parakeet-tdt-0.6b-v3-int8': { bestFor: 'Best English accuracy, built-in punctuation', size: '670 MB' },
    'moonshine-base': { bestFor: 'Fastest CPU inference, English', size: '237 MB' },
    'sensevoice-small': { bestFor: 'Chinese, Japanese, Korean, Cantonese, English', size: '239 MB' },
    'paraformer-zh': { bestFor: 'Chinese + English bilingual', size: '487 MB' },
    'dolphin-base': { bestFor: '40 languages + 22 Chinese dialects', size: '198 MB' },
    'omnilingual-300m': { bestFor: '1600+ languages, rare and low-resource', size: '3.9 GB' },
};

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

// A readable name like "Whisper English - Small", built from names like small.en. Whisper models
// come in English and multilingual versions; other engines put their own name first, as in
// moonshine-base.
export function modelDisplayName(model: InstalledModel): string {
    const engine = ENGINE_NAMES[model.engine] ?? model.engine;

    if (model.engine === 'whisper') {
        const english = model.name.endsWith('.en');
        return `${engine} ${english ? 'English' : 'Multilingual'} - ${readableWords(model.name.replace(/\.en$/, ''))}`;
    }

    const prefix = new RegExp(`^${model.engine}-`, 'i');
    return `${engine} - ${readableWords(model.downloadArg.replace(prefix, ''))}`;
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
    return [`ggml-${model.name}.bin`, model.downloadArg, model.name];
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

// Whether voxtype's Vulkan build is installed and has a GPU to use. It runs Whisper only.
export function gpuAvailable(variantsJson: string): boolean {
    try {
        const { variants } = JSON.parse(variantsJson) as { variants: { variant: string; installed: boolean; runs_on_this_cpu: boolean; gpu_available: boolean }[] };
        return variants.some(({ variant, installed, runs_on_this_cpu, gpu_available }) => variant === 'whisper-vulkan' && installed && runs_on_this_cpu && gpu_available);
    } catch {
        return false;
    }
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

// The Ollama model a cleanup command runs, or null for any other command.
export function cleanupModel(command: string): string | null {
    return /^\s*ollama\s+run\s+'?([^\s']+)'?/.exec(command)?.[1] ?? null;
}

function shellQuote(text: string): string {
    return `'${text.replace(/'/g, `'\\''`)}'`;
}
