import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DaemonState } from './daemonState.js';
import { AudioSample } from './levels.js';
import { Waveform } from './waveform.js';

const PILL_WIDTH = 400;
const PILL_HEIGHT = 72;
const FADE_MS = 130;
const POSITIONING_TIMEOUT_SECS = 20;
const POSITIONING_LINGER_MS = 1200;

const STATE_LABELS: Partial<Record<DaemonState, string>> = {
    recording: 'Recording…',
    transcribing: 'Transcribing…',
};

const WAVEFORM_COLORS: Partial<Record<DaemonState, [number, number, number]>> = {
    recording: [0.949, 0.349, 0.302],
    transcribing: [0.949, 0.8, 0.302],
};

type Drag = {
    grab: Clutter.Grab;
    offsetX: number;
    offsetY: number;
};

export class OsdPill {
    private readonly settings: Gio.Settings;
    private readonly container: St.BoxLayout;
    private readonly icon: St.Icon;
    private readonly label: St.Label;
    private readonly waveform = new Waveform();
    private readonly signalIds: number[] = [];
    private monitorsChangedId = 0;
    private state: DaemonState = 'unavailable';
    private positioning = false;
    private positioningTimeoutId = 0;
    private drag: Drag | null = null;
    private wantVisible = false;

    constructor(settings: Gio.Settings) {
        this.settings = settings;

        this.icon = new St.Icon({
            style_class: 'voxtype-pill-icon',
            icon_name: 'audio-input-microphone-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.label = new St.Label({
            style_class: 'voxtype-pill-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.container = new St.BoxLayout({
            style_class: 'voxtype-pill',
            reactive: true,
            visible: false,
            opacity: 0,
            width: PILL_WIDTH,
            height: PILL_HEIGHT,
        });

        this.container.add_child(this.icon);
        this.container.add_child(this.label);
        this.container.add_child(this.waveform.actor);

        this.connectDragHandlers();

        Main.layoutManager.addTopChrome(this.container);
        this.monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this.reposition());

        for (const key of ['pill-x', 'pill-y']) {
            this.signalIds.push(this.settings.connect(`changed::${key}`, () => this.reposition()));
        }
        this.signalIds.push(this.settings.connect('changed::show-pill', () => this.render()));
        this.signalIds.push(this.settings.connect('changed::show-waveform', () => this.render()));

        this.reposition();
    }

    get showsWaveform(): boolean {
        return this.settings.get_boolean('show-pill') && this.settings.get_boolean('show-waveform');
    }

    setState(state: DaemonState): void {
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

    startWaveform(): void {
        this.waveform.startAnimating();
    }

    stopWaveform(): void {
        this.waveform.stopAnimating();
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

    private render(): void {
        this.container.remove_style_class_name('voxtype-pill-recording');
        this.container.remove_style_class_name('voxtype-pill-transcribing');
        this.container.remove_style_class_name('voxtype-pill-positioning');

        const label = STATE_LABELS[this.state];
        if (label !== undefined && this.settings.get_boolean('show-pill')) {
            this.container.add_style_class_name(`voxtype-pill-${this.state}`);
            this.label.set_text(label);
            this.waveform.actor.visible = this.settings.get_boolean('show-waveform');

            const color = WAVEFORM_COLORS[this.state];
            if (color !== undefined) {
                this.waveform.setColor(color[0], color[1], color[2]);
            }

            this.show();
            return;
        }

        if (this.positioning) {
            this.container.add_style_class_name('voxtype-pill-positioning');
            this.label.set_text('Drag to move');
            this.waveform.actor.visible = false;
            this.show();
            return;
        }

        this.hide();
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
        const freeWidth = Math.max(1, monitor.width - PILL_WIDTH);
        const freeHeight = Math.max(1, monitor.height - PILL_HEIGHT);
        this.settings.set_double('pill-x', clampFraction((x - monitor.x) / freeWidth));
        this.settings.set_double('pill-y', clampFraction((y - monitor.y) / freeHeight));
    }

    private clampToMonitor(x: number, y: number): [number, number] {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor === null) {
            return [x, y];
        }

        return [
            Math.round(Math.min(Math.max(x, monitor.x), monitor.x + monitor.width - PILL_WIDTH)),
            Math.round(Math.min(Math.max(y, monitor.y), monitor.y + monitor.height - PILL_HEIGHT)),
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

        const fractionX = this.settings.get_double('pill-x');
        const fractionY = this.settings.get_double('pill-y');
        this.container.set_position(
            monitor.x + Math.round((monitor.width - PILL_WIDTH) * fractionX),
            monitor.y + Math.round((monitor.height - PILL_HEIGHT) * fractionY),
        );
    }
}

function clampFraction(value: number): number {
    return Math.min(Math.max(value, 0), 1);
}
