# Voxtype OSD

GNOME Shell 50/51 extension for the [voxtype](https://github.com/peteonrails/voxtype) speech-to-text
daemon: a panel indicator for its state, an on-screen pill with a live waveform while it records, a
panel menu to control the voxtype service, and a settings window.

## Features

- **Panel icon:** red while dictating, yellow while transcribing, a dimmed crossed-out microphone while
  the voxtype service is stopped.
  - Left click starts and stops dictation (can be turned off in settings).
  - Right click opens a menu: current status, start/stop dictation, a switch for the voxtype service,
    "Move recording indicator" and Settings.
- **Recording indicator:** an on-screen pill with a live waveform. Drag it to move it; the position is
  remembered. "Move recording indicator" shows it for 20 seconds so it can be moved without recording.
- **Settings window** (`gnome-extensions prefs voxtype-osd@theoodawara`):
  - **General:** run voxtype now / at login, the dictation shortcut, left-click behaviour, and what the
    indicators show.
  - **Voxtype:** a curated set of voxtype's own options (live typing, delivery mode, input device,
    max recording length, media pausing, sound cues, notifications, on-demand model loading). Labels,
    descriptions, types and ranges come from `voxtype config schema --json`; changes are written with
    `voxtype config set`, and a banner offers to restart voxtype when a change needs it.

## How it works

- **State:** watches `$XDG_RUNTIME_DIR/voxtype/state` with a `Gio.FileMonitor` and maps it to
  `idle`, `recording` (also reported as `streaming` during live dictation), `transcribing` or
  `unavailable`. voxtype deletes the file when the daemon stops, which is how "stopped" is detected.
- **Waveform:** while recording, launches `voxtype-audio-bridge` as a subprocess and reads one JSON line
  per sample (`{"peak": 0.42}`) from its stdout, drawing the last 300 peaks. Malformed lines are dropped.
- **Service control:** `systemctl --user start|stop|enable|disable voxtype.service`.
- **Shortcut:** stored as a regular GNOME custom keyboard shortcut whose command is
  `voxtype record toggle`, so it keeps working even if the extension is disabled. The settings window
  edits that shortcut, or creates it if it is missing.
- The subprocess and the file monitor are cancelled on `disable()`, so nothing outlives the extension.

## Requirements

- GNOME Shell 50 or 51
- voxtype running as a systemd user service (`voxtype.service`)
- `voxtype-audio-bridge` on `PATH` (shipped with voxtype)

## Install

```sh
npm ci
npm run install-extension
gnome-extensions enable voxtype-osd@theoodawara
```

Log out and back in on Wayland for GNOME Shell to load it.

To build a zip for `gnome-extensions install`:

```sh
npm run pack    # writes dist/voxtype-osd@theoodawara.shell-extension.zip
```

## Development

```sh
npm run build
npm test
```

Written in TypeScript against the `@girs/gnome-shell` type definitions; the level parsing is covered by
`node:test`.
