// A minimal text app for the Cleanup Anything tests: a text field that saves every change to a file,
// so the tests can see what really arrived in it. Run as: gjs -m editor.js <app id> <file> <text>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const [appId, file, text] = ARGV;

const app = new Gtk.Application({ application_id: appId, flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect('activate', () => {
    const view = new Gtk.TextView();
    view.buffer.connect('changed', () => GLib.file_set_contents(file, view.buffer.text));
    view.buffer.text = text;

    const window = new Gtk.ApplicationWindow({ application: app, title: appId, default_width: 500, default_height: 300, child: view });
    window.present();
    view.grab_focus();
});
app.run([]);
