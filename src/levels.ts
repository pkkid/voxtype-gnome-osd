export type AudioSample = {
    peak: number;
};

export const WAVEFORM_GAIN = 10;

export function clampToUnit(value: number): number {
    return Math.min(Math.max(value, 0), 1);
}

export function parseBridgeLine(line: string): AudioSample | null {
    try {
        const peak = (JSON.parse(line) as { peak?: unknown } | null)?.peak;
        return typeof peak === 'number' && Number.isFinite(peak) ? { peak: clampToUnit(peak) } : null;
    } catch {
        return null;
    }
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

// Once the mic closes during live dictation, voxtype sends exact silence about 30 times a second to
// keep indicators alive. The mic itself sends 100 a second, so the rate tells this apart from a muted
// or noise-gated mic, which can be just as silent.
const MIC_CLOSED_SAMPLES = 8;
const MIC_CLOSED_MIN_GAP_MS = 20;

export class MicCloseDetector {
    private silenceStart: number | null = null;
    private silentSamples = 0;

    // Takes each peak and the time in milliseconds, and returns true once the mic has closed.
    feed(peak: number, now: number): boolean {
        if (peak !== 0) {
            this.silenceStart = null;
            return false;
        }

        if (this.silenceStart === null) {
            this.silenceStart = now;
            this.silentSamples = 0;
            return false;
        }

        this.silentSamples += 1;
        return this.silentSamples >= MIC_CLOSED_SAMPLES && (now - this.silenceStart) / this.silentSamples >= MIC_CLOSED_MIN_GAP_MS;
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
