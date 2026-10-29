import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// Below this width the sidebar and the page take turns instead of sitting side by side.
const COLLAPSE_CONDITION = 'max-width: 600sp';
const HEADER_MARGIN_TOP = 18;
const HEADER_UNDER_BAR_MARGIN_TOP = 6;

const PREFS_CSS = `
.voxtype-prefs-logo {
    min-width: 40px;
    min-height: 40px;
    border-radius: 10px;
    background-color: @accent_bg_color;
    color: @accent_fg_color;
}

.voxtype-style-card {
    padding: 0;
    border-radius: 12px;
    border: 1.5px solid alpha(currentColor, 0.11);
    background-color: @card_bg_color;
    background-image: none;
}

.voxtype-style-card:hover {
    border-color: alpha(currentColor, 0.22);
}

.voxtype-style-card:checked {
    border-color: @accent_bg_color;
    background-color: @card_bg_color;
}

/* Previews are drawn in white, so the stage stays dark under a light theme too. */
.voxtype-style-stage {
    border-radius: 11px 11px 0 0;
    background-image: linear-gradient(160deg, alpha(@accent_bg_color, 0.22), alpha(black, 0) 55%),
                      linear-gradient(160deg, #34343e, #1d1d24);
}

.voxtype-style-footer {
    padding: 10px 12px;
}
`;

export type SidebarHeader = {
    title: string;
    subtitle: string;
    iconName: string;
};

const toastOverlays = new WeakMap<Adw.PreferencesWindow, Adw.ToastOverlay>();
let cssLoaded = false;

// Replaces the stock page switcher with a sidebar: a header naming the extension above a list of
// pages, and the selected page on the right.
export function setSidebarContent(window: Adw.PreferencesWindow, header: SidebarHeader, pages: Adw.PreferencesPage[]): void {
    ensurePrefsCss();

    // The prefs service refuses to show a window whose stock view has no visible page, so it gets an
    // empty one; the real pages live in the sidebar layout set as the window content below.
    window.add(new Adw.PreferencesPage());

    const stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        vexpand: true,
    });
    for (const page of pages) {
        stack.add_named(page, page.name);
    }

    const contentView = new Adw.ToolbarView({ content: stack });
    contentView.add_top_bar(new Adw.HeaderBar());
    const contentPage = new Adw.NavigationPage({ title: pages[0]?.title ?? '', child: contentView });

    const list = new Gtk.ListBox({
        css_classes: ['navigation-sidebar'],
        selection_mode: Gtk.SelectionMode.BROWSE,
    });
    for (const page of pages) {
        list.append(buildSidebarRow(page));
    }

    const headerBox = buildSidebarHeader(header);
    const sidebarBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    sidebarBox.append(headerBox);
    sidebarBox.append(new Gtk.ScrolledWindow({
        child: list,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vexpand: true,
    }));

    const sidebarHeaderBar = new Adw.HeaderBar({ show_title: false });
    const sidebarView = new Adw.ToolbarView({ content: sidebarBox });
    sidebarView.add_top_bar(sidebarHeaderBar);
    const sidebarPage = new Adw.NavigationPage({ title: header.title, child: sidebarView });

    const split = new Adw.NavigationSplitView({
        sidebar: sidebarPage,
        content: contentPage,
        min_sidebar_width: 200,
        max_sidebar_width: 240,
    });

    // The sidebar's header bar only holds window buttons when they sit on the left, or when the
    // sidebar is shown alone. Otherwise it is empty, so hide it and let the header sit at the top.
    const windowControls = new Gtk.WindowControls({ side: Gtk.PackType.START, visible: false });
    sidebarBox.append(windowControls);
    const syncSidebarHeaderBar = () => {
        sidebarHeaderBar.visible = split.collapsed || !windowControls.empty;
        headerBox.margin_top = sidebarHeaderBar.visible ? HEADER_UNDER_BAR_MARGIN_TOP : HEADER_MARGIN_TOP;
    };
    windowControls.connect('notify::empty', syncSidebarHeaderBar);
    split.connect('notify::collapsed', syncSidebarHeaderBar);
    syncSidebarHeaderBar();

    list.connect('row-selected', (_list, row: Gtk.ListBoxRow | null) => {
        const page = row === null ? undefined : pages[row.get_index()];
        if (page !== undefined) {
            stack.visible_child = page;
            contentPage.title = page.title;
        }
    });
    list.connect('row-activated', () => {
        split.show_content = true;
    });
    // VOXTYPE_OSD_PREFS_PAGE=<page name> opens another page first; the shell tests use it.
    const firstPage = Math.max(0, pages.findIndex(page => page.name === GLib.getenv('VOXTYPE_OSD_PREFS_PAGE')));
    list.select_row(list.get_row_at_index(firstPage));

    const breakpoint = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse(COLLAPSE_CONDITION) });
    breakpoint.add_setter(split, 'collapsed', true);
    window.add_breakpoint(breakpoint);

    const overlay = new Adw.ToastOverlay({ child: split });
    window.set_content(overlay);
    toastOverlays.set(window, overlay);
}

// The stock toast overlay is no longer on screen once the sidebar layout replaces the content.
export function showToast(window: Adw.PreferencesWindow, title: string): void {
    const toast = new Adw.Toast({ title, timeout: 4 });
    const overlay = toastOverlays.get(window);
    if (overlay === undefined) {
        window.add_toast(toast);
    } else {
        overlay.add_toast(toast);
    }
}

export function ensurePrefsCss(): void {
    const display = Gdk.Display.get_default();
    if (cssLoaded || display === null) {
        return;
    }

    const provider = new Gtk.CssProvider();
    provider.load_from_string(PREFS_CSS);
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    cssLoaded = true;
}

function buildSidebarHeader({ title, subtitle, iconName }: SidebarHeader): Gtk.Box {
    const box = new Gtk.Box({
        spacing: 12,
        margin_bottom: 14,
        margin_start: 12,
        margin_end: 12,
    });
    box.append(new Gtk.Image({
        icon_name: iconName,
        pixel_size: 22,
        css_classes: ['voxtype-prefs-logo'],
        valign: Gtk.Align.CENTER,
    }));

    const labels = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
    labels.append(new Gtk.Label({ label: title, halign: Gtk.Align.START, css_classes: ['heading'] }));
    labels.append(new Gtk.Label({ label: subtitle, halign: Gtk.Align.START, css_classes: ['caption', 'dimmed'] }));
    box.append(labels);

    return box;
}

function buildSidebarRow(page: Adw.PreferencesPage): Gtk.ListBoxRow {
    const box = new Gtk.Box({
        spacing: 12,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 6,
        margin_end: 6,
    });
    box.append(new Gtk.Image({ icon_name: page.icon_name }));
    box.append(new Gtk.Label({ label: page.title }));
    return new Gtk.ListBoxRow({ child: box });
}

