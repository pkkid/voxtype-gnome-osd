import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { AudioBridge } from './audioBridge.js';
import { DaemonState, DaemonStateWatcher } from './daemonState.js';
import { OsdPill } from './osdPill.js';
import { PanelIndicator } from './panelIndicator.js';
import { CommandResult, setServiceRunning, toggleRecording } from './voxtype.js';

const PANEL_POSITION = 0;
// Loading the model can take a few seconds; give up on "Starting…" after this.
const SERVICE_CHANGE_TIMEOUT_SECS = 30;

export default class VoxtypeOsdExtension extends Extension {
    private settings: Gio.Settings | null = null;
    private settingsIds: number[] = [];
    private watcher: DaemonStateWatcher | null = null;
    private indicator: InstanceType<typeof PanelIndicator> | null = null;
    private pill: OsdPill | null = null;
    private bridge: AudioBridge | null = null;
    private state: DaemonState = 'unavailable';
    private serviceTimeoutId = 0;

    enable() {
        this.settings = this.getSettings();
        this.pill = new OsdPill(this.settings);

        this.indicator = new PanelIndicator();
        this.indicator.setHandlers({
            toggleRecording: () => this.report(toggleRecording(), 'could not toggle recording'),
            setServiceRunning: running => this.changeService(running),
            moveIndicator: () => this.pill?.startPositioning(),
            openSettings: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this.indicator, PANEL_POSITION, 'right');

        this.bridge = new AudioBridge(sample => this.pill?.pushSample(sample));

        this.settingsIds = [
            this.settings.connect('changed::left-click-toggles', () => this.applySettings()),
            this.settings.connect('changed::show-when-stopped', () => this.applySettings()),
            this.settings.connect('changed::show-pill', () => this.applyState(this.state)),
            this.settings.connect('changed::show-waveform', () => this.applyState(this.state)),
        ];
        this.applySettings();

        this.watcher = new DaemonStateWatcher(state => this.applyState(state));
        this.watcher.start();
    }

    disable() {
        this.clearServiceTimeout();

        for (const id of this.settingsIds) {
            this.settings?.disconnect(id);
        }
        this.settingsIds = [];

        this.watcher?.stop();
        this.watcher = null;

        this.bridge?.stop();
        this.bridge = null;

        this.pill?.destroy();
        this.pill = null;

        this.indicator?.destroy();
        this.indicator = null;

        this.settings = null;
    }

    private applySettings() {
        if (this.settings === null || this.indicator === null) {
            return;
        }

        this.indicator.leftClickToggles = this.settings.get_boolean('left-click-toggles');
        this.indicator.setShowWhenStopped(this.settings.get_boolean('show-when-stopped'));
    }

    private applyState(state: DaemonState) {
        if (state !== this.state) {
            this.clearServiceTimeout();
        }
        this.state = state;
        this.indicator?.setState(state);
        this.pill?.setState(state);

        if (state === 'recording' && this.pill?.showsWaveform) {
            this.pill.startWaveform();
            this.bridge?.start();
            return;
        }

        this.bridge?.stop();
        this.pill?.stopWaveform();
    }

    private changeService(running: boolean) {
        this.clearServiceTimeout();
        this.serviceTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SERVICE_CHANGE_TIMEOUT_SECS, () => {
            this.serviceTimeoutId = 0;
            this.indicator?.clearPendingServiceState();
            return GLib.SOURCE_REMOVE;
        });

        setServiceRunning(running).then(result => {
            if (!result.ok) {
                this.clearServiceTimeout();
                this.indicator?.clearPendingServiceState();
                Main.notifyError('Voxtype', `Could not ${running ? 'start' : 'stop'} the voxtype service: ${result.stderr.trim()}`);
            }
        });
    }

    private clearServiceTimeout() {
        if (this.serviceTimeoutId !== 0) {
            GLib.source_remove(this.serviceTimeoutId);
            this.serviceTimeoutId = 0;
        }
    }

    private report(command: Promise<CommandResult>, what: string) {
        command.then(result => {
            if (!result.ok) {
                log(`voxtype-osd: ${what}: ${result.stderr.trim()}`);
            }
        });
    }
}
