// Berth - Docker containers in the GNOME top bar
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './indicator.js';

export default class BerthExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed::panel-position', () => this._addIndicator(), this);
        this._addIndicator();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    _addIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0,
            this._settings.get_string('panel-position'));
    }
}
