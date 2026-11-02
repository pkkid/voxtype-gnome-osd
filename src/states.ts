// Pure helpers for voxtype's state file. No GI imports so the unit tests can load this.

// 'streaming' is recording with live dictation (streaming = true under the engine's section): text
// is typed while you speak instead of after you stop. 'finishing' is never in the state file: after a
// stop voxtype keeps saying 'streaming' until the last words are typed, though the mic closed at once,
// so the extension works that one out from the audio levels.
export type DaemonState = 'unavailable' | 'idle' | 'recording' | 'streaming' | 'finishing' | 'transcribing';

const KNOWN_STATES: DaemonState[] = ['idle', 'recording', 'streaming', 'transcribing'];

// True while the microphone is live, with or without live dictation.
export function isRecording(state: DaemonState): boolean {
    return state === 'recording' || state === 'streaming';
}

// True while the microphone is off but text is still on its way.
export function isTranscribing(state: DaemonState): boolean {
    return state === 'transcribing' || state === 'finishing';
}

// Maps the state file's contents to a state; anything unexpected counts as unavailable.
export function parseStateFile(contents: string): DaemonState {
    const trimmed = contents.trim();
    return KNOWN_STATES.find(state => state === trimmed) ?? 'unavailable';
}
