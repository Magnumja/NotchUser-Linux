// NotchUser for GNOME: a black pill in the middle of the top bar showing what's playing
// (cover, title, bars in the album's color), with a translucent panel on hover or click
// (cover, progress, controls, player switcher). Same idea as the Mac version.
// Music comes from MPRIS, the D-Bus standard that Spotify, browsers, VLC… all speak.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {resolveLang, tr} from './strings.js';

/** Setting a label to the text it already has still costs a relayout; skip it. */
function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}

function clock(seconds) {
    const t = Math.max(0, Math.floor(seconds));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// St.BoxLayout got `orientation` in GNOME 48; older versions only have `vertical`.
function vbox(params) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

/** Album color, brightened so it stays visible on black (same rule as the Mac version). */
function brighten(r, g, b) {
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r / 255)
            h = ((g - b) / 255 / d) % 6;
        else if (max === g / 255)
            h = (b - r) / 255 / d + 2;
        else
            h = (r - g) / 255 / d + 4;
    }
    h = (h * 60 + 360) % 360;
    const s = Math.min((max === 0 ? 0 : d / max) * 1.3, 1);
    const v = Math.max(max, 0.8);
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r1, g1, b1].map(v1 => Math.round((v1 + m) * 255));
}

// MARK: - MPRIS

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg type="o" direction="in"/>
      <arg type="x" direction="in"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`);

const RootProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

/** One MPRIS player on the session bus. */
class Player {
    constructor(busName, onChange, onTrack) {
        this.busName = busName;
        this._onChange = onChange;
        this._onTrack = onTrack;
        this.title = '';
        this.artist = '';
        this.artUrl = '';
        this.length = 0;
        this.trackId = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
        this.playing = false;
        this.startedAt = 0;
        this.position = 0;
        this.positionAt = 0;
        this._trackKey = '';

        this._root = new RootProxy(Gio.DBus.session, busName, MPRIS_PATH, (_p, error) => {
            if (!error)
                this._onChange();
        });
        this._player = new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (_p, error) => {
            if (error)
                return;
            this._propsId = this._player.connect('g-properties-changed', () => this._update());
            this._update();
        });
    }

    _update() {
        const playing = this._player.PlaybackStatus === 'Playing';
        if (playing && !this.playing)
            this.startedAt = GLib.get_monotonic_time();
        this.playing = playing;

        const md = this._player.Metadata ?? {};
        const get = key => md[key]?.deepUnpack();
        this.title = get('xesam:title') ?? '';
        const artist = get('xesam:artist');
        this.artist = Array.isArray(artist) ? artist.join(', ') : artist ?? '';
        this.artUrl = get('mpris:artUrl') ?? '';
        this.length = Number(get('mpris:length') ?? 0) / 1e6;
        this.trackId = get('mpris:trackid') ?? this.trackId;

        const key = `${this.title}|${this.artist}`;
        const changed = this._trackKey && key !== this._trackKey;
        this._trackKey = key;
        this._onChange();
        if (changed)
            this._onTrack(this);
    }

    get name() {
        return this._root?.Identity || this.busName.slice(MPRIS_PREFIX.length).split('.')[0];
    }

    get appIcon() {
        const entry = this._root?.DesktopEntry;
        const info = entry ? Gio.DesktopAppInfo.new(`${entry}.desktop`) : null;
        return info?.get_icon() ?? Gio.ThemedIcon.new('audio-x-generic-symbolic');
    }

    get canSeek() {
        return Boolean(this._player?.CanSeek) && this.length > 0;
    }

    /** Position isn't announced through signals, so it is asked for when needed. */
    fetchPosition(callback) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    this.position = Number(v.deepUnpack()) / 1e6;
                    this.positionAt = GLib.get_monotonic_time();
                    callback(this.position);
                } catch {
                    // Some players don't report a position; the bar just stays put.
                }
            });
    }

    playPause() { this._player?.PlayPauseRemote(); }
    next() { this._player?.NextRemote(); }
    previous() { this._player?.PreviousRemote(); }
    seek(seconds) {
        this._player?.SetPositionRemote(this.trackId, Math.round(seconds * 1e6));
        this.position = seconds;
        this.positionAt = GLib.get_monotonic_time();
    }

    /** Where the song is now, moving on from the last read while it plays. */
    get livePosition() {
        const elapsed = this.playing && this.positionAt ? (GLib.get_monotonic_time() - this.positionAt) / 1e6 : 0;
        return Math.min(this.position + elapsed, this.length || Infinity);
    }
    raise() { this._root?.RaiseRemote(); }

    destroy() {
        if (this._propsId)
            this._player.disconnect(this._propsId);
    }
}

/** Every MPRIS player on the bus, and which one the pill shows. */
class Players {
    constructor(onChange, onTrack) {
        this._onChange = onChange;
        this._onTrack = onTrack;
        this._players = new Map();
        this._pinned = null;
        this._pinnedAt = 0;
        this._selected = null;

        this._signalId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (newOwner && !oldOwner)
                    this._add(name);
                else if (oldOwner && !newOwner)
                    this._remove(name);
            });

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._add(n));
                } catch (e) {
                    console.error(`NotchUser: ${e}`);
                }
            });
    }

    _add(name) {
        // playerctld only mirrors other players; showing it would duplicate them.
        if (this._players.has(name) || name === `${MPRIS_PREFIX}playerctld`)
            return;
        this._players.set(name, new Player(name, () => this._onChange(),
            p => p === this.current && this._onTrack()));
    }

    _remove(name) {
        this._players.get(name)?.destroy();
        this._players.delete(name);
        this._onChange();
    }

    get all() {
        return [...this._players.values()].filter(p => p.title);
    }

    /** The pinned player, else the one that most recently started playing, else the last shown. */
    get current() {
        const all = this.all;
        const pinned = all.find(p => p.busName === this._pinned);
        // A pin lasts until another player starts after it.
        if (pinned && !all.some(p => p !== pinned && p.playing && p.startedAt > this._pinnedAt))
            return pinned;
        this._pinned = null;
        const playing = all.filter(p => p.playing).sort((a, b) => b.startedAt - a.startedAt)[0];
        const pick = playing ?? all.find(p => p.busName === this._selected) ?? all[0] ?? null;
        this._selected = pick?.busName ?? null;
        return pick;
    }

    pin(player) {
        this._pinned = player.busName;
        this._pinnedAt = GLib.get_monotonic_time();
        this._onChange();
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._signalId);
        this._players.forEach(p => p.destroy());
        this._players.clear();
    }
}

// MARK: - UI

function coverIcon(url) {
    if (url)
        return new Gio.FileIcon({file: Gio.File.new_for_uri(url)});
    return Gio.ThemedIcon.new('audio-x-generic-symbolic');
}

function iconButton(iconName, size, styleClass, onClick) {
    const button = new St.Button({
        style_class: `notchuser-button ${styleClass}`,
        can_focus: true,
        child: new St.Icon({icon_name: iconName, icon_size: size}),
    });
    button.connect('clicked', onClick);
    return button;
}

const CENTER = new Graphene.Point({x: 0.5, y: 0.5});

/** Real frosted glass: the same blur GNOME uses for the overview and the lock screen. */
function makeBlur() {
    const blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 0.6});
    // GNOME 46 renamed `sigma` to `radius`.
    if ('radius' in blur)
        blur.radius = 36;
    else
        blur.sigma = 18;
    return blur;
}

// MARK: - Shelf

const SHELF_APP_ID = 'io.github.magnumja.NotchUserShelf';
const SHELF_PATH = '/io/github/magnumja/NotchUserShelf';
const SHELF_FILE = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchuser', 'shelf.json']);

/**
 * Extensions can't receive files dropped from apps, so the shelf is a small GTK window
 * (shelf.js). This launches it, places it under the pill (on Wayland apps can't place
 * themselves) and pops it up whenever something is dragged toward the top bar.
 */
class ShelfBridge {
    constructor(extension, onCount) {
        this._extension = extension;
        this._onCount = onCount;
        this.count = 0;

        // The shelf saves its items to a file; watching it gives the count for the pill.
        this._file = Gio.File.new_for_path(SHELF_FILE);
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', () => this._readCount());
        this._readCount();

        this._windowId = global.display.connect('window-created', (_d, win) => this._place(win));

        // Once the shelf runs, commands go straight to it over D-Bus (instant) instead of
        // starting a new gjs process each time.
        this._running = false;
        this._busWatchId = Gio.bus_watch_name(Gio.BusType.SESSION, SHELF_APP_ID, Gio.BusNameWatcherFlags.NONE,
            () => {
                this._running = true;
                this._starting = false;
            },
            () => {
                this._running = false;
                this._actions = null;
            });

        // While any app drags something, watch where the pointer goes.
        this._dragIds = [
            Main.xdndHandler.connect('drag-begin', () => this._startDragWatch()),
            Main.xdndHandler.connect('drag-end', () => this._stopDragWatch()),
        ];
    }

    run(cmd) {
        const lang = this._extension.settings.get_string('language');
        if (this._running) {
            this._actions ??= Gio.DBusActionGroup.get(Gio.DBus.session, SHELF_APP_ID, SHELF_PATH);
            this._actions.activate_action(cmd, new GLib.Variant('s', lang));
            return;
        }
        try {
            Gio.Subprocess.new(['gjs', '-m', `${this._extension.path}/shelf.js`, cmd, lang], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`NotchUser: could not start the shelf: ${e}`);
        }
    }

    _readCount() {
        let count = 0;
        try {
            const [, bytes] = this._file.load_contents(null);
            count = JSON.parse(new TextDecoder().decode(bytes)).length;
        } catch {
            // No shelf file yet.
        }
        const grew = count > this.count;
        this.count = count;
        this._onCount(grew);
    }

    /** Start the shelf hidden as soon as a drag begins, so it's ready by the time it's needed. */
    _prewarm() {
        if (!this._running && !this._starting) {
            this._starting = true;
            this.run('start');
        }
    }

    _startDragWatch() {
        this._stopDragWatch();
        this._prewarm();
        let peeked = false;
        this._dragWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const [x, y] = global.get_pointer();
            const m = Main.layoutManager.primaryMonitor;
            // Near the pill, but well before the very top edge.
            const near = y < m.y + Main.panel.height + 220 && Math.abs(x - (m.x + m.width / 2)) < 340;
            if (near && !peeked) {
                peeked = true;
                this.run('peek');
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopDragWatch() {
        if (this._dragWatchId) {
            GLib.source_remove(this._dragWatchId);
            this._dragWatchId = 0;
        }
    }

    _place(win) {
        if (win.get_wm_class() !== SHELF_APP_ID && win.get_title() !== 'NotchUser Shelf')
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._extension.settings)  // the extension was turned off meanwhile
                return GLib.SOURCE_REMOVE;
            const m = Main.layoutManager.primaryMonitor;
            const r = win.get_frame_rect();
            win.move_frame(true, m.x + Math.round((m.width - r.width) / 2), m.y + Main.panel.height + 8);
            win.make_above();
            win.stick();
            const actor = win.get_compositor_private();
            if (actor && this._extension.settings.get_boolean('blur') && !actor.get_effect('notchuser-blur'))
                actor.add_effect_with_name('notchuser-blur', makeBlur());
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._stopDragWatch();
        this._dragIds.forEach(id => Main.xdndHandler.disconnect(id));
        global.display.disconnect(this._windowId);
        this._monitor.disconnect(this._monitorId);
        this._monitor.cancel();
        if (this._running)
            this.run('quit');
        Gio.bus_unwatch_name(this._busWatchId);
    }
}

const NotchIndicator = GObject.registerClass(
class NotchIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'NotchUser', false);
        this._extension = extension;
        this._settings = extension.settings;
        this._players = extension.players;
        this._accentUrl = null;
        this.add_style_class_name('notchuser-indicator');

        this._buildPill();
        this._buildPanel();

        this._settingsIds = [
            this._settings.connect('changed::language', () => this._applyLanguage()),
            this._settings.connect('changed::show-title', () => this.sync()),
            this._settings.connect('changed::blur', () => this._applyBlur()),
        ];
        this.menu.connect('open-state-changed', (_m, open) => this._menuToggled(open));
        this.connect('enter-event', () => this._hoverEnter());
        this.connect('leave-event', () => this._clearHoverDelay());

        this._applyLanguage();
        this.sync();
    }

    // MARK: Pill (the "notch" in the top bar)

    _buildPill() {
        this._pill = new St.BoxLayout({style_class: 'notchuser-pill', y_align: Clutter.ActorAlign.CENTER, pivot_point: CENTER});
        this._pillCover = new St.Icon({style_class: 'notchuser-pill-cover', icon_size: 16});
        this._pillLabel = new St.Label({style_class: 'notchuser-pill-label', y_align: Clutter.ActorAlign.CENTER});
        this._pillLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._pillPause = new St.Icon({style_class: 'notchuser-pill-pause', icon_name: 'media-playback-pause-symbolic', icon_size: 12});

        // Four little bars in the album's color, bouncing while music plays.
        this._bars = new St.BoxLayout({style_class: 'notchuser-bars', y_align: Clutter.ActorAlign.CENTER});
        this._barActors = [];
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({style_class: 'notchuser-bar', y_align: Clutter.ActorAlign.CENTER, pivot_point: CENTER});
            bar.scale_y = 0.35;
            this._bars.add_child(bar);
            this._barActors.push(bar);
        }

        this._pill.add_child(this._pillCover);
        this._pill.add_child(this._pillLabel);
        this._pill.add_child(this._bars);
        this._pill.add_child(this._pillPause);

        // Nothing playing but things on the shelf: a tray and the count, like the Mac notch.
        this._pillShelf = new St.BoxLayout({style_class: 'notchuser-pill-shelf', y_align: Clutter.ActorAlign.CENTER});
        this._pillShelf.add_child(new St.Icon({icon_name: 'folder-symbolic', icon_size: 13}));
        this._pillShelfCount = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._pillShelf.add_child(this._pillShelfCount);
        this._pill.add_child(this._pillShelf);
        this.add_child(this._pill);
    }

    _setBarsPlaying(playing) {
        if (playing === Boolean(this._barsId))
            return;
        if (playing) {
            // Each ease lasts exactly one interval, so the bars never stop between steps.
            this._barsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 240, () => {
                if (Main.sessionMode.isLocked || global.display.get_monitor_in_fullscreen(Main.layoutManager.primaryIndex))
                    return GLib.SOURCE_CONTINUE;
                for (const bar of this._barActors) {
                    bar.ease({
                        scale_y: 0.3 + Math.random() * 0.7,
                        duration: 240,
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    });
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            GLib.source_remove(this._barsId);
            this._barsId = 0;
            for (const bar of this._barActors) {
                bar.remove_all_transitions();
                bar.scale_y = 0.35;
            }
        }
    }

    /** Quick squash-and-stretch when the song changes, like the Mac notch. */
    bump() {
        if (!this._settings.get_boolean('bump-on-change') || !this.container.visible)
            return;
        this._pill.remove_all_transitions();
        this._pill.ease({
            scale_x: 1.1,
            scale_y: 1.18,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._pill.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 420,
                mode: Clutter.AnimationMode.EASE_OUT_ELASTIC,
            }),
        });
    }

    /** A little shake when something lands on the shelf (Linux laptops can't vibrate). */
    wiggle() {
        if (!this.container.visible)
            return;
        const steps = [6, -6, 4, -4, 2, 0];
        let i = 0;
        const next = () => {
            if (i < steps.length) {
                this._pill.ease({
                    translation_x: steps[i++],
                    duration: 45,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: next,
                });
            }
        };
        next();
    }

    // MARK: Panel

    _buildPanel() {
        this.menu.actor.add_style_class_name('notchuser-menu');
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('notchuser-card');
        const card = vbox({style_class: 'notchuser-card-box', x_expand: true});
        item.add_child(card);
        this.menu.addMenuItem(item);

        // Cover and title/artist.
        this._header = new St.BoxLayout({style_class: 'notchuser-header'});
        this._cover = new St.Icon({style_class: 'notchuser-cover', icon_size: 56});
        const coverButton = new St.Button({child: this._cover, style_class: 'notchuser-cover-button'});
        coverButton.connect('clicked', () => {
            this._players.current?.raise();
            this.menu.close();
        });
        const texts = vbox({style_class: 'notchuser-texts', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._title = new St.Label({style_class: 'notchuser-title'});
        this._artist = new St.Label({style_class: 'notchuser-artist'});
        for (const label of [this._title, this._artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(label);
        }
        this._header.add_child(coverButton);
        this._header.add_child(texts);
        card.add_child(this._header);

        // Elapsed, draggable bar, remaining.
        this._progress = new St.BoxLayout({style_class: 'notchuser-progress'});
        this._elapsed = new St.Label({style_class: 'notchuser-time', y_align: Clutter.ActorAlign.CENTER});
        this._remaining = new St.Label({style_class: 'notchuser-time notchuser-time-end', y_align: Clutter.ActorAlign.CENTER});
        this._slider = new Slider.Slider(0);
        this._slider.x_expand = true;
        this._slider.add_style_class_name('notchuser-slider');
        // GNOME's slider has no public "is dragging" flag, so track it to keep the
        // position updates from yanking the knob while the user drags it.
        this._sliding = false;
        this._slider.connect('drag-begin', () => { this._sliding = true; });
        this._slider.connect('drag-end', () => {
            this._sliding = false;
            const p = this._players.current;
            if (p?.canSeek)
                p.seek(this._slider.value * p.length);
        });
        this._progress.add_child(this._elapsed);
        this._progress.add_child(this._slider);
        this._progress.add_child(this._remaining);
        card.add_child(this._progress);

        // Settings on the left, transport in the middle, player icons on the right (as on the Mac).
        this._controlsRow = new St.BoxLayout({style_class: 'notchuser-controls-row', x_expand: true});
        const left = new St.BoxLayout({style_class: 'notchuser-side', x_expand: true, x_align: Clutter.ActorAlign.START});
        this._gear = iconButton('emblem-system-symbolic', 15, 'notchuser-gear', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        this._shelfButton = iconButton('folder-symbolic', 15, 'notchuser-gear', () => {
            this.menu.close();
            this._extension.shelf.run('toggle');
        });
        left.add_child(this._shelfButton);
        left.add_child(this._gear);
        const controls = new St.BoxLayout({style_class: 'notchuser-controls', x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(iconButton('media-skip-backward-symbolic', 20, '', () => this._players.current?.previous()));
        this._playButton = iconButton('media-playback-start-symbolic', 26, 'notchuser-play',
            () => this._players.current?.playPause());
        controls.add_child(this._playButton);
        controls.add_child(iconButton('media-skip-forward-symbolic', 20, '', () => this._players.current?.next()));
        this._sources = new St.BoxLayout({style_class: 'notchuser-side notchuser-sources', x_expand: true, x_align: Clutter.ActorAlign.END});
        this._controlsRow.add_child(left);
        this._controlsRow.add_child(controls);
        this._controlsRow.add_child(this._sources);
        card.add_child(this._controlsRow);

        this._empty = vbox({style_class: 'notchuser-empty', x_align: Clutter.ActorAlign.CENTER});
        this._emptyTitle = new St.Label({style_class: 'notchuser-title', x_align: Clutter.ActorAlign.CENTER});
        this._emptyHint = new St.Label({style_class: 'notchuser-artist', x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this._emptyShelf = new St.Button({style_class: 'notchuser-empty-button', x_align: Clutter.ActorAlign.CENTER});
        this._emptyShelf.connect('clicked', () => {
            this.menu.close();
            this._extension.shelf.run('show');
        });
        this._empty.add_child(this._emptyShelf);
        card.add_child(this._empty);

        this._applyBlur();
    }

    /** Frosted glass behind the panel; the tint gets lighter so the blur shows through. */
    _applyBlur() {
        const on = this._settings.get_boolean('blur');
        const has = Boolean(this.menu.box.get_effect('notchuser-blur'));
        if (on && !has)
            this.menu.box.add_effect_with_name('notchuser-blur', makeBlur());
        else if (!on && has)
            this.menu.box.remove_effect_by_name('notchuser-blur');
        if (on)
            this.menu.actor.add_style_class_name('notchuser-blurred');
        else
            this.menu.actor.remove_style_class_name('notchuser-blurred');
        this._setAccent(this._accentRGB ?? null);
    }

    _applyLanguage() {
        const lang = resolveLang(this._settings.get_string('language'));
        this._emptyTitle.text = tr('nothingPlaying', lang);
        this._emptyHint.text = tr('hint', lang);
        this._gear.accessible_name = tr('settings', lang);
        this._shelfButton.accessible_name = tr('shelf', lang);
        this._emptyShelf.label = tr('openShelf', lang);
    }

    /** Middle-click on the pill toggles play/pause without opening the panel. */
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_MIDDLE) {
            this._players.current?.playPause();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    sync() {
        const p = this._players.current;
        const shelfCount = this._extension.shelf?.count ?? 0;
        // Hidden while there's nothing to show, like an empty notch.
        this.container.visible = Boolean(p) || shelfCount > 0;
        for (const a of [this._header, this._progress, this._controlsRow])
            a.visible = Boolean(p);
        this._empty.visible = !p;
        this._pillShelf.visible = !p && shelfCount > 0;
        setText(this._pillShelfCount, String(shelfCount));
        for (const a of [this._pillCover, this._pillLabel, this._bars, this._pillPause])
            a.visible = Boolean(p);
        if (!p) {
            this._setBarsPlaying(false);
            return;
        }
        this._pillCover.visible = true;

        // A new icon object makes St reload the texture, so only swap it when the art changes.
        if (p.artUrl !== this._shownArt) {
            this._shownArt = p.artUrl;
            const cover = coverIcon(p.artUrl);
            this._pillCover.gicon = cover;
            this._cover.gicon = cover;
        }
        setText(this._pillLabel, p.title);
        this._pillLabel.visible = this._settings.get_boolean('show-title');
        this._bars.visible = p.playing;
        this._pillPause.visible = !p.playing;
        this._setBarsPlaying(p.playing);

        setText(this._title, p.title);
        setText(this._artist, p.artist);
        this._artist.visible = Boolean(p.artist);
        this._playButton.child.icon_name = p.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._progress.visible = p.length > 0;
        this._slider.reactive = p.canSeek;
        this._updateTime(p);
        this._rebuildSources(p);
        this._loadAccent(p.artUrl);
    }

    // MARK: Album color

    _loadAccent(url) {
        if (url === this._accentUrl)
            return;
        this._accentUrl = url;
        if (!url) {
            this._setAccent(null);
            return;
        }
        Gio.File.new_for_uri(url).load_contents_async(null, (file, res) => {
            if (this._destroyed || this._accentUrl !== url)
                return;
            try {
                const [, bytes] = file.load_contents_finish(res);
                const loader = new GdkPixbuf.PixbufLoader();
                loader.connect('size-prepared', l => l.set_size(16, 16));
                loader.write(bytes);
                loader.close();
                const px = loader.get_pixbuf().scale_simple(1, 1, GdkPixbuf.InterpType.BILINEAR).get_pixels();
                this._setAccent(brighten(px[0], px[1], px[2]));
            } catch {
                this._setAccent(null);
            }
        });
    }

    _setAccent(rgb) {
        this._accentRGB = rgb;
        const [r, g, b] = rgb ?? [255, 255, 255];
        const end = this._settings.get_boolean('blur') ? 0.5 : 0.92;
        for (const bar of this._barActors)
            bar.style = `background-color: rgb(${r}, ${g}, ${b});`;
        // The panel glass picks up a tint of the cover, fading into dark at the bottom.
        this.menu.box.style = rgb
            ? `background-gradient-direction: vertical; background-gradient-start: rgba(${r}, ${g}, ${b}, 0.28); background-gradient-end: rgba(18, 18, 22, ${end});`
            : null;
    }

    _updateTime(p) {
        if (!(p?.length > 0))
            return;
        const pos = p.livePosition;
        if (!this._sliding)
            this._slider.value = pos / p.length;
        setText(this._elapsed, clock(pos));
        setText(this._remaining, `-${clock(p.length - pos)}`);
    }

    _rebuildSources(current) {
        const all = this._players.all;
        const signature = all.map(p => `${p.busName}:${p === current}:${p.playing}`).join('|');
        if (signature === this._sourcesSignature)
            return;
        this._sourcesSignature = signature;
        this._sources.destroy_all_children();
        for (const p of all) {
            const selected = p === current;
            const button = new St.Button({
                style_class: `notchuser-source${selected ? ' selected' : ''}${p.playing ? ' playing' : ''}`,
                child: new St.Icon({gicon: p.appIcon, icon_size: 18}),
                accessible_name: p.name,
            });
            button.connect('clicked', () => {
                if (selected) {
                    p.raise();
                    this.menu.close();
                } else {
                    this._players.pin(p);
                }
            });
            this._sources.add_child(button);
        }
    }

    // MARK: Hover to open (like the Mac notch)

    _hoverEnter() {
        if (!this._settings.get_boolean('hover-open') || this.menu.isOpen || this._hoverDelayId)
            return;
        // A short delay so passing the mouse along the top bar doesn't pop it open.
        this._hoverDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
            this._hoverDelayId = 0;
            if (this.hover && !this.menu.isOpen) {
                this._openedByHover = true;
                this.menu.open();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHoverDelay() {
        if (this._hoverDelayId) {
            GLib.source_remove(this._hoverDelayId);
            this._hoverDelayId = 0;
        }
    }

    /** Closes a hover-opened panel once the mouse has left both the pill and the panel for a moment. */
    _watchPointer() {
        let outsideFor = 0;
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            const [x, y] = global.get_pointer();
            const point = new Graphene.Point({x, y});
            const inside = [this, this.menu.actor].some(a => a.get_transformed_extents().contains_point(point));
            outsideFor = inside ? 0 : outsideFor + 120;
            if (outsideFor >= 360) {
                this._watchId = 0;
                this.menu.close();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _menuToggled(open) {
        if (open) {
            this._startTicking();
            if (this._openedByHover)
                this._watchPointer();
        } else {
            this._stopTicking();
            this._openedByHover = false;
            if (this._watchId) {
                GLib.source_remove(this._watchId);
                this._watchId = 0;
            }
        }
    }

    // Position is only polled while the panel is open: nothing runs in the background.
    // The bar glides 4 times a second from the last known position; the player itself is
    // only asked every 2 seconds to correct any drift.
    _startTicking() {
        this._stopTicking();
        let n = 0;
        const tick = () => {
            const p = this._players.current;
            if (p && n++ % 8 === 0)
                p.fetchPosition(() => this._updateTime(p));
            else
                this._updateTime(p);
            return GLib.SOURCE_CONTINUE;
        };
        tick();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, tick);
    }

    _stopTicking() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        this._stopTicking();
        this._clearHoverDelay();
        this._setBarsPlaying(false);
        if (this._watchId)
            GLib.source_remove(this._watchId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        super.destroy();
    }
});

export default class NotchUserExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.players = new Players(() => this._indicator?.sync(), () => this._indicator?.bump());
        this.shelf = new ShelfBridge(this, grew => {
            this._indicator?.sync();
            if (grew)
                this._indicator?.wiggle();
        });
        this._indicator = new NotchIndicator(this);
        // First slot of the center box: right next to the clock, under the camera on laptops.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this.players?.destroy();
        this.players = null;
        this.shelf?.destroy();
        this.shelf = null;
        this.settings = null;
    }
}
