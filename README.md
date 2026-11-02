# Voxtype OSD

GNOME Shell 50/51 extension for the [voxtype](https://github.com/peteonrails/voxtype) speech-to-text
daemon: a panel indicator for its state, an on-screen pill with a live waveform while it records, a
panel menu to control the voxtype service, and a settings window.

## Features

**Recording indicator:** an on-screen pill that follows your voice while you dictate, in one of four
styles. A red dot on the microphone means it is live. It reads "Recording…" while recording and
"Transcribing…" while voxtype transcribes. With live dictation (`streaming` under the engine's section)
it reads "Listening…" while the mic is on, then "Finishing…" until the last words are typed. Drag it to
move it; the position is remembered.

| Classic | Minimal |
| :-: | :-: |
| ![Classic style](docs/images/style-classic.png) | ![Minimal style](docs/images/style-minimal.png) |
| **Wave** | **GNOME OSD** |
| ![Wave style](docs/images/style-wave.png) | ![GNOME OSD style](docs/images/style-osd.png) |

<img src="docs/images/panel-menu.png" align="right" width="250" alt="Panel menu">

**Panel icon:** the accent color while dictating or transcribing, and dimmed
while the voxtype service is stopped. Left click can start and stop dictation (off by default). Right
click opens a menu with the current status, start/stop dictation, a switch for the voxtype service,
"Move recording indicator" (shows the indicator for 20 seconds so it can be dragged) and Settings.

<br clear="right">

**Settings window** (`gnome-extensions prefs voxtype-osd@theoodawara`):

- **General:** run voxtype now / at login, the dictation shortcut and whether it is held or tapped, and
  how the panel icon behaves. The shortcut is saved to voxtype's own `[hotkey]` config and voxtype is
  restarted to apply it: a GNOME shortcut never sees the key being released, so it cannot do
  push-to-talk, and while held it repeats and turns dictation on and off.
- **Indicator:** show or hide the indicator and voxtype's own display (`osd.enabled`), the indicator's
  style, the waveform, the accent color and its position.
- **Dictation:** live transcription, delivery mode, and microphone options from voxtype's own config.
- **Models:** pick a dictation model and the extension sets up what it needs. Compare, download and
  remove models, and see which can use the GPU or do live transcription. Below that, choose whether to
  use the GPU, see whether the model is in system or GPU memory and how much of each is in use, and
  turn on on-demand model loading.
- **Cleanup:** optional text cleanup through a command of your choice, for dictation and for Cleanup
  Anything. One click sets it to the bundled wrapper for Claude Code.
- **Notifications:** which of voxtype's notifications to show.
- **System:** the models folder, the total space used and the config file.

Voxtype's options come from `voxtype config schema --json`, including their labels and ranges. Changes
are written with `voxtype config set`, and a banner offers to restart voxtype when a change needs it.

<p align="center">
  <img src="docs/images/settings-indicator.png" width="620" alt="Indicator settings">
</p>

**Cleanup Anything:** not a voxtype feature, but it shares its cleanup command. Off by default. Double
tap Left Ctrl, or press a shortcut of your choice, to clean up the text field you are in: it selects and
copies the whole field, runs the command, pastes the result over it and puts your clipboard back. The
whole field goes to whatever service the command uses. Press the trigger again to cancel. Your text is
left alone if the command fails, if the field changed or you moved to another window in the meantime, or
if it is over the length limit. Terminals are skipped, because Ctrl+C would interrupt what is running in
them, but a terminal inside another app, like VS Code's, cannot be told apart from the app. Only one
clipboard format can be put back, so rich text comes back as plain text. Ctrl+Z undoes the change in most
apps.

## How it works

- **State:** watches `$XDG_RUNTIME_DIR/voxtype/state` with a `Gio.FileMonitor` and maps it to
  `idle`, `recording`, `streaming` (recording with live dictation), `transcribing` or
  `unavailable`. voxtype deletes the file when the daemon stops, which is how "stopped" is detected.
- **Mic closing in live dictation:** after a stop voxtype closes the mic at once but keeps saying
  `streaming` until the text is typed. It does switch `voxtype-audio-bridge` from 100 samples a second to
  about 30 of exact silence, so that is what turns the indicator to "Finishing…". The bridge runs for
  all of live dictation for this reason, even with the waveform off. Without the bridge the indicator
  stays on "Listening…" until voxtype goes idle.
- **Waveform:** while recording, launches `voxtype-audio-bridge` as a subprocess and reads one JSON line
  per sample (`{"peak": 0.42}`) from its stdout. Classic keeps the loudest peak of each 100 ms as one
  bar; the other styles follow the latest peaks and a smoothed level. Malformed lines are dropped.
- **Cleanup Anything:** the double tap is the signal behind GNOME's Locate Pointer, which fires for each
  lone tap of `locate-pointer-key` (Left Ctrl unless changed) whether that feature is on or not, and
  never for a shortcut like Ctrl+C, so the extension never sees your keystrokes. Keys are sent through a
  GNOME virtual keyboard, so it needs neither ydotool nor the input group.
- **Claude Code wrapper:** `bin/voxtype-cleanup.py` runs your installed, signed in `claude --print` with
  every tool off, using your own login, and needs only Python 3. It takes `--model` (a name or alias like
  `sonnet`), `--effort` (`low` to `max`) and `--prompt`, where `$text` marks where your text goes. They
  all live in the cleanup command, so Settings and voxtype's config always agree. A custom prompt changes
  the edit, not the checks, so a prompt asking for more than a light edit gets its replies rejected.
  Copied text can hold instructions aimed
  at the model, so the design assumes the model can be fooled: it has no tools, MCP servers, hooks or
  project files, the wrapper stops if a tool appears, and a reply is thrown out unless it is a light edit
  of the input. Those checks cannot judge meaning, so a small hostile edit like changing one number would
  pass. Read the result before sending it.
- **Models:** the list comes from `voxtype info models`, the notes from voxtype.io and voxtype's source,
  and sizes are measured from the models folder. Downloads run `voxtype setup --download
  --progress-format json`, through an ONNX program when a Whisper build is active, because that build
  refuses other engines' models. Switching runs `voxtype setup model --set`, which refuses a model that
  is not downloaded. voxtype has no remove command, so Remove deletes the model from the models folder.
- **Builds:** voxtype is several programs and `/usr/bin/voxtype` points at one. Whisper builds run Whisper
  models, and ONNX builds run everything else. `voxtype info variants` says what is installed and can run
  here, and the extension switches with `pkexec voxtype setup onnx` when a model needs another build, so
  the only choice left to the user is the model. Source installs have one program, so they only offer what
  it was compiled with.
- **GPU:** `pkexec voxtype setup gpu` switches between the GPU and CPU builds, and the choice is kept in
  the `use-gpu` setting for when a model that cannot use the GPU is selected. Whisper uses Vulkan. ONNX
  uses CUDA or MIGraphX, which voxtype only runs on a CPU with AVX-512, so without one the switch is
  disabled for those models. `voxtype info accel` reports where the daemon really ended up.
- **Config file:** the settings window reads voxtype's config each time it opens, so hand edits show up
  then. Without a user config voxtype falls back to `/etc/voxtype/config.toml`, which it cannot save to,
  so the window starts by copying that to `~/.config/voxtype/config.toml`.
- **Live transcription:** voxtype runs it in toggle mode even when `hotkey.mode` is `push_to_talk`, so
  the General page shows Toggle while it is on, without changing the saved setting. It needs the GPU
  to keep up: in an 18 second test with `base.en`, typing ended 22 seconds after the stop on the CPU and
  0.3 seconds after on the GPU. Raising `streaming.interval_secs` on the CPU made it worse, at 43 seconds.
- **Text cleanup:** voxtype has no cleanup model of its own, only `output.post_process.command`, a shell
  command the text is piped through, so any script or LLM service works. If Ollama has models, choosing
  one fills in an `ollama run` command.
- **Service control:** starts, stops, enables and disables `voxtype.service` through the systemd user
  manager's D-Bus API (`org.freedesktop.systemd1`), the same calls `systemctl --user` makes.
- **Shortcut:** read from and saved to voxtype's `[hotkey]` config, so it keeps working even if the
  extension is disabled. `key`, `mode` and `enabled` go through `voxtype config set`. That command does
  not allow `modifiers`, so the settings window edits that one line of the config file itself. A GNOME
  custom shortcut running `voxtype record toggle` left by an older version is offered for removal.
- The subprocess and the file monitor are cancelled on `disable()`, so nothing outlives the extension.

## Requirements

- GNOME Shell 50 or 51
- voxtype running as a systemd user service (`voxtype.service`)
- membership of the `input` group, which voxtype's hotkey needs to read the keyboard
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
npm test            # type check and unit tests, about a second
npm run test:shell  # the extension in a real, headless GNOME Shell, about 30 seconds
```

`npm test` covers the pure logic: parsing voxtype's state file and audio levels, the bars and
waveforms, accent colors, the settings dropdowns, the settings schema, and that the shell and
Settings processes never import each other's libraries. It runs on every push.

`npm run test:shell` needs `gnome-shell` installed. It starts a headless GNOME Shell with its own D-Bus
session, settings and runtime directory, so your desktop is not touched. `voxtype` and
`voxtype-audio-bridge` are swapped for scripts that record every call, and a helper extension stands in
for the systemd user manager. It checks a full dictation, live dictation, every style, live settings
changes, the panel menu, that voxtype is never started or stopped on its own, a misbehaving audio
bridge, a failing service change, rapid state changes, voxtype starting after the extension, and that
disabling (even mid-drag or mid-recording) releases the pointer grab, removes every timer, stops the
audio bridge and leaves nothing reacting to later events. Each Settings page must open without errors.
Set `VOXTYPE_OSD_SCREENSHOTS=<dir>` to also save screenshots.
