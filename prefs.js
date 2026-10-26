// Settings window (Extensions app → NotchUser → ⚙, or the gear in the panel).
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LANGUAGES, resolveLang, tr} from './strings.js';

export default class NotchUserPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const lang = resolveLang(settings.get_string('language'));
        const t = key => tr(key, lang);

        const page = new Adw.PreferencesPage({title: 'NotchUser', icon_name: 'audio-x-generic-symbolic'});

        const languageGroup = new Adw.PreferencesGroup({title: t('language'), description: t('reopenHint')});
        const names = [t('langSystem'), 'English', 'Português', 'Español'];
        const languageRow = new Adw.ComboRow({
            title: t('language'),
            model: Gtk.StringList.new(names),
            selected: Math.max(0, LANGUAGES.indexOf(settings.get_string('language'))),
        });
        languageRow.connect('notify::selected', () => settings.set_string('language', LANGUAGES[languageRow.selected]));
        languageGroup.add(languageRow);
        page.add(languageGroup);

        const behaviorGroup = new Adw.PreferencesGroup({title: t('behavior')});
        for (const [key, label] of [['hover-open', 'hoverOpen'], ['show-title', 'showTitle'], ['bump-on-change', 'bump']]) {
            const row = new Adw.SwitchRow({title: t(label)});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            behaviorGroup.add(row);
        }
        page.add(behaviorGroup);

        window.add(page);
        window.set_default_size(520, 480);
    }
}
