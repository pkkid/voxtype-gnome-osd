import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { accentColor, parseHexColor, RECORDING_DOT_COLOR, Rgb } from './color.js';
import { DaemonState, isRecording } from './daemonState.js';
import { AudioSample } from './levels.js';
import { IndicatorStyle, isIndicatorStyle } from './styles.js';
import { Waveform, WaveformMode } from './waveform.js';

const FADE_MS = 130;
const POSITIONING_TIMEOUT_SECS = 20;
const POSITIONING_LINGER_MS = 1200;

const STYLE_SIZES: Record<IndicatorStyle, [number, number]> = {
    classic: [400, 72],
    minimal: [96, 30],
    wave: [400, 72],
    osd: [250, 62],
};
// Minimal without its equalizer is just the dot.
const MINIMAL_DOT_ONLY_SIZE: [number, number] = [30, 30];

// With live dictation the words are typed while you speak, so that already counts as transcribing.
const STATE_LABELS: Partial<Record<DaemonState, string>> = {
    recording: 'Recording…',
    streaming: 'Transcribing…',
    transcribing: 'Transcribing…',
};

type Drag = {
    grab: Clutter.Grab;
    offsetX: number;
    offsetY: number;
};

export class OsdPill {
    private readonly settings: Gio.Settings;
    private readonly container: St.BoxLayout;
    private readonly waveform = new Waveform();
    private label: St.Label | null = null;
    private dot: St.Widget | null = null;
    private style: IndicatorStyle = 'classic';
    private readonly signalIds: number[] = [];
    private monitorsChangedId = 0;
    private state: DaemonState = 'unavailable';
    private positioning = false;
    private positioningTimeoutId = 0;
    private drag: Drag | null = null;
    private wantVisible = false;

    constructor(settings: Gio.Settings) {
        this.settings = settings;

        this.container = new St.BoxLayout({
            style_class: 'voxtype-pill',
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this.buildContent();
        this.connectDragHandlers();

        Main.layoutManager.addTopChrome(this.container);
        this.monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this.reposition());

        for (const key of ['pill-x', 'pill-y']) {
            this.signalIds.push(this.settings.connect(`changed::${key}`, () => this.reposition()));
        }
        this.signalIds.push(this.settings.connect('changed::show-pill', () => this.render()));
        this.signalIds.push(this.settings.connect('changed::show-waveform', () => this.render()));
        this.signalIds.push(this.settings.connect('changed::accent-color', () => this.render()));
        this.signalIds.push(this.settings.connect('changed::pill-style', () => {
            this.buildContent();
            this.render();
        }));

        this.reposition();
    }

    get showsWaveform(): boolean {
        return this.settings.get_boolean('show-pill') && this.settings.get_boolean('show-waveform');
    }

    setState(state: DaemonState): void {
        if (isRecording(state) && !isRecording(this.state)) {
            this.waveform.clear();
        }
        this.state = state;
        if (STATE_LABELS[state] !== undefined) {
            this.endPositioning();
        }
        this.render();
    }

    // Shows the pill with a hint so it can be dragged somewhere new while nothing is recording.
    startPositioning(): void {
        this.positioning = true;
        this.clearPositioningTimeout();
        this.positioningTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POSITIONING_TIMEOUT_SECS, () => {
            this.positioningTimeoutId = 0;
            this.endPositioning();
            return GLib.SOURCE_REMOVE;
        });
        this.render();
    }

    pushSample(sample: AudioSample): void {
        this.waveform.push(sample);
    }

    destroy(): void {
        this.endDrag(false);
        this.clearPositioningTimeout();

        for (const id of this.signalIds) {
            this.settings.disconnect(id);
        }
        this.signalIds.length = 0;

        if (this.monitorsChangedId !== 0) {
            Main.layoutManager.disconnect(this.monitorsChangedId);
            this.monitorsChangedId = 0;
        }

        this.waveform.destroy();
        Main.layoutManager.removeChrome(this.container);
        this.container.destroy();
    }

    // Builds the inside of the pill for the chosen style. The waveform actor is kept and moved over.
    private buildContent(): void {
        this.waveform.actor.get_parent()?.remove_child(this.waveform.actor);
        this.container.destroy_all_children();

        this.style = readStyle(this.settings);
        this.container.style_class = `voxtype-pill voxtype-pill-${this.style}`;
        this.waveform.setStyle(this.style);

        if (this.style === 'minimal') {
            this.label = null;
            this.dot = new St.Widget({
                style_class: 'voxtype-pill-dot',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.container.add_child(this.dot);
            this.container.add_child(this.waveform.actor);
            return;
        }

        // A white microphone with the status dot tucked into its bottom-right corner.
        const microphone = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        microphone.add_child(new St.Icon({
            style_class: 'voxtype-pill-icon',
            icon_name: 'audio-input-microphone-symbolic',
        }));
        this.dot = new St.Widget({
            style_class: 'voxtype-pill-badge',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            translation_x: 2,
            translation_y: 1,
        });
        microphone.add_child(this.dot);

        const stack = new St.BoxLayout({
            style_class: 'voxtype-pill-stack',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.label = new St.Label({
            style_class: 'voxtype-pill-label',
            x_align: this.style === 'osd' ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
        });
        stack.add_child(this.label);
        stack.add_child(this.waveform.actor);

        this.container.add_child(microphone);
        this.container.add_child(stack);
    }

    private render(): void {
        const accent = accentColor(this.settings.get_string('accent-color'));
        const label = this.settings.get_boolean('show-pill') ? STATE_LABELS[this.state] : undefined;

        if (label === undefined && !this.positioning) {
            this.waveform.stop();
            this.hide();
            return;
        }

        const showWaveform = this.settings.get_boolean('show-waveform');
        const [width, height] = this.size();
        this.container.set_size(width, height);
        this.waveform.actor.visible = showWaveform;
        this.waveform.setColor(parseHexColor(accent) as Rgb);

        let mode: WaveformMode;
        if (label !== undefined) {
            this.setText(label);
            this.setDot(isRecording(this.state) ? RECORDING_DOT_COLOR : accent);
            mode = isRecording(this.state) ? 'live' : 'busy';
        } else {
            this.setText('Drag to move');
            this.setDot(this.style === 'minimal' ? accent : null);
            mode = 'still';
        }

        // Classic always wears the accent as its border; the others only while being positioned.
        const accentBorder = this.style === 'classic' || label === undefined;
        this.container.set_style(accentBorder ? `border-color: ${accent};` : null);

        if (showWaveform) {
            this.waveform.start(mode);
        } else {
            this.waveform.stop();
        }

        this.show();
    }

    private setText(text: string): void {
        // GNOME's own on-screen popups use short titles without an ellipsis.
        this.label?.set_text(this.style === 'osd' ? text.replace('…', '') : text);
    }

    // The red dot means the microphone is live; null hides it.
    private setDot(color: string | null): void {
        if (this.dot === null) {
            return;
        }
        this.dot.opacity = color === null ? 0 : 255;
        this.dot.set_style(color === null ? null : `background-color: ${color};`);
    }

    private size(): [number, number] {
        if (this.style === 'minimal' && !this.settings.get_boolean('show-waveform')) {
            return MINIMAL_DOT_ONLY_SIZE;
        }
        return STYLE_SIZES[this.style];
    }

    private endPositioning(): void {
        this.clearPositioningTimeout();
        if (!this.positioning) {
            return;
        }
        this.positioning = false;
        this.render();
    }

    private clearPositioningTimeout(): void {
        if (this.positioningTimeoutId !== 0) {
            GLib.source_remove(this.positioningTimeoutId);
            this.positioningTimeoutId = 0;
        }
    }

    private connectDragHandlers(): void {
        this.container.connect('button-press-event', (_actor, event: Clutter.Event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || this.drag !== null) {
                return Clutter.EVENT_PROPAGATE;
            }

            const [pointerX, pointerY] = event.get_coords();
            const [actorX, actorY] = this.container.get_position();
            this.drag = {
                grab: Shell.Global.get().stage.grab(this.container),
                offsetX: pointerX - actorX,
                offsetY: pointerY - actorY,
            };
            return Clutter.EVENT_STOP;
        });

        this.container.connect('motion-event', (_actor, event: Clutter.Event) => {
            if (this.drag === null) {
                return Clutter.EVENT_PROPAGATE;
            }

            const [pointerX, pointerY] = event.get_coords();
            const [x, y] = this.clampToMonitor(pointerX - this.drag.offsetX, pointerY - this.drag.offsetY);
            this.container.set_position(x, y);
            return Clutter.EVENT_STOP;
        });

        this.container.connect('button-release-event', (_actor, event: Clutter.Event) => {
            if (this.drag === null || event.get_button() !== Clutter.BUTTON_PRIMARY) {
                return Clutter.EVENT_PROPAGATE;
            }

            this.endDrag(true);
            return Clutter.EVENT_STOP;
        });
    }

    private endDrag(save: boolean): void {
        if (this.drag === null) {
            return;
        }

        this.drag.grab.dismiss();
        this.drag = null;

        if (save) {
            this.savePosition();
        }

        if (this.positioning) {
            this.clearPositioningTimeout();
            this.positioningTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITIONING_LINGER_MS, () => {
                this.positioningTimeoutId = 0;
                this.endPositioning();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private savePosition(): void {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor === null) {
            return;
        }

        const [x, y] = this.container.get_position();
        const [width, height] = this.size();
        const freeWidth = Math.max(1, monitor.width - width);
        const freeHeight = Math.max(1, monitor.height - height);
        this.settings.set_double('pill-x', clampFraction((x - monitor.x) / freeWidth));
        this.settings.set_double('pill-y', clampFraction((y - monitor.y) / freeHeight));
    }

    private clampToMonitor(x: number, y: number): [number, number] {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor === null) {
            return [x, y];
        }

        const [width, height] = this.size();
        return [
            Math.round(Math.min(Math.max(x, monitor.x), monitor.x + monitor.width - width)),
            Math.round(Math.min(Math.max(y, monitor.y), monitor.y + monitor.height - height)),
        ];
    }

    private show(): void {
        this.wantVisible = true;
        this.reposition();
        this.container.remove_all_transitions();
        this.container.show();
        this.container.ease({
            opacity: 255,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    private hide(): void {
        this.wantVisible = false;
        this.endDrag(true);
        if (!this.container.visible) {
            return;
        }

        this.container.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (!this.wantVisible) {
                    this.container.hide();
                }
            },
        });
    }

    private reposition(): void {
        if (this.drag !== null) {
            return;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor === null) {
            return;
        }

        const [width, height] = this.size();
        const fractionX = this.settings.get_double('pill-x');
        const fractionY = this.settings.get_double('pill-y');
        this.container.set_position(
            monitor.x + Math.round((monitor.width - width) * fractionX),
            monitor.y + Math.round((monitor.height - height) * fractionY),
        );
    }
}

function readStyle(settings: Gio.Settings): IndicatorStyle {
    const style = settings.get_string('pill-style');
    return isIndicatorStyle(style) ? style : 'classic';
}

function clampFraction(value: number): number {
    return Math.min(Math.max(value, 0), 1);
}
