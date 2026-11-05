import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { DaemonState, isRecording, isTranscribing } from './daemonState.js';

const STOPPED_ICON_OPACITY = 115;

const STATUS_LABELS: Record<DaemonState, string> = {
    unavailable: 'Voxtype is stopped',
    idle: 'Ready',
    recording: 'Dictating…',
    streaming: 'Dictating…',
    finishing: 'Finishing…',
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
        private declare microphone: string | null;
        declare leftClickToggles: boolean;

        _init() {
            super._init(0.5, 'Voxtype', false);
            this.handlers = null;
            this.state = 'unavailable';
            this.pendingServiceState = null;
            this.syncingServiceItem = false;
            this.showWhenStopped = true;
            this.leftClickToggles = false;
            this.accentColor = null;
            this.microphone = null;

            this.icon = new St.Icon({ style_class: 'system-status-icon' });
            this.add_child(this.icon);

            this.buildMenu();
            this.setState('unavailable');
        }

        setHandlers(handlers: IndicatorHandlers) {
            this.handlers = handlers;
        }

        // Shipped with the extension rather than taken from the icon theme.
        setIconFile(path: string) {
            this.icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
        }

        vfunc_event(event: Clutter.Event): boolean {
            const isLeftPress = event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY;
            if (isLeftPress && this.leftClickToggles && this.canToggle()) {
                this.handlers?.toggleRecording();
                return Clutter.EVENT_STOP;
            }
            // PanelMenu.Button opens its menu with a click gesture and has no vfunc_event of its own,
            // so there is nothing to chain up to (calling super here throws on every event).
            return Clutter.EVENT_PROPAGATE;
        }

        setState(state: DaemonState) {
            this.state = state;
            this.pendingServiceState = null;

            const running = state !== 'unavailable';
            this.icon.opacity = running ? 255 : STOPPED_ICON_OPACITY;
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

        // null while the sound server is not ready yet, '' when there is no input.
        setMicrophone(name: string | null) {
            this.microphone = name;
            this.syncMenu();
        }

        setShowWhenStopped(show: boolean) {
            this.showWhenStopped = show;
            this.syncVisibility();
        }

        // While finishing, a stop from here would make voxtype throw away the words still to come.
        private canToggle(): boolean {
            return this.state !== 'unavailable' && this.state !== 'finishing';
        }

        private syncAccentColor() {
            const busy = isRecording(this.state) || isTranscribing(this.state);
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
            } else if (this.state === 'idle' && this.microphone !== null) {
                this.statusItem.label.text = `Ready, ${this.microphone || 'no microphone'}`;
            } else {
                this.statusItem.label.text = STATUS_LABELS[this.state];
            }

            // setToggleState() emits 'toggled' just like a click does, which would otherwise start or
            // stop the service every time voxtype's state changes on its own.
            this.syncingServiceItem = true;
            this.serviceItem.setToggleState(this.pendingServiceState ?? running);
            this.syncingServiceItem = false;
            this.dictationItem.visible = this.canToggle();
            this.dictationItem.label.text = isRecording(this.state) ? 'Stop dictation' : 'Start dictation';
        }
    },
);
