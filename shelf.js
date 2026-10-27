// Shelf window for NotchUser on GNOME.
// GNOME Shell extensions can't receive files dropped from apps, so this small GTK app does
// it instead. The extension shows it under the pill when a drag heads for the top bar and
// places it there (on Wayland only the shell can position windows).
// Usage: gjs -m shelf.js [show|peek|hide|toggle|start|quit] [system|en|pt|es]
// Once running, the same commands are app actions on D-Bus (the extension uses those).
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import System from 'system';

import {resolveLang, tr} from './strings.js';

// Thumbnails for files that were never previewed, made by the same generator Files uses.
let GnomeDesktop = null;
try {
    GnomeDesktop = (await import('gi://GnomeDesktop?version=4.0')).default;
} catch {
    // Without it, those files keep their type icon.
}

const APP_ID = 'io.github.magnumja.NotchUserShelf';
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchuser']);
const DATA_FILE = GLib.build_filenamev([DATA_DIR, 'shelf.json']);

const CSS = `
window.notchuser-shelf { background: transparent; }
.shelf {
  background-color: rgba(18, 18, 22, 0.62);
  border-radius: 22px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  padding: 12px;
  color: white;
}
.shelf.drop-hover { border-color: rgba(255, 255, 255, 0.6); background-color: rgba(40, 40, 48, 0.72); }
.shelf-title { font-weight: 700; font-size: 0.9em; color: rgba(255, 255, 255, 0.7); }
.drop-zone {
  border: 1.5px dashed rgba(255, 255, 255, 0.35);
  border-radius: 14px;
  padding: 16px;
  color: rgba(255, 255, 255, 0.7);
  font-weight: 600;
}
.drop-hover .drop-zone { border-color: rgba(255, 255, 255, 0.85); color: white; }
.drop-count { font-size: 0.8em; font-weight: 400; color: rgba(255, 255, 255, 0.55); }
.item { border-radius: 10px; padding: 4px; }
.item:hover { background-color: rgba(255, 255, 255, 0.08); }
.item.selected { background-color: rgba(53, 132, 228, 0.35); box-shadow: inset 0 0 0 1.5px rgba(53, 132, 228, 0.9); }
.item-label { font-size: 0.75em; color: rgba(255, 255, 255, 0.8); }
.text-card {
  background-color: rgba(255, 255, 255, 0.92);
  color: rgba(0, 0, 0, 0.75);
  border-radius: 6px;
  padding: 3px;
  font-size: 5.5pt;
}
.item-remove {
  min-height: 18px; min-width: 18px; padding: 0;
  border: none; box-shadow: none; border-radius: 99px;
  background-color: rgba(0, 0, 0, 0.65); color: white;
}
.flat-btn {
  background: none; border: none; box-shadow: none;
  color: rgba(255, 255, 255, 0.6);
  min-height: 24px; min-width: 24px; padding: 2px; border-radius: 99px;
}
.flat-btn:hover { background-color: rgba(255, 255, 255, 0.1); }
`;

// MARK: - Storage (shared with the extension, which shows the count in the pill)

function save(items) {
    GLib.mkdir_with_parents(DATA_DIR, 0o755);
    GLib.file_set_contents(DATA_FILE, JSON.stringify(items));
}

function load() {
    let items;
    try {
        const [, bytes] = GLib.file_get_contents(DATA_FILE);
        items = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return [];
    }
    // Files moved or deleted elsewhere drop off the shelf (and the pill's count).
    const kept = items.filter(e => e.kind !== 'file' || GLib.file_test(e.value, GLib.FileTest.EXISTS));
    if (kept.length !== items.length)
        save(kept);
    return kept;
}

const key = e => `${e.kind}:${e.value}`;

function title(e, lang) {
    if (e.kind === 'file')
        return GLib.path_get_basename(e.value);
    if (e.kind === 'link') {
        try {
            return GLib.Uri.parse(e.value, GLib.UriFlags.NONE).get_host() ?? e.value;
        } catch {
            return e.value;
        }
    }
    return e.value.trim().split('\n')[0] || tr('text', lang);
}

function stringValue(text) {
    const v = new GObject.Value();
    v.init(GObject.TYPE_STRING);
    v.set_string(text);
    return v;
}

// MARK: - Thumbnails

const thumbnailer = GnomeDesktop
    ? GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.NORMAL)
    : null;

/**
 * Puts the file's preview in `image`: its type icon right away, then the cached thumbnail,
 * or a freshly generated one. All of it async, so a full shelf opens without a stall.
 */
function loadPreview(path, image) {
    const file = Gio.File.new_for_path(path);
    file.query_info_async('standard::icon,standard::content-type,time::modified,thumbnail::path',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (_f, res) => {
            let info;
            try {
                info = file.query_info_finish(res);
            } catch {
                return;
            }
            const cached = info.get_attribute_byte_string('thumbnail::path');
            if (cached) {
                image.set_from_file(cached);
                return;
            }
            image.set_from_gicon(info.get_icon());

            const uri = file.get_uri();
            const mime = info.get_content_type();
            const mtime = info.get_modification_date_time()?.to_unix() ?? 0;
            if (!thumbnailer || !mime || !thumbnailer.can_thumbnail(uri, mime, mtime) ||
                thumbnailer.has_valid_failed_thumbnail(uri, mtime))
                return;
            thumbnailer.generate_thumbnail_async(uri, mime, null, (_t, genRes) => {
                let pixbuf;
                try {
                    pixbuf = thumbnailer.generate_thumbnail_finish(genRes);
                } catch {
                    // Remember the failure so it isn't retried every time the shelf opens.
                    thumbnailer.create_failed_thumbnail_async(uri, mtime, null, null);
                    return;
                }
                thumbnailer.save_thumbnail_async(pixbuf, uri, mtime, null, (_s, saveRes) => {
                    try {
                        thumbnailer.save_thumbnail_finish(saveRes);
                        const saved = thumbnailer.lookup(uri, mtime);
                        if (saved)
                            image.set_from_file(saved);
                    } catch {
                        // The type icon stays.
                    }
                });
            });
        });
}

// MARK: - Window

class ShelfWindow {
    constructor(app, lang) {
        this.lang = lang;
        this.items = load();
        this.selected = new Set();
        this.hovering = false;
        this.pointerInside = false;
        this.peeking = false;
        this.hideId = 0;
        this.widgets = new Map();  // key -> item widget, rebuilt only when the items change
        this.itemsDirty = true;
        this.menuEntries = [];

        this.win = new Gtk.ApplicationWindow({
            application: app,
            title: 'NotchUser Shelf',
            decorated: false,
            resizable: false,
            default_width: 460,
            default_height: 140,
        });
        this.win.add_css_class('notchuser-shelf');
        this.win.set_hide_on_close(true);

        this.root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, css_classes: ['shelf']});

        const header = new Gtk.Box({spacing: 6});
        this.titleLabel = new Gtk.Label({xalign: 0, hexpand: true, css_classes: ['shelf-title']});
        this.trash = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat-btn']});
        this.trash.connect('clicked', () => this.clear());
        const close = new Gtk.Button({icon_name: 'window-close-symbolic', css_classes: ['flat-btn']});
        close.connect('clicked', () => this.win.set_visible(false));
        header.append(this.titleLabel);
        header.append(this.trash);
        header.append(close);

        // While something is carried in: "Drop here", plus how many are already kept.
        this.dropZone = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, css_classes: ['drop-zone']});
        this.dropLabel = new Gtk.Label();
        this.dropCount = new Gtk.Label({css_classes: ['drop-count']});
        this.dropZone.append(this.dropLabel);
        this.dropZone.append(this.dropCount);

        this.scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 84,
        });
        this.row = new Gtk.Box({spacing: 6});
        this.scroller.set_child(this.row);

        this.root.append(header);
        this.root.append(this.dropZone);
        this.root.append(this.scroller);
        this.win.set_child(this.root);

        // Files, links (text/uri-list) and plain text can all be dropped.
        const target = new Gtk.DropTarget({actions: Gdk.DragAction.COPY});
        target.set_gtypes([Gdk.FileList.$gtype, GObject.TYPE_STRING]);
        target.connect('enter', () => {
            this.hovering = true;
            this.render();
            return Gdk.DragAction.COPY;
        });
        target.connect('leave', () => {
            this.hovering = false;
            this.render();
        });
        target.connect('drop', (_t, value) => {
            this.hovering = false;
            this.accept(value);
            return true;
        });
        this.root.add_controller(target);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', () => { this.pointerInside = true; });
        motion.connect('leave', () => { this.pointerInside = false; });
        this.win.add_controller(motion);

        this.buildMenu();
        this.render();
    }

    accept(value) {
        const added = [];
        if (value instanceof Gdk.FileList) {
            for (const f of value.get_files()) {
                added.push(f.get_uri_scheme() === 'file'
                    ? {kind: 'file', value: f.get_path()}
                    : {kind: 'link', value: f.get_uri()});
            }
        } else if (typeof value === 'string' && value.trim()) {
            const t = value.trim();
            added.push(/^https?:\/\/\S+$/.test(t) ? {kind: 'link', value: t} : {kind: 'text', value});
        }
        for (const e of added) {
            if (!this.items.some(i => key(i) === key(e)))
                this.items.push(e);
        }
        this.commit();
        if (this.peeking)
            this.scheduleHide(2500);
    }

    /** Saves the items (the extension watches the file for its count) and redraws them. */
    commit() {
        save(this.items);
        this.itemsDirty = true;
        this.render();
    }

    render() {
        const t = (k, n) => tr(k, this.lang, n);
        const n = this.items.length;
        this.titleLabel.label = n ? `${t('shelf')} · ${n}` : t('shelf');
        this.trash.visible = n > 0 && !this.hovering;
        this.trash.tooltip_text = this.selected.size ? t('removeSelected') : t('clearShelf');
        if (this.hovering)
            this.root.add_css_class('drop-hover');
        else
            this.root.remove_css_class('drop-hover');
        this.dropLabel.label = this.hovering ? t('releaseNow') : t('dropHere');
        this.dropCount.label = t('alreadyOnShelf', n);
        this.dropCount.visible = this.hovering && n > 0;
        this.dropZone.visible = n === 0 || this.hovering;
        this.scroller.visible = n > 0 && !this.hovering;

        // Hovering a drag over the shelf only swaps the labels above; the items (and their
        // thumbnails, read from disk) are rebuilt only when the list itself changed.
        if (!this.itemsDirty)
            return;
        this.itemsDirty = false;
        let child;
        while ((child = this.row.get_first_child()))
            this.row.remove(child);
        this.widgets.clear();
        for (const e of this.items)
            this.row.append(this.itemWidget(e));
    }

    preview(e) {
        if (e.kind === 'text') {
            // A tiny page with the start of the text, like the Mac version.
            return new Gtk.Label({
                label: e.value.slice(0, 120),
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                xalign: 0,
                yalign: 0,
                width_request: 32,
                height_request: 38,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
                overflow: Gtk.Overflow.HIDDEN,
                css_classes: ['text-card'],
            });
        }
        const image = Gtk.Image.new_from_icon_name(e.kind === 'link' ? 'web-browser-symbolic' : 'text-x-generic');
        image.pixel_size = 44;
        if (e.kind === 'file')
            loadPreview(e.value, image);
        return image;
    }

    itemWidget(e) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            width_request: 68,
            css_classes: this.selected.has(key(e)) ? ['item', 'selected'] : ['item'],
            tooltip_text: e.value,
        });
        const preview = this.preview(e);
        const label = new Gtk.Label({
            label: title(e, this.lang),
            ellipsize: Pango.EllipsizeMode.MIDDLE,
            max_width_chars: 9,
            css_classes: ['item-label'],
        });
        box.append(preview);
        box.append(label);
        this.widgets.set(key(e), box);

        // Click selects, double-click opens (text is copied).
        const click = new Gtk.GestureClick();
        click.connect('released', (_g, n) => {
            if (n === 2)
                this.open(e);
            else
                this.toggle(e);
        });
        box.add_controller(click);

        // Right-click: the same menu as on the Mac.
        const secondary = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
        secondary.connect('pressed', (_g, _n, x, y) => this.showMenu(e, box, x, y));
        box.add_controller(secondary);

        // Dragging a selected entry carries the whole selection.
        const source = new Gtk.DragSource({actions: Gdk.DragAction.COPY});
        source.connect('prepare', () => this.provider(this.group(e)));
        source.connect('drag-begin', s => s.set_icon(Gtk.WidgetPaintable.new(preview), 22, 22));
        box.add_controller(source);

        // An × in the corner while the mouse is over the entry.
        const overlay = new Gtk.Overlay({child: box});
        const remove = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            css_classes: ['item-remove'],
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            visible: false,
            tooltip_text: tr('removeFromShelf', this.lang),
        });
        remove.connect('clicked', () => this.remove(new Set([key(e)])));
        overlay.add_overlay(remove);
        const hover = new Gtk.EventControllerMotion();
        hover.connect('enter', () => { remove.visible = true; });
        hover.connect('leave', () => { remove.visible = false; });
        overlay.add_controller(hover);
        return overlay;
    }

    // MARK: Item menu

    buildMenu() {
        const actions = new Gio.SimpleActionGroup();
        const add = (name, fn) => {
            const action = new Gio.SimpleAction({name});
            action.connect('activate', () => fn(this.menuEntries));
            actions.add_action(action);
        };
        add('open', entries => entries.forEach(e => this.open(e)));
        add('reveal', entries => this.reveal(entries[0]));
        add('copy', entries => this.copy(entries));
        add('select-all', () => this.setSelection(this.items.map(key)));
        add('deselect', () => this.setSelection([]));
        add('remove', entries => this.remove(new Set(entries.map(key))));
        this.win.insert_action_group('shelf', actions);

        // One popover for every entry, pointed at the one that was right-clicked.
        this.menu = new Gtk.PopoverMenu({has_arrow: false});
        this.menu.set_parent(this.root);
    }

    showMenu(e, widget, x, y) {
        const t = (k, n) => tr(k, this.lang, n);
        const group = this.group(e);
        const many = group.length > 1;
        this.menuEntries = group;

        const main = new Gio.Menu();
        main.append(many ? t('openN', group.length) : e.kind === 'text' ? t('copyText') : t('open'), 'shelf.open');
        if (e.kind === 'file' && !many)
            main.append(t('showInFolder'), 'shelf.reveal');
        main.append(many ? t('copyN', group.length) : t('copy'), 'shelf.copy');
        const selection = new Gio.Menu();
        if (this.selected.size < this.items.length)
            selection.append(t('selectAll'), 'shelf.select-all');
        if (this.selected.size)
            selection.append(t('deselect'), 'shelf.deselect');
        const removal = new Gio.Menu();
        removal.append(many ? t('removeN', group.length) : t('removeFromShelf'), 'shelf.remove');
        const model = new Gio.Menu();
        for (const section of [main, selection, removal])
            model.append_section(null, section);
        this.menu.set_menu_model(model);

        const [, at] = widget.compute_point(this.root, new Graphene.Point({x, y}));
        this.menu.set_pointing_to(new Gdk.Rectangle({x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1}));
        this.menu.popup();
    }

    // MARK: Actions

    group(e) {
        return this.selected.has(key(e)) ? this.items.filter(i => this.selected.has(key(i))) : [e];
    }

    provider(entries) {
        const providers = [];
        const files = entries.filter(e => e.kind !== 'text')
            .map(e => e.kind === 'file' ? Gio.File.new_for_path(e.value) : Gio.File.new_for_uri(e.value));
        if (files.length) {
            const v = new GObject.Value();
            v.init(Gdk.FileList.$gtype);
            v.set_boxed(Gdk.FileList.new_from_array(files));
            providers.push(Gdk.ContentProvider.new_for_value(v));
        }
        // Plain text too, for apps that only take text (chat boxes, editors).
        providers.push(Gdk.ContentProvider.new_for_value(stringValue(entries.map(e => e.value).join('\n'))));
        return Gdk.ContentProvider.new_union(providers);
    }

    toggle(e) {
        const k = key(e);
        const w = this.widgets.get(k);
        if (this.selected.has(k)) {
            this.selected.delete(k);
            w?.remove_css_class('selected');
        } else {
            this.selected.add(k);
            w?.add_css_class('selected');
        }
        this.render();
    }

    setSelection(keys) {
        this.selected = new Set(keys);
        for (const [k, w] of this.widgets) {
            if (this.selected.has(k))
                w.add_css_class('selected');
            else
                w.remove_css_class('selected');
        }
        this.render();
    }

    open(e) {
        if (e.kind === 'text') {
            this.copy([e]);
            return;
        }
        const uri = e.kind === 'file' ? Gio.File.new_for_path(e.value).get_uri() : e.value;
        Gio.AppInfo.launch_default_for_uri(uri, null);
    }

    /** Copies files as files (paste into Files) and as text (paste into a chat box). */
    copy(entries) {
        this.win.get_clipboard().set_content(entries.length === 1 && entries[0].kind === 'text'
            ? Gdk.ContentProvider.new_for_value(stringValue(entries[0].value))
            : this.provider(entries));
    }

    /** Opens the file manager with the file selected (Files, Nemo, Dolphin… all speak this). */
    reveal(e) {
        const file = Gio.File.new_for_path(e.value);
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch {
                    // No file manager on the bus: at least open the folder.
                    Gio.AppInfo.launch_default_for_uri(file.get_parent().get_uri(), null);
                }
            });
    }

    remove(keys) {
        this.items = this.items.filter(i => !keys.has(key(i)));
        keys.forEach(k => this.selected.delete(k));
        this.commit();
    }

    /** With a selection the trash removes just that, otherwise everything. */
    clear() {
        this.remove(this.selected.size ? new Set(this.selected) : new Set(this.items.map(key)));
    }

    show(peek) {
        this.peeking = peek;
        const items = load();
        if (JSON.stringify(items) !== JSON.stringify(this.items)) {
            this.items = items;
            this.itemsDirty = true;
        }
        this.render();
        this.win.present();
        if (peek) {
            this.scheduleHide(4000);
        } else if (this.hideId) {
            GLib.source_remove(this.hideId);
            this.hideId = 0;
        }
    }

    /** Hides a peeked shelf once the mouse isn't on it (keeps it while the user is busy there). */
    scheduleHide(ms) {
        if (this.hideId)
            GLib.source_remove(this.hideId);
        this.hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this.hideId = 0;
            if (this.pointerInside || this.hovering || this.menu.visible)
                this.scheduleHide(1200);
            else
                this.win.set_visible(false);
            return GLib.SOURCE_REMOVE;
        });
    }
}

// MARK: - App (single instance: later launches just pass their command along)

const app = new Gtk.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE});
let shelf = null;

app.connect('startup', () => {
    const css = new Gtk.CssProvider();
    if (css.load_from_string)
        css.load_from_string(CSS);
    else
        css.load_from_data(CSS, -1);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    app.hold();  // stay alive while hidden, so the next show is instant

    // The extension sends commands as actions on D-Bus, with the language as parameter.
    for (const name of ['show', 'peek', 'hide', 'toggle', 'start', 'quit']) {
        const action = new Gio.SimpleAction({name, parameter_type: new GLib.VariantType('s')});
        action.connect('activate', (_a, param) => handle(name, param?.unpack() ?? 'system'));
        app.add_action(action);
    }
});

function handle(cmd, lang) {
    shelf ??= new ShelfWindow(app, resolveLang(lang));
    shelf.lang = resolveLang(lang);
    switch (cmd) {
    case 'start':
        // Just get ready (window built, nothing shown) so the first peek is instant.
        break;
    case 'peek':
        shelf.show(true);
        break;
    case 'hide':
        shelf.win.set_visible(false);
        break;
    case 'toggle':
        if (shelf.win.visible)
            shelf.win.set_visible(false);
        else
            shelf.show(false);
        break;
    case 'quit':
        app.release();
        app.quit();
        break;
    default:
        shelf.show(false);
    }
}

app.connect('command-line', (_app, cmdline) => {
    const [, cmd = 'show', lang = 'system'] = cmdline.get_arguments();
    handle(cmd, lang);
    return 0;
});

app.run([System.programInvocationName, ...System.programArgs]);
