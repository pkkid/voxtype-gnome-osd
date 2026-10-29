// Pure helpers for voxtype's state file. No GI imports so the unit tests can load this.

// 'streaming' is recording with live dictation ([parakeet] streaming = true): text is typed while
// you speak instead of after you stop.
export type DaemonState = 'unavailable' | 'idle' | 'recording' | 'streaming' | 'transcribing';

const KNOWN_STATES: DaemonState[] = ['idle', 'recording', 'streaming', 'transcribing'];

// True while the microphone is live, with or without live dictation.
export function isRecording(state: DaemonState): boolean {
    return state === 'recording' || state === 'streaming';
}

// Maps the state file's contents to a state; anything unexpected counts as unavailable.
export function parseStateFile(contents: string): DaemonState {
    const trimmed = contents.trim();
    return KNOWN_STATES.find(state => state === trimmed) ?? 'unavailable';
}
