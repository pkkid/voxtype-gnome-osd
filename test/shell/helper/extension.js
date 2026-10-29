// Test helper loaded next to Voxtype OSD in the headless test shell. It exposes a small D-Bus
// interface so test/shell/shell.test.mjs can look at what the extension put on screen and poke it.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'voxtype-osd@theoodawara';
const BUS_NAME = 'org.voxtypeosd.TestHelper';
const OBJECT_PATH = '/org/voxtypeosd/TestHelper';

const INTERFACE = `
<node>
  <interface name="org.voxtypeosd.TestHelper">
    <method name="Inspect"><arg type="s" direction="in" name="path"/></method>
    <method name="PressPanelIcon">
      <arg type="u" direction="in" name="button"/>
      <arg type="b" direction="out" name="handled"/>
    </method>
    <method name="ToggleServiceSwitch"/>
    <method name="ActivateMenuItem"><arg type="s" direction="in" name="label"/></method>
    <method name="CloseMenu"/>
    <method name="SetExtensionEnabled"><arg type="b" direction="in" name="enabled"/></method>
    <method name="Screenshot">
      <arg type="s" direction="in" name="path"/>
      <arg type="i" direction="in" name="x"/><arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/><arg type="i" direction="in" name="height"/>
    </method>
    <method name="ScreenshotWindow"><arg type="s" direction="in" name="path"/></method>
  </interface>
</node>`;

function indicator() {
    return Main.panel.statusArea[UUID] ?? null;
}

// The indicator pill is added as top chrome, so it sits somewhere under uiGroup.
function findPill(actor = Main.layoutManager.uiGroup, depth = 0) {
    for (const child of actor.get_children()) {
        if (child.has_style_class_name?.('voxtype-pill')) {
            return child;
        }
        if (depth < 2) {
            const found = findPill(child, depth + 1);
            if (found !== null) {
                return found;
            }
        }
    }
    return null;
}

function findByClass(actor, styleClass) {
    if (actor.has_style_class_name?.(styleClass)) {
        return actor;
    }
    for (const child of actor.get_children()) {
        const found = findByClass(child, styleClass);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function describePill(pill) {
    const label = findByClass(pill, 'voxtype-pill-label');
    const dot = findByClass(pill, 'voxtype-pill-badge') ?? findByClass(pill, 'voxtype-pill-dot');
    const waveform = findByClass(pill, 'voxtype-waveform');
    return {
        visible: pill.visible,
        opacity: pill.opacity,
        width: pill.width,
        height: pill.height,
        styleClass: pill.style_class,
        style: pill.get_style(),
        label: label?.text ?? null,
        dot: dot === null ? null : { opacity: dot.opacity, style: dot.get_style() },
        waveformVisible: waveform?.visible ?? null,
    };
}

function describeIndicator(button) {
    return {
        visible: button.container.visible,
        iconName: button.icon.icon_name,
        iconStyle: button.icon.get_style(),
        menuOpen: button.menu.isOpen,
        status: button.statusItem.label.text,
        dictation: button.dictationItem.visible ? button.dictationItem.label.text : null,
        serviceSwitch: button.serviceItem.state,
    };
}

function inspect() {
    const pill = findPill();
    const button = indicator();
    return {
        extensionState: Main.extensionManager.lookup(UUID)?.state ?? null,
        indicator: button === null ? null : describeIndicator(button),
        pill: pill === null ? null : describePill(pill),
        windows: global.get_window_actors().map(actor => actor.meta_window.get_title()),
    };
}

function writeScreenshot(path, take) {
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    return take(new Shell.Screenshot(), stream).then(() => stream.close(null));
}

export default class TestHelper extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);

        // The headless shell starts in the overview; the tests want the plain desktop.
        if (Main.layoutManager._startingUp) {
            this._startupId = Main.layoutManager.connect('startup-complete', () => Main.overview.hide());
        } else {
            Main.overview.hide();
        }
    }

    disable() {
        if (this._startupId) {
            Main.layoutManager.disconnect(this._startupId);
        }
        Gio.bus_unown_name(this._nameId);
        this._dbus.unexport();
    }

    Inspect(path) {
        // A file sidesteps GVariant's string escaping for the JSON.
        GLib.file_set_contents(path, JSON.stringify(inspect()));
    }

    // Hands the panel button a button press, as Clutter would. The headless backend drops virtual
    // pointer button events, so this calls the button's event handler directly. Returns whether the
    // button handled the press itself (true) or let it through to GNOME's own menu handling (false).
    PressPanelIcon(button) {
        const press = {
            type: () => Clutter.EventType.BUTTON_PRESS,
            get_button: () => button,
        };
        return indicator().vfunc_event(press) === Clutter.EVENT_STOP;
    }

    // Same as clicking the switch: PopupSwitchMenuItem.toggle() emits 'toggled'.
    ToggleServiceSwitch() {
        indicator().serviceItem.toggle();
    }

    ActivateMenuItem(label) {
        const item = indicator().menu._getMenuItems().find(menuItem => menuItem.label?.text === label);
        if (item === undefined) {
            throw new Error(`No menu item labelled "${label}"`);
        }
        item.emit('activate', Clutter.get_current_event());
    }

    CloseMenu() {
        indicator()?.menu.close(false);
    }

    SetExtensionEnabled(enabled) {
        if (enabled) {
            Main.extensionManager.enableExtension(UUID);
        } else {
            Main.extensionManager.disableExtension(UUID);
        }
    }

    ScreenshotAsync([path, x, y, width, height], invocation) {
        writeScreenshot(path, (shot, stream) => shot.screenshot_area(x, y, width, height, stream))
            .then(() => invocation.return_value(null))
            .catch(error => invocation.return_error_literal(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, String(error)));
    }

    ScreenshotWindowAsync([path], invocation) {
        writeScreenshot(path, (shot, stream) => shot.screenshot_window(true, false, stream))
            .then(() => invocation.return_value(null))
            .catch(error => invocation.return_error_literal(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, String(error)));
    }
}
