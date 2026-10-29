export type AudioSample = {
    peak: number;
};

export const WAVEFORM_GAIN = 10;

function clampToUnit(value: number): number {
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}

function isUsableNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function parseBridgeLine(line: string): AudioSample | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
        return null;
    }

    let payload: unknown;
    try {
        payload = JSON.parse(trimmed);
    } catch {
        return null;
    }

    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    const fields = payload as Record<string, unknown>;
    if (!isUsableNumber(fields.peak)) {
        return null;
    }

    return { peak: clampToUnit(fields.peak) };
}

// Smoothing for the overall level: rise quickly with the voice, fall back slowly.
const LEVEL_ATTACK = 0.45;
const LEVEL_DECAY = 0.08;
const RECENT_CAPACITY = 32;

export const STEP_CAPACITY = 120;

// Collects the bridge's peaks for the indicator styles. step() turns everything heard since the
// previous step into one bar, so the Classic bars jump left a whole slot at a time; level is a
// smoothed loudness for the styles that react to the voice as a whole.
export class LevelHistory {
    private readonly steps: number[];
    private readonly recentPeaks: number[] = [];
    private pending = 0;
    private smoothed = 0;

    constructor(capacity: number = STEP_CAPACITY) {
        this.steps = new Array<number>(capacity).fill(0);
    }

    get level(): number {
        return this.smoothed;
    }

    push(sample: AudioSample): void {
        const height = clampToUnit(sample.peak * WAVEFORM_GAIN);

        this.pending = Math.max(this.pending, height);
        this.smoothed += (height - this.smoothed) * (height > this.smoothed ? LEVEL_ATTACK : LEVEL_DECAY);

        this.recentPeaks.push(height);
        if (this.recentPeaks.length > RECENT_CAPACITY) {
            this.recentPeaks.shift();
        }
    }

    step(): void {
        this.steps.push(this.pending);
        this.steps.shift();
        this.pending = 0;
    }

    // Oldest first, newest at the end.
    bars(): number[] {
        return [...this.steps];
    }

    // The last `count` peaks, newest at the end, padded with silence.
    recent(count: number): number[] {
        const padding = new Array<number>(Math.max(0, count - this.recentPeaks.length)).fill(0);
        return [...padding, ...this.recentPeaks.slice(-count)];
    }

    clear(): void {
        this.steps.fill(0);
        this.recentPeaks.length = 0;
        this.pending = 0;
        this.smoothed = 0;
    }
}

// Bar heights for the small equalizers: the middle bars stand taller, and each bar follows a
// different recent peak so the row flickers with the voice instead of moving in lockstep.
export function equalizerHeights(recent: number[], level: number, bars: number): number[] {
    const middle = (bars - 1) / 2;

    return Array.from({ length: bars }, (_, index) => {
        const spread = middle === 0 ? 0 : Math.abs(index - middle) / middle;
        const weight = 1 - 0.6 * spread * spread;
        const peak = recent.length === 0 ? 0 : recent[recent.length - 1 - ((index * 7) % recent.length)];
        return clampToUnit((0.4 * level + 0.6 * peak) * weight * 1.3);
    });
}

// A wave travelling left to right across the bars, shown while voxtype transcribes.
export function rippleHeights(bars: number, phase: number): number[] {
    return Array.from({ length: bars }, (_, index) => 0.2 + 0.3 * Math.max(0, Math.sin(phase - index * 0.6)));
}
