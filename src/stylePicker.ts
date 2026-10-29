import Cairo from 'cairo';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { accentColor, parseHexColor, RECORDING_DOT_COLOR, Rgb } from './color.js';
import { ensurePrefsCss } from './prefsWindow.js';

// Previews are drawn on a 150×64 canvas, scaled to fit the card.
const SCENE_WIDTH = 150;
const SCENE_HEIGHT = 64;
const STAGE_HEIGHT = 92;

// Made-up bar heights so the previews look like a voice rather than a ramp.
const BAR_PATTERN = [0.35, 0.6, 0.9, 0.5, 0.75, 0.3, 0.55, 1, 0.65, 0.4, 0.8, 0.45, 0.25, 0.7];

type Context = Cairo.Context;

type StyleOption = {
    value: string;
    title: string;
    caption: string;
    draw: (cr: Context, accent: Rgb) => void;
};

const STYLE_OPTIONS: StyleOption[] = [
    { value: 'classic', title: 'Classic', caption: 'Box with stepping bars', draw: drawClassic },
    { value: 'minimal', title: 'Minimal', caption: 'Small, no text', draw: drawMinimal },
    { value: 'wave', title: 'Wave', caption: 'Smooth sine ribbons', draw: drawWave },
    { value: 'osd', title: 'GNOME OSD', caption: 'Like the volume popup', draw: drawOsd },
];

const RECORDING_DOT = parseHexColor(RECORDING_DOT_COLOR) as Rgb;

// A 2×2 grid of cards, each a sketch of one indicator style in white and the accent color, as it
// will look on screen. Picking a card sets `key`.
export function buildStylePickerGroup(settings: Gio.Settings, key: string): Adw.PreferencesGroup {
    ensurePrefsCss();

    const group = new Adw.PreferencesGroup({
        title: 'Style',
        description: 'How the indicator looks while you dictate.',
    });

    const grid = new Gtk.Grid({
        column_spacing: 12,
        row_spacing: 12,
        column_homogeneous: true,
    });
    group.add(grid);

    let accent = readAccent(settings);
    const stages: Gtk.DrawingArea[] = [];
    const cards = new Map<string, Gtk.ToggleButton>();
    STYLE_OPTIONS.forEach((option, index) => {
        const [card, stage] = buildCard(option, () => accent);
        stages.push(stage);
        const first = cards.values().next().value;
        if (first !== undefined) {
            card.set_group(first);
        }
        cards.set(option.value, card);
        grid.attach(card, index % 2, Math.floor(index / 2), 1, 1);

        card.connect('toggled', () => {
            if (card.active && settings.get_string(key) !== option.value) {
                settings.set_string(key, option.value);
            }
        });
    });

    const sync = () => {
        (cards.get(settings.get_string(key)) ?? cards.get('classic'))?.set_active(true);
    };
    const changedIds = [
        settings.connect(`changed::${key}`, sync),
        settings.connect('changed::accent-color', () => {
            accent = readAccent(settings);
            stages.forEach(stage => stage.queue_draw());
        }),
    ];
    grid.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
    sync();

    return group;
}

function readAccent(settings: Gio.Settings): Rgb {
    return parseHexColor(accentColor(settings.get_string('accent-color'))) as Rgb;
}

function buildCard(option: StyleOption, getAccent: () => Rgb): [Gtk.ToggleButton, Gtk.DrawingArea] {
    const stage = new Gtk.DrawingArea({
        content_height: STAGE_HEIGHT,
        hexpand: true,
        css_classes: ['voxtype-style-stage'],
    });
    stage.set_draw_func((_area, cr, width, height) => {
        const scale = Math.min(width / SCENE_WIDTH, height / SCENE_HEIGHT, 1.3);
        cr.translate((width - SCENE_WIDTH * scale) / 2, (height - SCENE_HEIGHT * scale) / 2);
        cr.scale(scale, scale);
        option.draw(cr, getAccent());
        cr.$dispose();
    });

    const footer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        css_classes: ['voxtype-style-footer'],
    });
    footer.append(new Gtk.Label({ label: option.title, halign: Gtk.Align.START, css_classes: ['caption-heading'] }));
    footer.append(new Gtk.Label({ label: option.caption, halign: Gtk.Align.START, css_classes: ['caption', 'dimmed'] }));

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, overflow: Gtk.Overflow.HIDDEN });
    box.append(stage);
    box.append(footer);

    const card = new Gtk.ToggleButton({
        child: box,
        css_classes: ['flat', 'voxtype-style-card'],
        tooltip_text: option.title,
    });
    return [card, stage];
}

// ───────────────────────── Preview sketches ─────────────────────────

function drawClassic(cr: Context, accent: Rgb): void {
    drawPill(cr, 5, 12, 140, 40, 6, accent);
    drawMicrophone(cr, 21, 32);
    drawLabel(cr, 36, 22, 34);
    drawBars(cr, accent, 36, 136, 38, 4, 12);
}

function drawMinimal(cr: Context, accent: Rgb): void {
    drawPill(cr, 42, 21, 66, 22, 11, null);
    color(cr, RECORDING_DOT, 1);
    cr.arc(55, 32, 3, 0, Math.PI * 2);
    cr.fill();
    drawBars(cr, accent, 64, 100, 32, 4.5, 12);
}

function drawWave(cr: Context, accent: Rgb): void {
    drawPill(cr, 5, 12, 140, 40, 20, null);
    drawMicrophone(cr, 24, 32);
    drawLabel(cr, 39, 22, 34);

    const layers = [
        { cycles: 1.6, phase: 0.6, amplitude: 6, alpha: 0.95 },
        { cycles: 2.4, phase: 2.2, amplitude: 4, alpha: 0.45 },
    ];
    for (const layer of layers) {
        for (let x = 39; x <= 132; x += 1) {
            const progress = (x - 39) / (132 - 39);
            const taper = Math.sin(Math.PI * progress) ** 2;
            const y = 39 + Math.sin(progress * Math.PI * 2 * layer.cycles + layer.phase) * layer.amplitude * taper;
            if (x === 39) {
                cr.moveTo(x, y);
            } else {
                cr.lineTo(x, y);
            }
        }
        color(cr, accent, layer.alpha);
        cr.setLineWidth(1.5);
        cr.stroke();
    }
}

function drawOsd(cr: Context, accent: Rgb): void {
    drawPill(cr, 22, 10, 106, 44, 22, null);
    drawMicrophone(cr, 41, 32);
    drawLabel(cr, 74, 20, 30);
    drawBars(cr, accent, 60, 116, 39, 4, 9);
}

// The indicator's outline: a translucent body, with a solid colored border for Classic.
function drawPill(cr: Context, x: number, y: number, width: number, height: number, radius: number, border: Rgb | null): void {
    roundedRect(cr, x, y, width, height, radius);
    white(cr, 0.12);
    cr.fillPreserve();
    if (border === null) {
        white(cr, 0.3);
        cr.setLineWidth(1);
    } else {
        color(cr, border, 1);
        cr.setLineWidth(1.5);
    }
    cr.stroke();
}

// A small microphone with the recording dot on its lower right.
function drawMicrophone(cr: Context, centreX: number, centreY: number): void {
    white(cr, 0.95);
    roundedRect(cr, centreX - 2.5, centreY - 8, 5, 9, 2.5);
    cr.fill();

    cr.setLineWidth(1.3);
    cr.arc(centreX, centreY - 2, 5, 0, Math.PI);
    cr.stroke();
    cr.moveTo(centreX, centreY + 3);
    cr.lineTo(centreX, centreY + 7);
    cr.stroke();

    // A dark ring around the dot, like the cut-out it has on screen.
    cr.setSourceRGBA(0.16, 0.16, 0.19, 1);
    cr.arc(centreX + 5, centreY + 5, 3.8, 0, Math.PI * 2);
    cr.fill();
    color(cr, RECORDING_DOT, 1);
    cr.arc(centreX + 5, centreY + 5, 2.5, 0, Math.PI * 2);
    cr.fill();
}

// Stands in for the "Recording…" text.
function drawLabel(cr: Context, x: number, y: number, width: number): void {
    white(cr, 0.9);
    roundedRect(cr, x, y, width, 4, 2);
    cr.fill();
}

// Rounded bars from `left` to `right`, centred on `middle`, at most `maxHeight` tall.
function drawBars(cr: Context, accent: Rgb, left: number, right: number, middle: number, pitch: number, maxHeight: number): void {
    color(cr, accent, 0.95);
    cr.setLineWidth(2);
    cr.setLineCap(Cairo.LineCap.ROUND);

    const count = Math.floor((right - left) / pitch) + 1;
    for (let index = 0; index < count; index += 1) {
        const level = BAR_PATTERN[index % BAR_PATTERN.length];
        const half = Math.max(0, (level * maxHeight - 2) / 2);
        const x = left + index * pitch;
        cr.moveTo(x, middle - half);
        cr.lineTo(x, middle + half);
    }
    cr.stroke();
}

function roundedRect(cr: Context, x: number, y: number, width: number, height: number, radius: number): void {
    const r = Math.min(radius, width / 2, height / 2);
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

function white(cr: Context, alpha: number): void {
    cr.setSourceRGBA(1, 1, 1, alpha);
}

function color(cr: Context, [red, green, blue]: Rgb, alpha: number): void {
    cr.setSourceRGBA(red, green, blue, alpha);
}
