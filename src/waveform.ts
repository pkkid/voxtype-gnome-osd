import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { Rgb } from './color.js';
import { AudioSample, equalizerHeights, LevelHistory, rippleHeights } from './levels.js';

const REDRAW_INTERVAL_MS = 33;
const STEP_INTERVAL_US = 100_000;
const BAR_WIDTH = 3;
const STEP_PITCH = 6;
const RIPPLE_SPEED = 6;

export type IndicatorStyle = 'classic' | 'minimal' | 'wave' | 'osd';

// live: follows the microphone. busy: voxtype is transcribing. still: flat, used while positioning.
export type WaveformMode = 'live' | 'busy' | 'still';

type Context = ReturnType<St.DrawingArea['get_context']>;

const EQUALIZER_BARS: Partial<Record<IndicatorStyle, number>> = {
    minimal: 9,
    osd: 22,
};

const WAVE_LAYERS = [
    { scale: 1, cycles: 1.6, speed: 3.2, alpha: 1, width: 2.2 },
    { scale: 0.7, cycles: 2.4, speed: -2.4, alpha: 0.55, width: 1.6 },
    { scale: 0.45, cycles: 3.3, speed: 4.1, alpha: 0.35, width: 1.2 },
];

export class Waveform {
    readonly actor: St.DrawingArea;
    private readonly history = new LevelHistory();
    private redrawSourceId = 0;
    private lastStepUs = 0;
    private style: IndicatorStyle = 'classic';
    private mode: WaveformMode = 'still';
    private color: Rgb = [1, 1, 1];

    constructor() {
        this.actor = new St.DrawingArea({
            style_class: 'voxtype-waveform',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.actor.connect('repaint', () => this.paint());
    }

    setStyle(style: IndicatorStyle): void {
        this.style = style;
        this.actor.queue_repaint();
    }

    setColor(color: Rgb): void {
        this.color = color;
        this.actor.queue_repaint();
    }

    push(sample: AudioSample): void {
        this.history.push(sample);
    }

    clear(): void {
        this.history.clear();
        this.actor.queue_repaint();
    }

    // Animates in live and busy mode; still mode draws once.
    start(mode: WaveformMode): void {
        this.mode = mode;
        this.actor.queue_repaint();

        if (mode === 'still') {
            this.stopTimer();
            return;
        }

        if (this.redrawSourceId !== 0) {
            return;
        }

        this.lastStepUs = GLib.get_monotonic_time();
        this.redrawSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REDRAW_INTERVAL_MS, () => {
            this.tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop(): void {
        this.stopTimer();
    }

    destroy(): void {
        this.stopTimer();
        this.actor.destroy();
    }

    private stopTimer(): void {
        if (this.redrawSourceId !== 0) {
            GLib.source_remove(this.redrawSourceId);
            this.redrawSourceId = 0;
        }
    }

    private tick(): void {
        if (this.mode === 'live') {
            const now = GLib.get_monotonic_time();
            while (now - this.lastStepUs >= STEP_INTERVAL_US) {
                this.history.step();
                this.lastStepUs += STEP_INTERVAL_US;
            }
        }

        this.actor.queue_repaint();
    }

    private paint(): void {
        const [width, height] = this.actor.get_surface_size();
        const context = this.actor.get_context();

        try {
            context.setSourceRGBA(this.color[0], this.color[1], this.color[2], 0.95);
            if (this.style === 'wave') {
                this.paintWave(context, width, height);
            } else if (this.style === 'classic') {
                this.paintSteps(context, width, height);
            } else {
                this.paintEqualizer(context, width, height, EQUALIZER_BARS[this.style] ?? 9);
            }
        } finally {
            context.$dispose();
        }
    }

    private seconds(): number {
        return GLib.get_monotonic_time() / 1_000_000;
    }

    // Classic: one bar per 100 ms step, newest at the right edge.
    private paintSteps(context: Context, width: number, height: number): void {
        const count = Math.max(1, Math.floor((width - BAR_WIDTH) / STEP_PITCH) + 1);

        let levels: number[];
        if (this.mode === 'busy') {
            levels = rippleHeights(count, this.seconds() * RIPPLE_SPEED);
        } else if (this.mode === 'live') {
            levels = this.history.bars().slice(-count);
        } else {
            levels = [];
        }

        const firstX = width - BAR_WIDTH - (count - 1) * STEP_PITCH;
        for (let index = 0; index < count; index += 1) {
            const offset = count - levels.length;
            const level = index >= offset ? levels[index - offset] : 0;
            drawBar(context, firstX + index * STEP_PITCH, height, level);
        }
        context.stroke();
    }

    // Minimal and GNOME OSD: a short centre-weighted equalizer spread across the width.
    private paintEqualizer(context: Context, width: number, height: number, bars: number): void {
        let levels: number[];
        if (this.mode === 'busy') {
            levels = rippleHeights(bars, this.seconds() * RIPPLE_SPEED);
        } else if (this.mode === 'live') {
            levels = equalizerHeights(this.history.recent(bars), this.history.level, bars);
        } else {
            levels = new Array<number>(bars).fill(0);
        }

        const gap = bars > 1 ? (width - bars * BAR_WIDTH) / (bars - 1) : 0;
        levels.forEach((level, index) => drawBar(context, index * (BAR_WIDTH + gap), height, level));
        context.stroke();
    }

    // Wave: three layered sine ribbons whose height follows the voice, tapered at both ends.
    private paintWave(context: Context, width: number, height: number): void {
        const middle = height / 2;
        const time = this.seconds();

        let amplitude: number;
        if (this.mode === 'busy') {
            amplitude = 0.08 + 0.04 * Math.sin(time * 3);
        } else if (this.mode === 'live') {
            amplitude = Math.max(0.04, this.history.level);
        } else {
            amplitude = 0.04;
        }

        WAVE_LAYERS.forEach((layer, index) => {
            for (let x = 0; x <= width; x += 2) {
                const progress = width === 0 ? 0 : x / width;
                const taper = Math.sin(Math.PI * progress) ** 2;
                const swing = Math.sin(progress * Math.PI * 2 * layer.cycles + time * layer.speed);
                const y = middle + swing * amplitude * layer.scale * (middle - 2) * taper;
                if (x === 0) {
                    context.moveTo(x, y);
                } else {
                    context.lineTo(x, y);
                }
            }

            context.setSourceRGBA(this.color[0], this.color[1], this.color[2], layer.alpha);
            context.setLineWidth(layer.width);

            if (index === 0) {
                // Lightly fill between the main ribbon and the centre line.
                context.strokePreserve();
                context.lineTo(width, middle);
                context.lineTo(0, middle);
                context.closePath();
                context.setSourceRGBA(this.color[0], this.color[1], this.color[2], 0.12);
                context.fill();
            } else {
                context.stroke();
            }
        });
    }
}

// Adds one rounded bar, centred vertically, to the path. A round-capped line draws the rounded ends,
// and a zero-length one still leaves a dot so silence shows as a row of dots.
function drawBar(context: Context, x: number, height: number, level: number): void {
    const radius = BAR_WIDTH / 2;
    const length = Math.max(0, Math.min(height, Math.max(BAR_WIDTH, level * height)) - BAR_WIDTH);
    const centreX = x + radius;
    const top = (height - length) / 2;

    context.setLineWidth(BAR_WIDTH);
    context.setLineCap(Cairo.LineCap.ROUND);
    context.moveTo(centreX, top);
    context.lineTo(centreX, top + length);
}
