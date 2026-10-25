// Berth - Docker containers in the GNOME top bar
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class BerthPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const panel = new Adw.PreferencesGroup({title: _('Panel')});
        page.add(panel);
        panel.add(this._choiceRow(settings, 'panel-label', _('Label'), [
            ['running', _('Running containers')],
            ['running-total', _('Running / all containers')],
            ['none', _('Icon only')],
        ]));
        panel.add(this._choiceRow(settings, 'panel-position', _('Position'), [
            ['left', _('Left')],
            ['center', _('Center')],
            ['right', _('Right')],
        ]));

        const list = new Adw.PreferencesGroup({title: _('Container List')});
        page.add(list);
        list.add(this._switchRow(settings, 'show-stopped', _('Show stopped containers')));
        list.add(this._switchRow(settings, 'group-by-project', _('Group by Compose project')));
        list.add(this._switchRow(settings, 'hide-oneoff', _('Hide one-off containers'),
            _('Containers created by “docker compose run”')));
        list.add(this._switchRow(settings, 'show-stats', _('Live CPU and memory usage'),
            _('Measured every few seconds for expanded containers while the menu is open')));
        list.add(this._switchRow(settings, 'notify-exit', _('Notify when a container crashes'),
            _('Exits with a non-zero code that nobody asked for')));

        const advanced = new Adw.PreferencesGroup({
            title: _('Advanced'),
            description: _('Press Enter to apply a changed value.'),
        });
        page.add(advanced);
        advanced.add(this._entryRow(settings, 'docker-command',
            _('Docker command (e.g. docker or flatpak-spawn --host docker)')));
        advanced.add(this._entryRow(settings, 'terminal-command',
            _('Terminal command (empty: detect automatically)'), true));
        advanced.add(this._entryRow(settings, 'container-shell', _('Shell inside containers')));
    }

    _switchRow(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _choiceRow(settings, key, title, choices) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(choices.map(([, text]) => text)),
            selected: Math.max(0, choices.findIndex(([value]) => value === settings.get_string(key))),
        });
        row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
        return row;
    }

    // Fields that must not be empty go back to their default when cleared.
    _entryRow(settings, key, title, allowEmpty = false) {
        const row = new Adw.EntryRow({title, text: settings.get_string(key), show_apply_button: true});
        row.connect('apply', () => {
            const value = row.text.trim();
            if (value || allowEmpty) {
                settings.set_string(key, value);
            } else {
                settings.reset(key);
                row.text = settings.get_string(key);
            }
        });
        return row;
    }
}
