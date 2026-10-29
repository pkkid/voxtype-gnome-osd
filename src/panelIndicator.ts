import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { DaemonState, isRecording } from './daemonState.js';

const STATE_STYLE_CLASSES = ['voxtype-indicator-recording', 'voxtype-indicator-transcribing'];
const STOPPED_ICON_OPACITY = 115;

const STATUS_LABELS: Record<DaemonState, string> = {
    unavailable: 'Voxtype is stopped',
    idle: 'Voxtype is ready',
    recording: 'Dictating…',
    streaming: 'Dictating…',
    transcribing: 'Transcribing…',
};

export type IndicatorHandlers = {
    toggleRecording: () => void;
    setServiceRunning: (running: boolean) => void;
    moveIndicator: () => void;
    openSettings: () => void;
};

export const PanelIndicator = GObject.registerClass(
    class PanelIndicator extends PanelMenu.Button {
        private declare icon: St.Icon;
        private declare handlers: IndicatorHandlers | null;
        private declare statusItem: PopupMenu.PopupMenuItem;
        private declare dictationItem: PopupMenu.PopupMenuItem;
        private declare serviceItem: PopupMenu.PopupSwitchMenuItem;
        private declare state: DaemonState;
        private declare pendingServiceState: boolean | null;
        private declare syncingServiceItem: boolean;
        private declare showWhenStopped: boolean;
        private declare accentColor: string | null;
        declare leftClickToggles: boolean;

        _init() {
            super._init(0, 'Voxtype', false);
            this.handlers = null;
            this.state = 'unavailable';
            this.pendingServiceState = null;
            this.syncingServiceItem = false;
            this.showWhenStopped = true;
            this.leftClickToggles = true;
            this.accentColor = null;

            this.icon = new St.Icon({
                style_class: 'system-status-icon voxtype-indicator',
                icon_name: 'audio-input-microphone-symbolic',
            });
            this.add_child(this.icon);

            this.buildMenu();
            this.setState('unavailable');
        }

        setHandlers(handlers: IndicatorHandlers) {
            this.handlers = handlers;
        }

        vfunc_event(event: Clutter.Event): boolean {
            const isLeftPress = event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY;
            if (isLeftPress && this.leftClickToggles && this.state !== 'unavailable') {
                this.handlers?.toggleRecording();
                return Clutter.EVENT_STOP;
            }
            return super.vfunc_event(event);
        }

        setState(state: DaemonState) {
            this.state = state;
            this.pendingServiceState = null;

            for (const styleClass of STATE_STYLE_CLASSES) {
                this.icon.remove_style_class_name(styleClass);
            }

            const running = state !== 'unavailable';
            this.icon.icon_name = running ? 'audio-input-microphone-symbolic' : 'microphone-disabled-symbolic';
            this.icon.opacity = running ? 255 : STOPPED_ICON_OPACITY;
            if (isRecording(state)) {
                this.icon.add_style_class_name('voxtype-indicator-recording');
            } else if (state === 'transcribing') {
                this.icon.add_style_class_name('voxtype-indicator-transcribing');
            }
            this.syncAccentColor();

            this.syncVisibility();
            this.syncMenu();
        }

        clearPendingServiceState() {
            this.pendingServiceState = null;
            this.syncMenu();
        }

        setAccentColor(color: string) {
            this.accentColor = color;
            this.syncAccentColor();
        }

        setShowWhenStopped(show: boolean) {
            this.showWhenStopped = show;
            this.syncVisibility();
        }

        // The stylesheet's color is only a fallback; an inline style wins over it.
        private syncAccentColor() {
            const busy = isRecording(this.state) || this.state === 'transcribing';
            this.icon.set_style(busy && this.accentColor !== null ? `color: ${this.accentColor};` : null);
        }

        private syncVisibility() {
            const visible = this.state !== 'unavailable' || this.showWhenStopped;
            this.visible = visible;
            this.container.visible = visible;
        }

        private buildMenu() {
            const menu = this.menu as PopupMenu.PopupMenu;

            this.statusItem = new PopupMenu.PopupMenuItem('', { reactive: false });
            menu.addMenuItem(this.statusItem);

            this.dictationItem = new PopupMenu.PopupMenuItem('');
            this.dictationItem.connect('activate', () => this.handlers?.toggleRecording());
            menu.addMenuItem(this.dictationItem);

            this.serviceItem = new PopupMenu.PopupSwitchMenuItem('Voxtype service', false);
            this.serviceItem.connect('toggled', (_item, running: boolean) => {
                if (this.syncingServiceItem) {
                    return;
                }
                this.pendingServiceState = running;
                this.syncMenu();
                this.handlers?.setServiceRunning(running);
            });
            menu.addMenuItem(this.serviceItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const moveItem = new PopupMenu.PopupMenuItem('Move recording indicator');
            moveItem.connect('activate', () => this.handlers?.moveIndicator());
            menu.addMenuItem(moveItem);

            const settingsItem = new PopupMenu.PopupMenuItem('Settings');
            settingsItem.connect('activate', () => this.handlers?.openSettings());
            menu.addMenuItem(settingsItem);
        }

        private syncMenu() {
            const running = this.state !== 'unavailable';

            if (this.pendingServiceState === true) {
                this.statusItem.label.text = 'Starting Voxtype…';
            } else if (this.pendingServiceState === false) {
                this.statusItem.label.text = 'Stopping Voxtype…';
            } else {
                this.statusItem.label.text = STATUS_LABELS[this.state];
            }

            // GNOME 51 emits 'toggled' for programmatic changes too, which would otherwise start or
            // stop the service every time voxtype's state changes on its own.
            this.syncingServiceItem = true;
            this.serviceItem.setToggleState(this.pendingServiceState ?? running);
            this.syncingServiceItem = false;
            this.dictationItem.visible = running;
            this.dictationItem.label.text = isRecording(this.state) ? 'Stop dictation' : 'Start dictation';
        }
    },
);
