import Gvc from 'gi://Gvc';
import { getMixerControl } from 'resource:///org/gnome/shell/ui/status/volume.js';

// Follows the system's default input, which is the mic voxtype records from when its device is "default".
// Reports null until the sound server is ready, and '' when there is no input at all.
export class MicrophoneWatcher {
    private readonly onChange: (name: string | null) => void;
    private control: Gvc.MixerControl | null = null;

    constructor(onChange: (name: string | null) => void) {
        this.onChange = onChange;
    }

    start(): void {
        // The shell shares one mixer connection, so this only listens and never closes it.
        this.control = getMixerControl();
        this.control.connectObject(
            'state-changed', () => this.read(),
            'default-source-changed', () => this.read(),
            'card-added', () => this.read(),
            'card-removed', () => this.read(),
            this);
        this.read();
    }

    stop(): void {
        this.control?.disconnectObject(this);
        this.control = null;
    }

    private read(): void {
        const control = this.control;
        if (control === null || control.get_state() !== Gvc.MixerControlState.READY) {
            this.onChange(null);
            return;
        }

        const stream = control.get_default_source();
        if (stream === null) {
            this.onChange('');
            return;
        }

        // The card's name ("Blue Microphones") reads better than the stream's ("Blue Microphones Analog Stereo").
        const card = control.lookup_card_id(stream.get_card_index());
        this.onChange(card?.get_name() || stream.get_description() || '');
    }
}
