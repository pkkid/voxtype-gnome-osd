import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { run } from '../voxtype.js';
import { formatBytes, parseModelsDir, parseOllamaList } from './models.js';
import { showToast } from './window.js';

export function buildStorageGroup(window: Adw.PreferencesWindow): { group: Adw.PreferencesGroup; refresh: () => void } {
    const group = new Adw.PreferencesGroup({ title: 'Storage' });
    let modelsDir = '';

    const folderRow = new Adw.ActionRow({ title: 'Dictation models folder', activatable: true });
    folderRow.add_suffix(new Gtk.Image({ icon_name: 'folder-open-symbolic' }));
    folderRow.connect('activated', () => {
        try {
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(modelsDir, null), null);
        } catch {
            showToast(window, `Could not open ${modelsDir}`);
        }
    });
    group.add(folderRow);

    const totalLabel = new Gtk.Label({ css_classes: ['dim-label'] });
    const totalRow = new Adw.ActionRow({ title: 'Total space used' });
    totalRow.add_suffix(totalLabel);
    group.add(totalRow);

    const refresh = async () => {
        const [catalogText, ollamaResult] = await Promise.all([run(['voxtype', 'info', 'models']), run(['ollama', 'list'])]);
        const ollamaModels = ollamaResult.ok ? parseOllamaList(ollamaResult.stdout) : [];

        modelsDir = parseModelsDir(catalogText.stdout) ?? GLib.build_filenamev([GLib.get_user_data_dir(), 'voxtype', 'models']);
        folderRow.subtitle = modelsDir;

        const dictationBytes = pathSize(Gio.File.new_for_path(modelsDir));
        const cleanupBytes = ollamaModels.reduce((total, model) => total + model.bytes, 0);
        totalLabel.label = formatBytes(dictationBytes + cleanupBytes);
        totalRow.subtitle = cleanupBytes > 0 ? `${formatBytes(dictationBytes)} dictation, ${formatBytes(cleanupBytes)} Ollama` : '';
    };

    return {
        group,
        refresh: () => {
            refresh().catch(error => logError(error as Error, 'voxtype-osd: could not measure the models folder'));
        },
    };
}

export function pathSize(file: Gio.File): number {
    try {
        const attributes = 'standard::name,standard::size,standard::type';
        const info = file.query_info(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
            return info.get_size();
        }

        let total = 0;
        const children = file.enumerate_children(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let child = children.next_file(null); child !== null; child = children.next_file(null)) {
            total += pathSize(children.get_child(child));
        }
        children.close(null);
        return total;
    } catch {
        return 0;
    }
}
