// Runs the built extension inside a real, headless GNOME Shell and checks what it does.
//
// Everything is isolated in a temporary directory: its own D-Bus session, dconf database, runtime
// directory and extensions folder, so the desktop you are logged into is never touched. voxtype and
// voxtype-audio-bridge are replaced by the scripts in test/shell/bin, which record every call in
// calls.log. A helper extension (test/shell/helper) reports what is on screen and stands in for the
// systemd user manager on the test D-Bus, recording service changes in calls.log too.
//
// Run with `npm run test:shell`. Set VOXTYPE_OSD_SCREENSHOTS=<dir> to also save screenshots.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const UUID = 'voxtype-osd@theoodawara';
const HELPER_UUID = 'test-helper@voxtype-osd';
const SCHEMA_ID = 'org.gnome.shell.extensions.voxtype-osd';
const ACTIVE = 1;
const ERROR = 3;
const ACTION_MODE_NORMAL = 1;
const INACTIVE = 2;
const DEFAULT_ACCENT = '#c0bfbc';
const RECORDING_DOT = '#ed333b';
const MONITOR = [1600, 1000];
const STYLE_SIZES = { classic: [400, 72], minimal: [96, 30], wave: [400, 72], osd: [250, 62] };
const SCREENSHOTS = process.env.VOXTYPE_OSD_SCREENSHOTS ?? null;

const hasGnomeShell = (() => {
    try {
        execFileSync('gnome-shell', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

describe('Voxtype OSD in a headless GNOME Shell', { skip: !hasGnomeShell && 'gnome-shell is not installed' }, () => {
    let dir;
    let env;
    let shell;
    let logOffset = 0;

    const path = (...parts) => join(dir, ...parts);
    const extensionDir = () => path('data', 'gnome-shell', 'extensions', UUID);

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), 'voxtype-osd-shell-'));
        for (const sub of ['config', 'cache', 'data/gnome-shell/extensions', 'runtime/voxtype']) {
            mkdirSync(path(sub), { recursive: true });
        }
        chmodSync(path('runtime'), 0o700);

        // The built extension, installed the way scripts/install.sh does it.
        cpSync(join(ROOT, 'build'), extensionDir(), { recursive: true });
        for (const file of ['metadata.json', 'stylesheet.css']) {
            cpSync(join(ROOT, file), join(extensionDir(), file));
        }
        cpSync(join(ROOT, 'schemas'), join(extensionDir(), 'schemas'), { recursive: true });
        cpSync(join(ROOT, 'icons'), join(extensionDir(), 'icons'), { recursive: true });
        execFileSync('glib-compile-schemas', [join(extensionDir(), 'schemas')]);
        cpSync(join(ROOT, 'test', 'shell', 'helper'), path('data', 'gnome-shell', 'extensions', HELPER_UUID), { recursive: true });

        writeState('idle');
        touch('service-active');

        env = {
            HOME: process.env.HOME,
            USER: process.env.USER,
            PATH: `${join(ROOT, 'test', 'shell', 'bin')}:/usr/bin:/bin`,
            XDG_CONFIG_HOME: path('config'),
            XDG_DATA_HOME: path('data'),
            XDG_CACHE_HOME: path('cache'),
            XDG_RUNTIME_DIR: path('runtime'),
            XDG_DATA_DIRS: '/usr/local/share:/usr/share',
            VOXTYPE_OSD_TEST_DIR: dir,
        };

        const wallpaper = '/usr/share/backgrounds/gnome/adwaita-d.jxl';
        writeFileSync(path('session.sh'), `#!/usr/bin/env bash
gsettings set org.gnome.shell enabled-extensions "['${UUID}', '${HELPER_UUID}']"
gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
${existsSync(wallpaper) ? `gsettings set org.gnome.desktop.background picture-uri-dark 'file://${wallpaper}'` : ''}
echo "$DBUS_SESSION_BUS_ADDRESS" > "${path('bus-address')}"
exec gnome-shell --headless --virtual-monitor ${MONITOR.join('x')}
`, { mode: 0o755 });

        const log = openSync(path('shell.log'), 'a');
        shell = spawn('dbus-run-session', ['--', path('session.sh')], { env, detached: true, stdio: ['ignore', log, log] });

        await waitUntil(() => existsSync(path('bus-address')), 'the test D-Bus session', 15000);
        env.DBUS_SESSION_BUS_ADDRESS = readFileSync(path('bus-address'), 'utf8').trim();
        await waitFor(state => state.extensionState === ACTIVE && state.indicator !== null, 'the extension to start', 30000);
    });

    after(async () => {
        if (shell?.pid && shell.exitCode === null) {
            const exited = new Promise(resolve => shell.once('exit', resolve));
            try {
                process.kill(-shell.pid, 'SIGTERM');
            } catch {
                // Already gone.
            }
            await Promise.race([exited, sleep(5000)]);
        }
        // Services the session started (ibus, dconf, the portals) exit once its bus is gone, and may
        // still write to the test directory on their way out.
        await waitUntil(() => sessionProcesses().length === 0, 'the test session to exit', 10000).catch(() => {});
        if (dir && !process.env.VOXTYPE_OSD_KEEP_TEST_DIR) {
            // The session's document portal and gvfs mount FUSE filesystems in the runtime directory
            // and may still be unmounting.
            for (let attempt = 0; ; attempt += 1) {
                try {
                    rmSync(dir, { recursive: true, force: true });
                    break;
                } catch (error) {
                    if (attempt === 10) {
                        throw error;
                    }
                    for (const mount of ['doc', 'gvfs']) {
                        try {
                            execFileSync('fusermount3', ['-u', path('runtime', mount)], { stdio: 'ignore' });
                        } catch {
                            // Not mounted.
                        }
                    }
                    await sleep(300);
                }
            }
        }
    });

    // ───────────────────────── Helpers ─────────────────────────

    // Processes still running inside the test session, found by their runtime directory.
    function sessionProcesses() {
        return readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => {
            try {
                return readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`XDG_RUNTIME_DIR=${path('runtime')}\0`);
            } catch {
                return false;
            }
        });
    }

    function touch(name) {
        writeFileSync(path(name), '');
    }

    function writeState(state, { atomic = false } = {}) {
        const file = path('runtime', 'voxtype', 'state');
        if (state === null) {
            rmSync(file, { force: true });
        } else if (atomic) {
            // Write a temporary file and rename it over the state file, as many programs do.
            writeFileSync(`${file}.tmp`, `${state}\n`);
            renameSync(`${file}.tmp`, file);
        } else {
            writeFileSync(file, `${state}\n`);
        }
    }

    function helper(method, ...args) {
        execFileSync('gdbus', ['call', '--session', '--dest', 'org.voxtypeosd.TestHelper', '--object-path', '/org/voxtypeosd/TestHelper',
            '--method', `org.voxtypeosd.TestHelper.${method}`, ...args.map(String)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    }

    function inspect() {
        helper('Inspect', path('inspect.json'));
        return JSON.parse(readFileSync(path('inspect.json'), 'utf8'));
    }

    function setSetting(key, value) {
        execFileSync('gsettings', ['--schemadir', join(extensionDir(), 'schemas'), 'set', SCHEMA_ID, key, String(value)], { env });
    }

    function resetSetting(key) {
        execFileSync('gsettings', ['--schemadir', join(extensionDir(), 'schemas'), 'reset', SCHEMA_ID, key], { env });
    }

    // For helper methods that answer true or false.
    function helperAnswers(method, ...args) {
        const output = execFileSync('gdbus', ['call', '--session', '--dest', 'org.voxtypeosd.TestHelper', '--object-path', '/org/voxtypeosd/TestHelper',
            '--method', `org.voxtypeosd.TestHelper.${method}`, ...args.map(String)], { env, encoding: 'utf8' });
        return output.includes('true');
    }

    const pressPanelIcon = button => helperAnswers('PressPanelIcon', button);
    const sourceAlive = id => helperAnswers('SourceAlive', id);

    async function setEnabled(enabled) {
        helper('SetExtensionEnabled', enabled);
        await waitFor(s => s.extensionState === (enabled ? ACTIVE : INACTIVE), enabled ? 'the extension to enable' : 'the extension to disable');
    }

    function calls() {
        return existsSync(path('calls.log')) ? readFileSync(path('calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
    }

    function clearCalls() {
        rmSync(path('calls.log'), { force: true });
    }

    function bridgeRunning() {
        try {
            execFileSync('pgrep', ['-f', join(ROOT, 'test', 'shell', 'bin', 'voxtype-audio-bridge')], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    async function waitUntil(check, what, timeout = 5000) {
        const deadline = Date.now() + timeout;
        for (;;) {
            try {
                if (check()) {
                    return;
                }
            } catch {
                // Not ready yet; the shell or the helper may still be starting.
            }
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for ${what}`);
            }
            await sleep(100);
        }
    }

    async function waitFor(predicate, what, timeout = 5000) {
        let last = null;
        try {
            await waitUntil(() => predicate(last = inspect()), what, timeout);
        } catch (error) {
            error.message += `\nLast state: ${JSON.stringify(last, null, 2)}`;
            throw error;
        }
        return last;
    }

    const shown = state => state.pill !== null && state.pill.visible && state.pill.opacity === 255;
    const hidden = state => state.pill === null || !state.pill.visible;

    // Errors that mention the extension, from the shell or from the Settings window, since the last check.
    function newErrors() {
        const log = readFileSync(path('shell.log'), 'utf8');
        const fresh = log.slice(logOffset);
        logOffset = log.length;
        return fresh.split('\n').filter(line => !line.startsWith('dbus-daemon[') && (
            line.includes(UUID) || /JS ERROR.*voxtype|Voxtype: Could not|voxtype-osd:.*(error|failed)/i.test(line)));
    }

    function assertNoErrors() {
        assert.deepEqual(newErrors(), [], 'the logs show errors from the extension');
    }

    function screenshot(name, area) {
        mkdirSync(SCREENSHOTS, { recursive: true });
        helper('Screenshot', join(SCREENSHOTS, `${name}.png`), ...area);
    }

    // ───────────────────────── Scenarios ─────────────────────────

    test('loads without errors and shows the panel icon', () => {
        const state = inspect();

        assert.equal(state.extensionState, ACTIVE);
        assert.equal(state.indicator.visible, true);
        assert.equal(state.indicator.iconFile, 'voxtype-panel-symbolic.svg');
        assert.match(state.indicator.status, /^Ready\b/);
        assert.ok(hidden(state), 'no indicator while idle');
        assertNoErrors();
    });

    test('follows a dictation: recording, transcribing, then idle', async () => {
        writeState('recording');
        let state = await waitFor(shown, 'the indicator to appear');
        assert.equal(state.pill.label, 'Recording…');
        assert.match(state.pill.dot.style, new RegExp(RECORDING_DOT));
        assert.equal(state.pill.dot.opacity, 255);
        assert.match(state.indicator.iconStyle, new RegExp(DEFAULT_ACCENT));
        assert.equal(state.indicator.dictation, 'Stop dictation');
        await waitUntil(bridgeRunning, 'the audio bridge to start');

        writeState('transcribing');
        state = await waitFor(s => s.pill?.label === 'Transcribing…', 'the transcribing label');
        assert.match(state.pill.dot.style, new RegExp(DEFAULT_ACCENT), 'the dot is the accent color once the mic is off');
        await waitUntil(() => !bridgeRunning(), 'the audio bridge to stop');

        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();
    });

    test('labels live dictation (streaming) as listening, with the mic live', async () => {
        writeState('streaming', { atomic: true });
        const state = await waitFor(s => shown(s) && s.pill.label === 'Listening…', 'the streaming indicator');
        assert.match(state.pill.dot.style, new RegExp(RECORDING_DOT));
        await waitUntil(bridgeRunning, 'the audio bridge to start');

        writeState('idle', { atomic: true });
        await waitFor(hidden, 'the indicator to hide');
        await waitUntil(() => !bridgeRunning(), 'the audio bridge to stop');
        assertNoErrors();
    });

    test('shows finishing once the mic closes, while voxtype still says streaming', async () => {
        writeFileSync(path('bridge-mode'), 'closed');
        writeState('streaming', { atomic: true });
        let state = await waitFor(s => s.pill?.label === 'Finishing…', 'the finishing label');
        assert.doesNotMatch(state.pill.dot.style, new RegExp(RECORDING_DOT));
        assert.equal(state.indicator.dictation, null);
        await waitUntil(() => !bridgeRunning(), 'the audio bridge to stop');

        writeState('idle', { atomic: true });
        await waitFor(hidden, 'the indicator to hide');

        rmSync(path('bridge-mode'));
        writeState('streaming', { atomic: true });
        state = await waitFor(s => s.pill?.label === 'Listening…', 'the next session to start listening');
        assert.match(state.pill.dot.style, new RegExp(RECORDING_DOT));

        writeState('idle', { atomic: true });
        await waitFor(hidden, 'the indicator to hide again');
        assertNoErrors();
    });

    test('a muted mic in live dictation still counts as listening', async () => {
        writeFileSync(path('bridge-mode'), 'muted');
        writeState('streaming', { atomic: true });
        await waitFor(s => s.pill?.label === 'Listening…', 'the streaming indicator');
        await waitUntil(bridgeRunning, 'the audio bridge to start');
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(inspect().pill.label, 'Listening…');

        rmSync(path('bridge-mode'));
        writeState('idle', { atomic: true });
        await waitFor(hidden, 'the indicator to hide');
        await waitUntil(() => !bridgeRunning(), 'the audio bridge to stop');
        assertNoErrors();
    });

    test('live dictation notices the mic closing with the indicator turned off', async () => {
        setSetting('show-pill', false);
        writeFileSync(path('bridge-mode'), 'closed');
        writeState('streaming', { atomic: true });
        await waitFor(s => s.indicator.status === 'Finishing…', 'the panel menu to say finishing');

        rmSync(path('bridge-mode'));
        writeState('idle', { atomic: true });
        await waitFor(s => /^Ready\b/.test(s.indicator.status), 'the panel menu to go back');
        resetSetting('show-pill');
        assertNoErrors();
    });

    test('draws each style at its size, including switching while recording', async () => {
        writeState('recording');
        for (const [style, [width, height]] of Object.entries(STYLE_SIZES)) {
            setSetting('pill-style', style);
            const state = await waitFor(s => shown(s) && s.pill.styleClass.includes(`voxtype-pill-${style}`), `the ${style} style`);
            assert.deepEqual([state.pill.width, state.pill.height], [width, height], style);
            assert.equal(state.pill.label, style === 'minimal' ? null : style === 'osd' ? 'Recording' : 'Recording…', style);
            assert.equal(state.pill.waveformVisible, true, style);

            if (SCREENSHOTS !== null) {
                // Let the waveform fill up with a few seconds of voice first.
                await sleep(1500);
                const [x, y] = [(MONITOR[0] - 480) / 2, Math.round((MONITOR[1] - height) * 0.84 + height / 2 - 60)];
                screenshot(`style-${style}`, [x, y, 480, 120]);
            }
        }

        resetSetting('pill-style');
        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();
    });

    test('applies settings while showing: accent color, waveform, show indicator', async () => {
        writeState('recording');
        await waitFor(shown, 'the indicator to appear');

        setSetting('accent-color', '#3584e4');
        let state = await waitFor(s => s.pill.style?.includes('#3584e4'), 'the accent border');
        assert.match(state.indicator.iconStyle, /#3584e4/);
        assert.match(state.pill.dot.style, new RegExp(RECORDING_DOT), 'the recording dot stays red');

        setSetting('accent-color', 'not-a-color');
        await waitFor(s => s.pill.style?.includes(DEFAULT_ACCENT), 'a malformed color to fall back to the default');
        resetSetting('accent-color');

        setSetting('show-waveform', false);
        state = await waitFor(s => s.pill.waveformVisible === false, 'the waveform to hide');
        await waitUntil(() => !bridgeRunning(), 'the audio bridge to stop without a waveform');
        setSetting('pill-style', 'minimal');
        state = await waitFor(s => s.pill.width === 30 && s.pill.height === 30, 'Minimal to shrink to its dot');
        resetSetting('pill-style');
        resetSetting('show-waveform');
        await waitUntil(bridgeRunning, 'the audio bridge to restart');

        setSetting('show-pill', false);
        await waitFor(hidden, 'the indicator to hide when turned off');
        await waitUntil(() => !bridgeRunning(), 'the audio bridge to stop with the indicator off');
        resetSetting('show-pill');
        await waitFor(shown, 'the indicator to come back');

        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();
    });

    test('never starts or stops voxtype on its own when its state changes', async () => {
        clearCalls();
        // A voxtype restart: the state file disappears, then comes back.
        writeState(null);
        await waitFor(s => s.indicator.status === 'Voxtype is stopped', 'the stopped state');
        writeState('idle');
        await waitFor(s => /^Ready\b/.test(s.indicator.status), 'the ready state');
        writeState('recording');
        await waitFor(shown, 'the indicator to appear');
        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');

        assert.deepEqual(calls().filter(call => /^(systemd|systemctl) /.test(call)), []);
        assertNoErrors();
    });

    test('the panel menu controls voxtype: service switch, dictation, moving the indicator', async () => {
        clearCalls();
        helper('ToggleServiceSwitch');
        await waitUntil(() => calls().includes('systemd StopUnit voxtype.service'), 'the stop command');
        let state = inspect();
        assert.equal(state.indicator.status, 'Stopping Voxtype…');

        // voxtype goes away, which must not echo another command.
        writeState(null);
        await waitFor(s => s.indicator.status === 'Voxtype is stopped', 'the stopped state');
        helper('ToggleServiceSwitch');
        await waitUntil(() => calls().includes('systemd StartUnit voxtype.service'), 'the start command');
        writeState('idle');
        await waitFor(s => /^Ready\b/.test(s.indicator.status), 'the ready state');
        assert.deepEqual(calls(), ['systemd StopUnit voxtype.service', 'systemd StartUnit voxtype.service']);

        clearCalls();
        helper('ActivateMenuItem', 'Start dictation');
        await waitUntil(() => calls().includes('voxtype record toggle'), 'the toggle command');

        helper('ActivateMenuItem', 'Move recording indicator');
        state = await waitFor(s => shown(s) && s.pill.label === 'Drag to move', 'the positioning hint');
        assert.equal(state.pill.dot.opacity, 0, 'no recording dot while positioning');
        writeState('recording');
        await waitFor(s => s.pill?.label === 'Recording…', 'recording to take over from positioning');
        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();
    });

    test('the panel menu opens centered on its icon', async () => {
        helper('OpenMenuMidPanel');
        await waitFor(s => s.indicator.menuOpen && s.indicator.menuWidth > 0, 'the menu to open');
        await sleep(100);
        const { indicator: placed } = inspect();
        if (SCREENSHOTS !== null) {
            await sleep(500);
            screenshot('panel-menu', [Math.round(placed.menuCenterX - 125), 0, 250, 280]);
        }
        helper('CloseMenu');

        assert.ok(Math.abs(placed.menuCenterX - placed.iconCenterX) <= 1, `menu at ${placed.menuCenterX}, icon at ${placed.iconCenterX}`);
    });

    test('left-clicking the panel icon opens the menu by default, and dictates when turned on', async () => {
        assert.equal(pressPanelIcon(1), false, 'a left press goes on to the menu by default');

        setSetting('left-click-toggles', true);
        await sleep(200);
        clearCalls();
        assert.equal(pressPanelIcon(1), true, 'a left press is handled by the extension');
        await waitUntil(() => calls().includes('voxtype record toggle'), 'the toggle command');

        clearCalls();
        assert.equal(pressPanelIcon(3), false, 'a right press goes on to the menu');

        writeState(null);
        await waitFor(s => s.indicator.status === 'Voxtype is stopped', 'the stopped state');
        assert.equal(pressPanelIcon(1), false, 'a left press opens the menu while voxtype is stopped');
        writeState('idle');
        await waitFor(s => /^Ready\b/.test(s.indicator.status), 'the ready state');
        resetSetting('left-click-toggles');

        assert.deepEqual(calls(), []);
        assertNoErrors();
    });

    test('disabling cleans up everything, even mid-recording, and enabling again works', async () => {
        writeState('recording');
        const { sources } = await waitFor(s => shown(s) && s.sources.redraw !== 0, 'the indicator to appear and animate');
        await waitUntil(bridgeRunning, 'the audio bridge to start');

        helper('SetExtensionEnabled', false);
        await waitFor(s => s.extensionState === INACTIVE && s.indicator === null && s.pill === null, 'everything to be removed');
        await waitUntil(() => !bridgeRunning(), 'the audio bridge to stop');
        assert.equal(sourceAlive(sources.redraw), false, 'the redraw timer is removed');

        helper('SetExtensionEnabled', true);
        await waitFor(s => s.extensionState === ACTIVE && shown(s), 'the extension to come back mid-recording');
        await waitUntil(bridgeRunning, 'the audio bridge to restart');

        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();
    });

    test('disabling mid-drag, mid-fade and with timers pending leaves nothing behind', async () => {
        // A service change waiting to be confirmed, the move hint, and a drag all hold resources.
        helper('ToggleServiceSwitch');
        helper('ActivateMenuItem', 'Move recording indicator');
        await waitFor(shown, 'the positioning hint');
        helper('StartDrag');
        const before = await waitFor(s => s.grabbedByPill && s.sources.service !== 0 && s.sources.positioning !== 0, 'the grab and timers');

        await setEnabled(false);
        const after = inspect();
        assert.equal(after.grabbedByPill, false, 'the pointer grab is released, so input is not stuck');
        assert.equal(after.pill, null);
        assert.equal(sourceAlive(before.sources.service), false, 'the service timeout is removed');
        assert.equal(sourceAlive(before.sources.positioning), false, 'the positioning timeout is removed');

        // Disabling while the indicator is still fading out.
        touch('service-active');
        await setEnabled(true);
        writeState('recording');
        await waitFor(shown, 'the indicator to appear');
        writeState('idle');
        await sleep(30);
        await setEnabled(false);
        await sleep(500);
        assertNoErrors();

        await setEnabled(true);
        await waitFor(s => /^Ready\b/.test(s.indicator?.status) && hidden(s), 'the extension to settle');
        assertNoErrors();
    });

    test('forgets the state it had when disabled', async () => {
        writeState('recording');
        await waitFor(shown, 'the indicator to appear');
        await setEnabled(false);
        writeState(null);
        await setEnabled(true);
        await waitFor(s => s.indicator.status === 'Voxtype is stopped', 'voxtype to count as stopped');

        setSetting('show-pill', false);
        setSetting('show-pill', true);
        await sleep(300);
        assert.equal(hidden(inspect()), true, 'a setting change must not bring back the old recording');
        assert.equal(bridgeRunning(), false);
        assertNoErrors();
    });

    test('leaves nothing behind when it fails to start', async () => {
        await setEnabled(false);
        helper('BlockPanelRole', true);
        helper('SetExtensionEnabled', true);
        await waitFor(s => s.extensionState === ERROR, 'the extension to fail');
        assert.equal(inspect().pill, null, 'the indicator pill must not be left on screen');

        newErrors();
        helper('BlockPanelRole', false);
        helper('ReloadExtension');
        await waitFor(s => s.extensionState === ACTIVE && s.indicator !== null, 'the extension to come back');
        assertNoErrors();
    });

    test('nothing reacts once disabled: settings, monitors and state changes', async () => {
        await setEnabled(false);
        setSetting('accent-color', '#3584e4');
        setSetting('pill-style', 'wave');
        setSetting('show-pill', false);
        setSetting('pill-x', 0.2);
        helper('EmitMonitorsChanged');
        writeState('recording');
        await sleep(800);

        const state = inspect();
        assert.equal(state.pill, null);
        assert.equal(state.indicator, null);
        assert.equal(bridgeRunning(), false);
        assertNoErrors();

        writeState('idle');
        for (const key of ['accent-color', 'pill-style', 'show-pill', 'pill-x']) {
            resetSetting(key);
        }
        await setEnabled(true);
        await waitFor(s => /^Ready\b/.test(s.indicator?.status), 'the extension to come back');
        assertNoErrors();
    });

    test('moves with monitor changes while showing', async () => {
        writeState('recording');
        await waitFor(shown, 'the indicator to appear');
        helper('EmitMonitorsChanged');
        await sleep(200);
        assert.ok(shown(inspect()));
        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();
    });

    test('survives a misbehaving audio bridge: junk output, or crashing on start', async () => {
        writeFileSync(path('bridge-mode'), 'garbage');
        writeState('recording');
        await waitFor(shown, 'the indicator to appear');
        await waitUntil(bridgeRunning, 'the audio bridge to start');
        await sleep(600);
        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();

        writeFileSync(path('bridge-mode'), 'exit');
        writeState('recording');
        await waitFor(shown, 'the indicator to appear without a bridge');
        await sleep(600);
        assert.ok(shown(inspect()), 'the indicator stays up');
        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        rmSync(path('bridge-mode'));
        assertNoErrors();
    });

    test('reports a failing service change and clears the pending state', async () => {
        touch('systemd-fails');
        helper('ToggleServiceSwitch');
        await waitFor(s => /^Ready\b/.test(s.indicator.status) && s.indicator.serviceSwitch === true, 'the menu to recover');
        const errors = newErrors();
        rmSync(path('systemd-fails'));

        assert.equal(errors.length, 1, `expected one error notification, got ${JSON.stringify(errors)}`);
        assert.match(errors[0], /Could not stop the voxtype service/);
    });

    test('keeps up with rapid state changes without leaking audio bridges', async () => {
        for (let round = 0; round < 25; round += 1) {
            writeState(round % 5 === 4 ? 'transcribing' : 'recording');
            await sleep(40);
            writeState('idle');
            await sleep(40);
        }
        await waitFor(hidden, 'the indicator to settle hidden');
        await waitUntil(() => !bridgeRunning(), 'every audio bridge to stop');
        assertNoErrors();
    });

    test('picks up voxtype starting after the extension, as at login', async () => {
        await setEnabled(false);
        rmSync(path('runtime', 'voxtype'), { recursive: true, force: true });
        await setEnabled(true);
        await waitFor(s => s.indicator?.status === 'Voxtype is stopped', 'the stopped state');

        mkdirSync(path('runtime', 'voxtype'));
        writeState('idle');
        await waitFor(s => /^Ready\b/.test(s.indicator.status), 'voxtype to be noticed', 15000);
        writeState('recording');
        await waitFor(shown, 'the indicator to appear');
        writeState('idle');
        await waitFor(hidden, 'the indicator to hide');
        assertNoErrors();
    });

    describe('Cleanup Anything', () => {
        const editors = [];
        const FIELD = 'hello world';
        const CLIPBOARD = 'what was on the clipboard';

        function openEditor(appId, text, file, owned = null) {
            rmSync(path(file), { force: true });
            rmSync(path(`${file}.keys`), { force: true });
            const app = spawn('gjs', ['-m', join(ROOT, 'test', 'shell', 'helper', 'editor.js'), appId, path(file), text, ...(owned === null ? [] : [owned.type, owned.file])], {
                env: { ...env, WAYLAND_DISPLAY: 'wayland-0', GDK_BACKEND: 'wayland', GSK_RENDERER: 'cairo' },
                stdio: 'ignore',
            });
            editors.push(app);
            return app;
        }

        const field = (file = 'field.txt') => readFileSync(path(file), 'utf8');
        const shortcuts = (file = 'field.txt') => (existsSync(path(`${file}.keys`)) ? readFileSync(path(`${file}.keys`), 'utf8').trim().split('\n') : []);

        function clipboard() {
            rmSync(path('clipboard.txt'), { force: true });
            helper('SaveClipboard', path('clipboard.txt'));
            return readFileSync(path('clipboard.txt'), 'utf8');
        }

        function clipboardBytes(type) {
            rmSync(path('clipboard.bin'), { force: true });
            helper('SaveClipboardBytes', type, path('clipboard.bin'));
            return readFileSync(path('clipboard.bin'));
        }

        async function prepare(command, appId = 'org.voxtypeosd.Editor', owned = null) {
            editors.splice(0).forEach(app => app.kill());
            openEditor(appId, FIELD, 'field.txt', owned);
            await waitFor(s => s.windows.includes(appId), 'the text app');
            await waitUntil(() => field() === FIELD, 'the text app to fill in');
            await waitFor(s => s.actionMode === ACTION_MODE_NORMAL, 'the shell to finish starting');
            await sleep(400);
            if (owned === null) {
                helper('SetClipboard', CLIPBOARD);
                await waitUntil(() => clipboard() === CLIPBOARD, 'the clipboard to be set');
            } else {
                // A key pressed just after a window opens can miss it, so this presses again now and then.
                await waitFor(s => s.focused === appId, 'the text app to take focus');
                let attempts = 0;
                await waitUntil(() => {
                    if (attempts++ % 10 === 0) {
                        helper('PressKeys', 'z');
                    }
                    return clipboardBytes(owned.type).equals(readFileSync(owned.file));
                }, 'the app to take the clipboard', 10000);
            }
            setSetting('cleanup-command', command);
            setSetting('cleanup-anything-enabled', true);
            await sleep(100);
            clearCalls();
        }

        const finished = async () => {
            await waitFor(hidden, 'the cleanup to finish', 8000);
            await waitUntil(() => clipboard() === CLIPBOARD, 'the clipboard to be put back');
        };

        const doubleTap = () => helper('TapControl', 2, 120);
        const started = () => waitUntil(() => calls().includes('voxtype config get output.post_process.command'), 'the cleanup to start');

        after(() => {
            editors.forEach(app => app.kill());
            resetSetting('cleanup-anything-enabled');
            resetSetting('cleanup-anything-trigger');
            resetSetting('cleanup-command');
        });

        test('a double tap of Left Ctrl replaces the field and puts the clipboard back', async () => {
            await prepare('tr a-z A-Z');
            doubleTap();
            await waitUntil(() => field() === 'HELLO WORLD', 'the field to be replaced');
            await finished();
            assertNoErrors();
        });

        test('says it is cleaning up while the command runs', async () => {
            await prepare('sleep 1; tr a-z A-Z');
            doubleTap();
            await waitFor(s => shown(s) && s.pill.label === 'Cleaning up…', 'the indicator');
            await waitUntil(() => field() === 'HELLO WORLD', 'the field to be replaced');
            await finished();
            assertNoErrors();
        });

        test('runs the Claude Code example', async () => {
            const { claudeCleanupCommand } = await import(join(ROOT, 'build', 'prefs', 'models.js'));
            await prepare(claudeCleanupCommand());
            doubleTap();
            await waitUntil(() => field() === 'HELLO WORLD', 'the field to be replaced', 10000);
            await finished();
            assertNoErrors();
        });

        test('leaves the field alone when any command adds a link', async () => {
            await prepare("cat; echo ' https://evil.example'");
            doubleTap();
            await started();
            await finished();
            assert.equal(field(), FIELD);
            assertNoErrors();
        });

        test('fills in $prompt when dictation cleanup is off', async () => {
            setSetting('cleanup-prompt', "don't panic");
            await prepare('printf "%s" $prompt');
            doubleTap();
            await waitUntil(() => field() === "don't panic", 'the field to be replaced');
            await finished();
            resetSetting('cleanup-prompt');
            assertNoErrors();
        });

        test('ignores a single tap, and taps too far apart', async () => {
            await prepare('tr a-z A-Z');
            helper('TapControl', 1, 0);
            await sleep(700);
            helper('TapControl', 2, 600);
            await sleep(1200);
            assert.equal(calls().length, 0);
            assert.equal(field(), FIELD);
            assert.equal(clipboard(), CLIPBOARD);
        });

        test('ignores Ctrl+C and Ctrl+V pressed quickly together', async () => {
            await prepare('tr a-z A-Z');
            helper('PressKeys', 'Control_L+c');
            await sleep(120);
            helper('PressKeys', 'Control_L+Home');
            await sleep(900);
            assert.equal(calls().length, 0);
            assert.equal(field(), FIELD);
        });

        test('a custom shortcut works, while the double tap does nothing, and waits for the keys to lift', async () => {
            setSetting('cleanup-anything-trigger', 'shortcut');
            await prepare('tr a-z A-Z');
            doubleTap();
            await sleep(700);
            assert.equal(calls().length, 0);

            helper('PressKeys', 'Super_L+Alt_L+c');
            await waitUntil(() => field() === 'HELLO WORLD', 'the field to be replaced');
            await finished();
            setSetting('cleanup-anything-trigger', 'double-ctrl');
            assertNoErrors();
        });

        test('skips terminals, where Ctrl+C would interrupt what is running', async () => {
            await prepare('tr a-z A-Z', 'org.gnome.Console');
            doubleTap();
            await sleep(900);
            assert.equal(calls().length, 0);
            assert.equal(field(), FIELD);
            assert.equal(clipboard(), CLIPBOARD);
        });

        test('leaves the field alone when the command fails', async () => {
            await prepare('echo no thanks >&2; exit 1');
            doubleTap();
            await started();
            await sleep(600);
            await finished();
            assert.equal(field(), FIELD);
            assertNoErrors();
        });

        test('leaves the field alone when it changes during the cleanup', async () => {
            await prepare('sleep 1; tr a-z A-Z');
            doubleTap();
            await started();
            await sleep(300);
            helper('PressKeys', 'x');
            await waitUntil(() => field() === 'x', 'the keypress to arrive');
            await sleep(1500);
            await finished();
            assert.equal(field(), 'x');
        });

        test('leaves the field alone when focus moves to another window', async () => {
            await prepare('sleep 1.5; tr a-z A-Z');
            doubleTap();
            await started();
            openEditor('org.voxtypeosd.Other', 'other text', 'other.txt');
            await waitFor(s => s.windows.includes('org.voxtypeosd.Other'), 'the other app');
            await sleep(2000);
            await finished();
            assert.equal(field(), FIELD);
            assert.equal(field('other.txt'), 'other text');
        });

        test('the trigger cancels a running cleanup and stops its whole command', async () => {
            await prepare(`sleep 30 & echo $! > '${path('cleanup.pid')}'; wait; tr a-z A-Z`);
            doubleTap();
            await waitUntil(() => existsSync(path('cleanup.pid')), 'the command to start');
            const pid = Number(readFileSync(path('cleanup.pid'), 'utf8'));
            doubleTap();
            await waitUntil(() => !existsSync(`/proc/${pid}`), 'the command to stop');
            await finished();
            assert.equal(field(), FIELD);
            rmSync(path('cleanup.pid'));
            assertNoErrors();
        });

        for (const [what, type, contents] of [
            ['text', 'text/plain;charset=utf-8', Buffer.from('copied from an app')],
            ['an image', 'image/png', randomBytes(1024 * 1024)],
        ]) {
            test(`puts back ${what} copied from another app, byte for byte`, async () => {
                const owned = { type, file: path('owned.bin') };
                writeFileSync(owned.file, contents);
                await prepare('tr a-z A-Z', 'org.voxtypeosd.Editor', owned);
                doubleTap();
                await waitUntil(() => field() === 'HELLO WORLD', 'the field to be replaced');
                await waitFor(hidden, 'the cleanup to finish', 8000);
                await waitUntil(() => clipboardBytes(type).equals(contents), 'the clipboard to be put back');
                assertNoErrors();
            });
        }

        test('gives up when the app that owns the clipboard stops answering', async () => {
            const owned = { type: 'text/plain;charset=utf-8', file: path('owned.bin') };
            writeFileSync(owned.file, 'copied from an app');
            await prepare('tr a-z A-Z', 'org.voxtypeosd.Editor', owned);
            const app = editors[0];
            app.kill('SIGSTOP');
            try {
                doubleTap();
                await waitFor(s => shown(s) && s.pill.label === 'Cleaning up…', 'the cleanup to start');
                await waitFor(hidden, 'the cleanup to give up', 6000);
            } finally {
                app.kill('SIGCONT');
            }
            assert.equal(field(), FIELD);
        });

        test('sends no keys to a window that took focus while keys were held', async () => {
            await prepare('sleep 0.3; tr a-z A-Z');
            doubleTap();
            await started();
            helper('HoldKey', 'Shift_L');
            await sleep(800);
            openEditor('org.voxtypeosd.Other', 'other text', 'other.txt');
            await waitFor(s => s.focused === 'org.voxtypeosd.Other', 'the other app to take focus');
            helper('ReleaseKey', 'Shift_L');
            await sleep(1000);
            await finished();
            assert.deepEqual(shortcuts('other.txt'), []);
            assert.equal(field(), FIELD);
            assert.equal(field('other.txt'), 'other text');
        });

        test('sends no keys once the extension is disabled while keys are held', async () => {
            await prepare('sleep 0.3; tr a-z A-Z');
            doubleTap();
            await started();
            helper('HoldKey', 'Shift_L');
            await sleep(800);
            const before = shortcuts();
            await setEnabled(false);
            helper('ReleaseKey', 'Shift_L');
            await sleep(600);
            assert.deepEqual(shortcuts(), before);
            await setEnabled(true);
            assert.equal(field(), FIELD);
            await waitUntil(() => clipboard() === CLIPBOARD, 'the clipboard to be put back');
            assertNoErrors();
        });

        test('refuses a command that prints far too much', async () => {
            await prepare('head -c 3000000 /dev/zero | tr \'\\0\' a');
            doubleTap();
            await started();
            await sleep(600);
            await finished();
            assert.equal(field(), FIELD);
            assertNoErrors();
        });

        test('kills a command that ignores being asked to stop', async () => {
            await prepare(`trap '' TERM; sleep 30 & echo $! > '${path('cleanup.pid')}'; wait; tr a-z A-Z`);
            doubleTap();
            await waitUntil(() => existsSync(path('cleanup.pid')), 'the command to start');
            const pid = Number(readFileSync(path('cleanup.pid'), 'utf8'));
            doubleTap();
            try {
                await waitUntil(() => !existsSync(`/proc/${pid}`), 'the command to be killed');
                await finished();
            } finally {
                rmSync(path('cleanup.pid'));
                try {
                    process.kill(pid, 'SIGKILL');
                } catch {
                    // Already gone.
                }
            }
            assert.equal(field(), FIELD);
            assertNoErrors();
        });

        test('does nothing while turned off', async () => {
            await prepare('tr a-z A-Z');
            setSetting('cleanup-anything-enabled', false);
            await sleep(100);
            doubleTap();
            await sleep(800);
            assert.equal(calls().length, 0);
            assert.equal(field(), FIELD);
        });

        test('stops cleanly when the extension is disabled partway through', async () => {
            await prepare('sleep 2; tr a-z A-Z');
            doubleTap();
            await started();
            await setEnabled(false);
            await setEnabled(true);
            await sleep(600);
            assert.equal(field(), FIELD);
            assert.equal(clipboard(), CLIPBOARD);
            assertNoErrors();
        });
    });

    for (const page of ['general', 'indicator', 'dictation', 'models', 'cleanup', 'notifications']) {
        test(`the Settings window opens on the ${page} page without errors`, async () => {
            closeSettings();
            clearCalls();
            execFileSync('dbus-update-activation-environment', [`VOXTYPE_OSD_PREFS_PAGE=${page}`], { env });
            execFileSync('gnome-extensions', ['prefs', UUID], { env });
            await waitFor(s => s.windows.includes('Voxtype OSD'), 'the Settings window');
            // The voxtype pages are filled from voxtype's own schema, asked for when the window opens.
            await waitUntil(() => calls().includes('voxtype config schema --json'), 'the voxtype schema request');
            await sleep(1500);
            if (SCREENSHOTS !== null) {
                mkdirSync(SCREENSHOTS, { recursive: true });
                helper('ScreenshotWindow', join(SCREENSHOTS, `settings-${page}.png`));
            }
            assertNoErrors();
        });
    }

    test('never spawns systemctl: voxtype.service is only controlled over D-Bus', () => {
        const log = path('systemctl-calls.log');
        assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '');
    });

    // Stops the Settings window process registered on the test bus, and only that one.
    function closeSettings() {
        let output;
        try {
            output = execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/',
                '--method', 'org.freedesktop.DBus.GetConnectionUnixProcessID', 'org.gnome.Shell.Extensions'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            return;
        }
        const pid = Number(/uint32 (\d+)/.exec(output)?.[1]);
        if (pid > 0 && readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`XDG_RUNTIME_DIR=${path('runtime')}`)) {
            process.kill(pid, 'SIGTERM');
            execFileSync('sleep', ['0.5']);
        }
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
