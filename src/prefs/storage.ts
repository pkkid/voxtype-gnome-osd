import Gio from 'gi://Gio';

// Symlinks are removed rather than followed, so nothing outside the path is touched.
export function deletePath(file: Gio.File): boolean {
    try {
        if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
            const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            for (let child = children.next_file(null); child !== null; child = children.next_file(null)) {
                deletePath(children.get_child(child));
            }
            children.close(null);
        }
        return file.delete(null);
    } catch {
        return false;
    }
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
