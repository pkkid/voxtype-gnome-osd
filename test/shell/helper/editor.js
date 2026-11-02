// A minimal text app for the Cleanup Anything tests: a text field that saves every change to a file,
// so the tests can see what really arrived in it, and every Ctrl shortcut to <file>.keys. Run as:
// gjs -m editor.js <app id> <file> <text> [<clipboard type> <clipboard file>]
// With the last two it takes the clipboard when z is pressed, so that an app and not the shell owns what is on it.
// Wayland only lets an app do that in answer to input.
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const [appId, file, text, clipboardType, clipboardFile] = ARGV;

function recordShortcut(keyval) {
    const stream = Gio.File.new_for_path(`${file}.keys`).append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(`${Gdk.keyval_name(keyval)}\n`), null);
    stream.close(null);
}

const app = new Gtk.Application({ application_id: appId, flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect('activate', () => {
    const view = new Gtk.TextView();
    view.buffer.connect('changed', () => GLib.file_set_contents(file, view.buffer.text));
    view.buffer.text = text;

    const keys = new Gtk.EventControllerKey({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
    keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0) {
            recordShortcut(keyval);
        }
        if (keyval === Gdk.KEY_z && clipboardType !== undefined) {
            const [, contents] = GLib.file_get_contents(clipboardFile);
            view.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes(clipboardType, new GLib.Bytes(contents)));
            return Gdk.EVENT_STOP;
        }
        return Gdk.EVENT_PROPAGATE;
    });
    view.add_controller(keys);

    const window = new Gtk.ApplicationWindow({ application: app, title: appId, default_width: 500, default_height: 300, child: view });
    window.present();
    view.grab_focus();
});
app.run([]);
