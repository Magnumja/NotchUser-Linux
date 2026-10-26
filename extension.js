// NotchUser for GNOME: a pill in the middle of the top bar showing what's playing,
// with a translucent panel (cover, progress, controls, player switcher) on click.
// Music comes from MPRIS, the D-Bus standard that Spotify, browsers, VLC… all speak.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

// MARK: - Language

const STRINGS = {
    nothingPlaying: {en: 'Nothing playing', pt: 'Nada tocando', es: 'No suena nada'},
    hint: {
        en: 'Play something in Spotify, Firefox, Chrome…',
        pt: 'Toque algo no Spotify, Firefox, Chrome…',
        es: 'Reproduce algo en Spotify, Firefox, Chrome…',
    },
};

const LANG = (() => {
    for (const name of GLib.get_language_names()) {
        const code = name.slice(0, 2);
        if (['en', 'pt', 'es'].includes(code))
            return code;
    }
    return 'en';
})();

function _(key) {
    return STRINGS[key][LANG] ?? STRINGS[key].en;
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
    constructor(busName, onChange) {
        this.busName = busName;
        this._onChange = onChange;
        this.title = '';
        this.artist = '';
        this.artUrl = '';
        this.length = 0;
        this.trackId = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
        this.playing = false;
        this.startedAt = 0;
        this.position = 0;

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
        this._onChange();
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
                    callback(this.position);
                } catch {
                    // Some players don't report a position; the bar just stays put.
                }
            });
    }

    playPause() { this._player?.PlayPauseRemote(); }
    next() { this._player?.NextRemote(); }
    previous() { this._player?.PreviousRemote(); }
    seek(seconds) { this._player?.SetPositionRemote(this.trackId, Math.round(seconds * 1e6)); }
    raise() { this._root?.RaiseRemote(); }

    destroy() {
        if (this._propsId)
            this._player.disconnect(this._propsId);
    }
}

/** Every MPRIS player on the bus, and which one the pill shows. */
class Players {
    constructor(onChange) {
        this._onChange = onChange;
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
        this._players.set(name, new Player(name, () => this._onChange()));
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

const NotchIndicator = GObject.registerClass(
class NotchIndicator extends PanelMenu.Button {
    _init(players) {
        super._init(0.5, 'NotchUser', false);
        this._players = players;
        this.add_style_class_name('notchuser-indicator');

        // The pill in the top bar.
        const pill = new St.BoxLayout({style_class: 'notchuser-pill', y_align: Clutter.ActorAlign.CENTER});
        this._pillCover = new St.Icon({style_class: 'notchuser-pill-cover', icon_size: 16});
        this._pillLabel = new St.Label({style_class: 'notchuser-pill-label', y_align: Clutter.ActorAlign.CENTER});
        this._pillLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._pillState = new St.Icon({style_class: 'notchuser-pill-state', icon_size: 12});
        pill.add_child(this._pillCover);
        pill.add_child(this._pillLabel);
        pill.add_child(this._pillState);
        this.add_child(pill);

        // The panel that drops down from it.
        this.menu.actor.add_style_class_name('notchuser-menu');
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('notchuser-card');
        const card = vbox({style_class: 'notchuser-card-box', x_expand: true});
        item.add_child(card);
        this.menu.addMenuItem(item);

        this._header = new St.BoxLayout({style_class: 'notchuser-header'});
        this._cover = new St.Icon({style_class: 'notchuser-cover', icon_size: 64});
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

        this._progress = new St.BoxLayout({style_class: 'notchuser-progress'});
        this._elapsed = new St.Label({style_class: 'notchuser-time', y_align: Clutter.ActorAlign.CENTER});
        this._remaining = new St.Label({style_class: 'notchuser-time', y_align: Clutter.ActorAlign.CENTER});
        this._slider = new Slider.Slider(0);
        this._slider.x_expand = true;
        this._slider.add_style_class_name('notchuser-slider');
        this._slider.connect('drag-end', () => {
            const p = this._players.current;
            if (p?.canSeek)
                p.seek(this._slider.value * p.length);
        });
        this._progress.add_child(this._elapsed);
        this._progress.add_child(this._slider);
        this._progress.add_child(this._remaining);
        card.add_child(this._progress);

        this._controls = new St.BoxLayout({style_class: 'notchuser-controls', x_align: Clutter.ActorAlign.CENTER});
        this._controls.add_child(iconButton('media-skip-backward-symbolic', 20, '', () => this._players.current?.previous()));
        this._playButton = iconButton('media-playback-start-symbolic', 26, 'notchuser-play',
            () => this._players.current?.playPause());
        this._controls.add_child(this._playButton);
        this._controls.add_child(iconButton('media-skip-forward-symbolic', 20, '', () => this._players.current?.next()));
        card.add_child(this._controls);

        // One icon per player; click to show it.
        this._sources = new St.BoxLayout({style_class: 'notchuser-sources', x_align: Clutter.ActorAlign.CENTER});
        card.add_child(this._sources);

        this._empty = vbox({style_class: 'notchuser-empty', x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(new St.Label({text: _('nothingPlaying'), style_class: 'notchuser-title'}));
        this._empty.add_child(new St.Label({text: _('hint'), style_class: 'notchuser-artist'}));
        card.add_child(this._empty);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._startTicking();
            else
                this._stopTicking();
        });

        this.sync();
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
        // Hidden while nothing is playing, like a notch with nothing to show.
        this.container.visible = Boolean(p);
        for (const a of [this._header, this._progress, this._controls, this._sources])
            a.visible = Boolean(p);
        this._empty.visible = !p;
        if (!p)
            return;

        const cover = coverIcon(p.artUrl);
        this._pillCover.gicon = cover;
        this._pillLabel.text = p.title;
        this._pillState.icon_name = 'media-playback-pause-symbolic';
        this._pillState.visible = !p.playing;

        this._cover.gicon = cover;
        this._title.text = p.title;
        this._artist.text = p.artist;
        this._artist.visible = Boolean(p.artist);
        this._playButton.child.icon_name = p.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._progress.visible = p.length > 0;
        this._slider.reactive = p.canSeek;
        this._updateTime(p);
        this._rebuildSources(p);
    }

    _updateTime(p) {
        if (!(p?.length > 0))
            return;
        const pos = Math.min(p.position, p.length);
        if (!this._slider.dragging)
            this._slider.value = pos / p.length;
        this._elapsed.text = clock(pos);
        this._remaining.text = `-${clock(p.length - pos)}`;
    }

    _rebuildSources(current) {
        this._sources.destroy_all_children();
        const all = this._players.all;
        this._sources.visible = all.length > 1;
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

    // Position is only polled while the panel is open: nothing runs in the background.
    _startTicking() {
        this._stopTicking();
        const tick = () => {
            const p = this._players.current;
            p?.fetchPosition(() => this._updateTime(p));
            return GLib.SOURCE_CONTINUE;
        };
        tick();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, tick);
    }

    _stopTicking() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        this._stopTicking();
        super.destroy();
    }
});

export default class NotchUserExtension extends Extension {
    enable() {
        this._players = new Players(() => this._indicator?.sync());
        this._indicator = new NotchIndicator(this._players);
        // First slot of the center box: right next to the clock, under the camera on laptops.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._players?.destroy();
        this._players = null;
    }
}
