// Berth - Docker containers in the GNOME top bar
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    Docker, composeConfig, describeStatus, diskUsage, group, groupImages,
    parsePorts, portUrl, shortAge, stateWord,
} from './docker.js';

// First match wins. Each entry is the argv prefix that runs a command in a new window.
const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ptyxis', '--'],
    ['kgx', '--'],
    ['gnome-terminal', '--'],
    ['konsole', '-e'],
    ['xfce4-terminal', '-x'],
    ['kitty'],
    ['alacritty', '-e'],
    ['foot'],
    ['xterm', '-e'],
];

// Signals `docker stop`, `docker kill` and Ctrl+C send; the exit that follows is not a crash.
const STOP_SIGNALS = new Set(['2', '3', '9', '15', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM']);

const CONFIRM_SECONDS = 4;
const RETRY_SECONDS = 15;
const MAX_RETRY_SECONDS = 300;
const STATS_SECONDS = 3;
const DISK_CACHE_SECONDS = 60;
// A crashed container that then ran this long counts as fixed: its next crash is news.
const CRASH_REARM_SECONDS = 600;

function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    // St.BoxLayout.vertical is gone in GNOME 51; the layout manager works on every version.
    box.layout_manager.orientation = Clutter.Orientation.VERTICAL;
    return box;
}

function hbox(params = {}) {
    return new St.BoxLayout(params);
}

function now() {
    return GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
}

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

function tildify(path) {
    const home = GLib.get_home_dir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function shortName(c, project) {
    for (const sep of ['-', '_']) {
        if (project && c.name.startsWith(project + sep))
            return c.name.slice(project.length + 1);
    }
    return c.name;
}

function dotClass(c) {
    if (c.state === 'paused')
        return 'berth-dot-paused';
    if (c.state === 'restarting' || c.state === 'dead' || c.health === 'unhealthy')
        return 'berth-dot-bad';
    return c.running ? 'berth-dot-running' : '';
}

function portText(p) {
    return p.hostPortEnd ? `${p.hostPort}-${p.hostPortEnd}` : p.hostPort;
}

function metaText(c) {
    const parts = parsePorts(c.ports).slice(0, 2).map(p => `:${portText(p)}`);
    if (!c.running)
        parts.push(stateWord(c));
    parts.push(shortAge(c.status));
    if (c.health === 'unhealthy' || c.health === 'starting')
        parts.push(c.health);
    return parts.filter(p => p).join(' · ');
}

function label(text, params = {}) {
    return new St.Label({text, y_align: Clutter.ActorAlign.CENTER, ...params});
}

// A label for sentences: wraps instead of widening the menu.
function wrappingLabel(text, params = {}) {
    const l = label(text, {style_class: 'berth-value', ...params});
    // St.Label ellipsizes by default, which wins over wrapping.
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    l.clutter_text.line_wrap = true;
    return l;
}

function kvRow(key, value) {
    const row = hbox({style_class: 'berth-kv'});
    row.add_child(label(key, {style_class: 'berth-key', opacity: 170, y_align: Clutter.ActorAlign.START}));
    row.add_child(typeof value === 'string' ? label(value, {style_class: 'berth-value'}) : value);
    return row;
}

// Long paths keep both ends, so the folder name stays readable in the fixed-width menu.
// Works on a label and on a text button, whose child is a Clutter.Text or an St.Label.
function middleEllipsis(actor) {
    let text = actor instanceof St.Label ? actor.clutter_text : actor.child;
    if (text instanceof St.Label)
        text = text.clutter_text;
    text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    return actor;
}

function linkButton(text, callback) {
    const button = new St.Button({
        style_class: 'berth-link',
        label: text,
        can_focus: true,
        x_align: Clutter.ActorAlign.START,
    });
    button.connect('clicked', callback);
    return button;
}

// A row of links separated by dots, e.g. a folder and the compose files it holds.
function linkLine(items) {
    const row = hbox({style_class: 'berth-links'});
    items.forEach((item, i) => {
        if (i)
            row.add_child(label('·', {opacity: 170}));
        row.add_child(item);
    });
    return row;
}

// A labelled button. Danger buttons ask for a second click; while the callback's
// promise runs, the button is insensitive and shows the busy text. Flat buttons
// are the quiet ones at the end of a panel.
function actionButton(text, iconName, callback, {danger = false, busy = null, confirm = null, flat = false} = {}) {
    const textLabel = label(text);
    const box = hbox();
    if (iconName)
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 16}));
    box.add_child(textLabel);

    const button = new St.Button({
        style_class: flat ? 'berth-flat' : 'button berth-button',
        can_focus: true,
        child: box,
        accessible_name: text,
    });
    if (danger)
        button.add_style_class_name('berth-danger');

    let alive = true;
    let confirmId = 0;
    const setText = t => {
        textLabel.text = t;
        button.accessible_name = t;
    };
    const reset = () => {
        if (confirmId)
            GLib.source_remove(confirmId);
        confirmId = 0;
        setText(text);
        button.remove_style_class_name('berth-confirm');
    };

    button.connect('destroy', () => {
        alive = false;
        if (confirmId)
            GLib.source_remove(confirmId);
        confirmId = 0;
    });
    button.connect('clicked', () => {
        if (danger && !confirmId) {
            setText(confirm ?? _('Click again to %s').format(text.toLowerCase()));
            button.add_style_class_name('berth-confirm');
            confirmId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CONFIRM_SECONDS, () => {
                confirmId = 0;
                reset();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        reset();
        button.reactive = false;
        if (busy)
            setText(busy);
        Promise.resolve(callback(setText)).finally(() => {
            if (!alive)
                return;
            button.reactive = true;
            if (busy)
                setText(text);
        });
    });
    return button;
}

function buttonRow(...buttons) {
    const row = hbox({style_class: 'berth-buttons'});
    for (const b of buttons)
        row.add_child(b);
    return row;
}

// Asynchronous, so a dead network mount can't freeze the shell.
function isDirectory(path, cancellable) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (file, res) => {
                try {
                    resolve(file.query_info_finish(res).get_file_type() === Gio.FileType.DIRECTORY);
                } catch {
                    resolve(false);
                }
            });
    });
}

// Puts a child section at index without PopupMenu's full rescan of its children,
// which would make every refresh quadratic in the number of rows.
function place(section, child, index) {
    if (section.box.get_child_at_index(index) !== child.actor)
        section.box.set_child_at_index(child.actor, index);
}

function containerMatches(c, text) {
    return [c.name, c.image, c.project, c.service].some(s => s?.toLowerCase().includes(text));
}

function imageMatches(i, text) {
    return [i.repo, i.tag, i.id].some(s => s.toLowerCase().includes(text));
}

function detailsItem(styleClass = 'berth-details') {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const box = vbox({style_class: styleClass, x_expand: true});
    item.add_child(box);
    item.visible = false;
    return [item, box];
}

// A row that unfolds something below it. Click, Enter or Space toggle; Right and
// Left open and close, like a tree view. Activating it never closes the menu.
const ExpanderRow = GObject.registerClass(
class BerthExpanderRow extends PopupMenu.PopupBaseMenuItem {
    _init(onExpand, styleClass) {
        super._init({style_class: styleClass});
        this._onExpand = onExpand;
        this._expanded = false;
        this._chevron = new St.Icon({icon_name: 'pan-end-symbolic', style_class: 'popup-menu-icon'});
    }

    activate() {
        this._onExpand(!this._expanded);
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Right || key === Clutter.KEY_Left) {
            const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
            this._onExpand((key === Clutter.KEY_Right) !== rtl);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    setExpanded(expanded) {
        this._expanded = expanded;
        this._chevron.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
    }
});

// A group header: folds the rows beneath it.
const HeaderRow = GObject.registerClass(
class BerthHeaderRow extends ExpanderRow {
    _init(onExpand) {
        super._init(onExpand, 'berth-row berth-header');
        this._label = label('', {style_class: 'berth-header-name', x_expand: true});
        this._counts = label('', {style_class: 'berth-meta', opacity: 170});
        this.add_child(this._chevron);
        this.add_child(this._label);
        this.add_child(this._counts);
        this.label_actor = this._label;
    }

    update(text, counts) {
        this._label.text = text;
        this._counts.text = counts;
    }

    addMoreButton(callback) {
        const button = new St.Button({
            style_class: 'berth-row-button',
            can_focus: true,
            icon_name: 'view-more-symbolic',
            accessible_name: _('Project actions'),
        });
        button.connect('clicked', callback);
        this.add_child(button);
        return button;
    }
});

const ContainerRow = GObject.registerClass(
class BerthContainerRow extends ExpanderRow {
    _init(onExpand) {
        super._init(onExpand, 'berth-row berth-indent');
        this._dot = new St.Widget({style_class: 'berth-dot', y_align: Clutter.ActorAlign.CENTER});
        this._name = label('', {x_expand: true});
        this._meta = label('', {style_class: 'berth-meta', opacity: 170});
        for (const actor of [this._dot, this._name, this._meta, this._chevron])
            this.add_child(actor);
        this.label_actor = this._name;
    }

    update(c, name) {
        this._dot.style_class = `berth-dot ${dotClass(c)}`;
        this._name.text = name;
        this._meta.text = metaText(c);
    }
});

// A row that leads to another page of the menu, or back.
const NavRow = GObject.registerClass(
class BerthNavRow extends PopupMenu.PopupBaseMenuItem {
    _init(text, back, callback) {
        super._init({style_class: 'berth-row berth-nav'});
        this._callback = callback;
        const icon = new St.Icon({
            icon_name: back ? 'go-previous-symbolic' : 'go-next-symbolic',
            style_class: 'popup-menu-icon',
        });
        const text_ = label(text, {x_expand: true, style_class: back ? 'berth-header-name' : ''});
        if (back) {
            this.add_child(icon);
            this.add_child(text_);
        } else {
            this.add_child(text_);
            this.add_child(icon);
        }
        this.label_actor = text_;
    }

    activate() {
        this._callback();
    }
});

class ContainerEntry {
    constructor(indicator) {
        this._indicator = indicator;
        this.container = null;
        this.expanded = false;
        this._loadSeq = 0;
        this._stats = null;
        this._scrollOnRender = false;
        this._destroyed = false;

        // The details panel exists only while the row is expanded.
        this.details = null;
        this._box = null;
        this.section = new PopupMenu.PopupMenuSection();
        this.row = new ContainerRow(expanded => this.setExpanded(expanded));
        this.section.addMenuItem(this.row);
    }

    update(c, name) {
        const changed = this.container?.state !== c.state || this.container?.health !== c.health;
        this.container = c;
        this.row.update(c, name);
        if (this.expanded && changed)
            this.reload();
    }

    setExpanded(expanded) {
        if (expanded === this.expanded)
            return;
        this.expanded = expanded;
        this.row.setExpanded(expanded);
        // A load still running belongs to the panel being opened or closed now.
        this._loadSeq++;
        if (expanded) {
            [this.details, this._box] = detailsItem();
            this.details.visible = true;
            this.section.addMenuItem(this.details);
            this._scrollOnRender = true;
            this.reload();
            this._indicator.updateStats();
        } else {
            this.details?.destroy();
            this.details = this._box = this._stats = null;
        }
    }

    setStats(s) {
        if (this._destroyed || !this._stats)
            return;
        // Non-breaking spaces inside each figure, so a narrow menu wraps between them.
        this._stats.text = [
            _('CPU %s').format(s.CPUPerc),
            _('Memory %s').format(s.MemUsage),
            _('Network %s').format(s.NetIO),
            _('PIDs %s').format(s.PIDs),
        ].map(part => part.replaceAll(' ', ' ')).join(' · ');
    }

    markDestroyed() {
        this._destroyed = true;
    }

    destroy() {
        this._destroyed = true;
        this.section.destroy();
    }

    async reload() {
        const {docker} = this._indicator;
        const c = this.container;
        const seq = ++this._loadSeq;
        let info = null;
        let dirExists = false;
        let tail = [];
        try {
            [info, dirExists] = await Promise.all([
                docker.inspect(c.id),
                c.dir ? isDirectory(c.dir, docker.cancellable) : false,
            ]);
            // When a container failed, its last lines of output usually say why.
            if (c.state === 'restarting' || c.state === 'dead' || (!c.running && info.State?.ExitCode))
                tail = await docker.logsTail(c.id, 5);
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        // A newer load (the state changed meanwhile, or the row was closed) wins.
        if (!this._destroyed && this.expanded && seq === this._loadSeq)
            this._render(info, dirExists, tail);
    }

    _render(info, dirExists, tail) {
        const c = this.container;
        const ind = this._indicator;
        const box = this._box;
        // Re-rendering destroys the focused button; keep keyboard users on this container.
        const focus = global.stage.key_focus;
        const hadFocus = focus !== null && box.contains(focus);
        box.destroy_all_children();

        // What people come for: the switch and the daily tools, in view as soon as the row opens.
        // Two short rows rather than one long one: bolder themes (GNOME 50+) need the room.
        const [primary, tools] = this._primaryButtons();
        box.add_child(primary);
        box.add_child(tools);

        box.add_child(wrappingLabel(describeStatus(c, info)));
        box.add_child(middleEllipsis(label(`${c.image} · ${c.name} · ${c.id.slice(0, 12)}`,
            {style_class: 'berth-value', opacity: 170})));

        if (c.dir) {
            const links = [];
            links.push(dirExists
                ? middleEllipsis(linkButton(tildify(c.dir), () => ind.openPath(c.dir)))
                : label(_('%s (folder missing)').format(tildify(c.dir)), {style_class: 'berth-value'}));
            if (dirExists) {
                for (const f of [...c.files, ...c.envFiles])
                    links.push(linkButton(GLib.path_get_basename(f), () => ind.openPath(f)));
            }
            box.add_child(linkLine(links));
        }

        const health = info?.State?.Health;
        if (health?.Status === 'unhealthy') {
            const last = health.Log?.at(-1)?.Output?.trim().split('\n')[0] ?? '';
            if (last)
                box.add_child(kvRow(_('Health'), last.slice(0, 120)));
        }

        const ports = parsePorts(c.ports);
        if (ports.length) {
            const list = vbox();
            for (const p of ports) {
                const text = `${p.hostIp}:${portText(p)} → ${p.containerPort}/${p.proto}`;
                list.add_child(p.proto === 'tcp'
                    ? linkButton(text, () => ind.openUri(portUrl(p)))
                    : label(text));
            }
            box.add_child(kvRow(_('Ports'), list));
        }

        const mounts = info?.Mounts ?? [];
        if (mounts.length) {
            const list = vbox();
            for (const m of mounts) {
                const source = m.Type === 'volume' ? m.Name : tildify(m.Source);
                list.add_child(middleEllipsis(label(`${source} → ${m.Destination}${m.RW ? '' : ' (ro)'}`,
                    {style_class: 'berth-value'})));
            }
            box.add_child(kvRow(_('Mounts'), list));
        }

        const networks = Object.entries(info?.NetworkSettings?.Networks ?? {});
        if (networks.length) {
            const list = vbox();
            for (const [name, n] of networks)
                list.add_child(label(n.IPAddress ? `${name} · ${n.IPAddress}` : name, {style_class: 'berth-value'}));
            box.add_child(kvRow(_('Network'), list));
        }

        if (tail.length) {
            const list = vbox();
            for (const line of tail)
                list.add_child(label(line, {style_class: 'berth-value berth-log'}));
            box.add_child(kvRow(_('Output'), list));
        }

        this._stats = null;
        if (c.state === 'running' && ind.settings.get_boolean('show-stats')) {
            this._stats = wrappingLabel(_('Measuring usage…'), {opacity: 170});
            box.add_child(this._stats);
        }

        for (const row of this._secondaryButtons())
            box.add_child(row);

        if (hadFocus)
            this.row.grab_key_focus();
        if (this._scrollOnRender) {
            this._scrollOnRender = false;
            ind.scrollIntoView(ind.mainScroll, this.row, box);
        }
    }

    _action(verb) {
        const ind = this._indicator;
        return () => ind.run(ind.docker.action(verb, this.container.id));
    }

    // Start/Stop first, then what people reach for every day: one row each.
    _primaryButtons() {
        const c = this.container;
        const ind = this._indicator;
        const b = (text, icon, verb, busy) => actionButton(text, icon, this._action(verb), {busy});
        const lifecycle = [];
        const tools = [];

        if (c.state === 'paused')
            lifecycle.push(b(_('Resume'), 'media-playback-start-symbolic', 'unpause', _('Resuming…')));
        else if (c.active)
            lifecycle.push(b(_('Stop'), 'media-playback-stop-symbolic', 'stop', _('Stopping…')));
        else
            lifecycle.push(b(_('Start'), 'media-playback-start-symbolic', 'start', _('Starting…')));
        if (c.state === 'running')
            lifecycle.push(b(_('Restart'), 'view-refresh-symbolic', 'restart', _('Restarting…')));

        tools.push(actionButton(_('Logs'), 'text-x-generic-symbolic', () => ind.showLogs(c)));
        if (c.state === 'running')
            tools.push(actionButton(_('Shell'), 'utilities-terminal-symbolic', () => ind.openShell(c)));
        const port = parsePorts(c.ports).find(p => p.proto === 'tcp');
        if (port && c.running) {
            tools.push(actionButton(_('Open :%s').format(port.hostPort), 'web-browser-symbolic',
                () => ind.openUri(portUrl(port))));
        }
        return [buttonRow(...lifecycle), buttonRow(...tools)];
    }

    // Rarely needed, then the destructive ones on a line of their own: quiet, at the end.
    _secondaryButtons() {
        const c = this.container;
        const ind = this._indicator;
        const flat = (text, callback, options = {}) => actionButton(text, null, callback, {flat: true, ...options});
        const rare = [];
        const destructive = [];

        if (c.state === 'running')
            rare.push(flat(_('Pause'), this._action('pause'), {busy: _('Pausing…')}));
        rare.push(
            flat(_('Inspect'), () => ind.showInspect(c)),
            flat(_('Copy ID'), setText => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, c.id);
                setText(_('Copied'));
            }));
        if (c.running) {
            destructive.push(flat(_('Force Stop'), this._action('kill'),
                {danger: true, busy: _('Stopping…'), confirm: _('Click again to force stop')}));
        }
        destructive.push(flat(_('Remove'), this._action('rm'),
            {danger: true, busy: _('Removing…'), confirm: _('Click again to remove')}));
        return [buttonRow(...rare), buttonRow(...destructive)];
    }
}

class ProjectEntry {
    constructor(indicator, g) {
        this._indicator = indicator;
        this.key = g.key;
        this.group = g;
        this.collapsed = false;
        this.containers = new Map();
        this._built = false;
        this._panelSeq = 0;
        this._destroyed = false;

        this.section = new PopupMenu.PopupMenuSection();
        this.section.actor.add_style_class_name('berth-group');
        this.row = new HeaderRow(expanded => this.setCollapsed(!expanded));
        this.row.setExpanded(true);
        [this.panel, this._panelBox] = detailsItem('berth-details berth-card');
        this.body = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this.row);
        this.section.addMenuItem(this.panel);
        this.section.addMenuItem(this.body);

        if (g.name)
            this._moreButton = this.row.addMoreButton(() => this._setPanelOpen(!this.panel.visible));
    }

    update(g, title, counts) {
        this.group = g;
        this.row.update(title, counts);
        if (this._built)
            this._sync();
    }

    // Container rows exist only while the project is unfolded, or while the filter
    // reaches into it; a folded project costs one row.
    _setBuilt(built) {
        if (built === this._built)
            return;
        this._built = built;
        if (built) {
            this._sync();
        } else {
            for (const entry of this.containers.values())
                entry.destroy();
            this.containers.clear();
        }
    }

    _sync() {
        const g = this.group;
        const seen = new Set();
        g.containers.forEach((c, i) => {
            let entry = this.containers.get(c.id);
            if (!entry) {
                entry = new ContainerEntry(this._indicator);
                this.containers.set(c.id, entry);
                this.body.addMenuItem(entry.section);
            }
            place(this.body, entry.section, i);
            entry.update(c, shortName(c, g.name));
            seen.add(c.id);
        });
        for (const [id, entry] of this.containers) {
            if (!seen.has(id)) {
                entry.destroy();
                this.containers.delete(id);
            }
        }
    }

    // Shows what matches text; returns whether anything does.
    applyFilter(text) {
        const matching = text
            ? new Set(this.group.containers.filter(c => containerMatches(c, text)).map(c => c.id))
            : null;
        const any = !matching || matching.size > 0;
        const open = !this.collapsed || (!!text && any);
        this._setBuilt(open);
        this.body.actor.visible = open;
        for (const [id, entry] of this.containers)
            entry.section.actor.visible = !matching || matching.has(id);
        this.section.actor.visible = any;
        return any;
    }

    setCollapsed(collapsed) {
        this.collapsed = collapsed;
        this.row.setExpanded(!collapsed);
        this.applyFilter(this._indicator.filterText());
    }

    markDestroyed() {
        this._destroyed = true;
        for (const entry of this.containers.values())
            entry.markDestroyed();
    }

    destroy() {
        this._destroyed = true;
        if (this.panel.visible)
            this._indicator.setOpenCard(this, false);
        for (const entry of this.containers.values())
            entry.destroy();
        this.containers.clear();
        this.section.destroy();
    }

    _setPanelOpen(open) {
        if (open === this.panel.visible)
            return;
        this.panel.visible = open;
        this._indicator.setOpenCard(this, open);
        if (open)
            this._renderPanel();
        else
            this._panelSeq++;
    }

    closePanel() {
        this._setPanelOpen(false);
    }

    // A press on the card (its background too, which takes no clicks itself) or on
    // its own ⋯ button is not "elsewhere".
    ownsPress(target, x, y) {
        if (target && this._moreButton?.contains(target))
            return true;
        const [px, py] = this.panel.get_transformed_position();
        const [width, height] = this.panel.get_transformed_size();
        return x >= px && x < px + width && y >= py && y < py + height;
    }

    // Whether project-wide compose commands can be trusted, and with which files.
    // Resolves to {config, problem}; problem is null when actions are safe to run.
    async _check() {
        const g = this.group;
        const ind = this._indicator;
        const config = composeConfig(g);
        if (!g.dir || !g.containers[0].files.length)
            return {config, problem: _('Docker Compose did not record where this project was started, so project actions are off.')};
        if (!config)
            return {config, problem: _('Its containers were started with different Compose files, so project actions are off.')};
        try {
            if (!await isDirectory(config.dir, ind.docker.cancellable))
                return {config, problem: _('The project folder no longer exists, so project actions are off.')};
            if (await ind.docker.labelsFromImage(g.containers.map(c => c.id)))
                return {config, problem: _('A container’s image sets Compose labels itself, so its folder and files can’t be trusted. Project actions are off.')};
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return {config, problem: _('Could not check the project: %s').format(e.message)};
        }
        return {config, problem: null};
    }

    async _renderPanel() {
        const seq = ++this._panelSeq;
        const g = this.group;
        const ind = this._indicator;
        const box = this._panelBox;
        box.destroy_all_children();
        box.add_child(label(_('Checking the project…'), {opacity: 170}));

        let check;
        try {
            check = await this._check();
        } catch {
            return;
        }
        if (this._destroyed || seq !== this._panelSeq)
            return;
        const {config, problem} = check;

        box.destroy_all_children();
        // Where it comes from, and every file the actions below will read.
        if (config && !problem) {
            box.add_child(linkLine([
                middleEllipsis(linkButton(tildify(config.dir), () => ind.openPath(config.dir))),
                ...[...config.files, ...config.envFiles].map(f =>
                    linkButton(GLib.path_get_basename(f), () => ind.openPath(f))),
            ]));
        } else {
            box.add_child(middleEllipsis(label(g.dir ? tildify(g.dir) : _('Folder unknown'),
                {style_class: 'berth-value'})));
        }
        if (problem) {
            box.add_child(wrappingLabel(problem, {opacity: 170}));
            return;
        }

        const compose = (text, icon, args, busy) =>
            actionButton(text, icon, () => ind.run(ind.docker.compose(config, args)), {busy});
        box.add_child(buttonRow(
            compose(_('Start'), 'media-playback-start-symbolic', ['up', '-d'], _('Starting…')),
            compose(_('Stop'), 'media-playback-stop-symbolic', ['stop'], _('Stopping…')),
            compose(_('Restart'), 'view-refresh-symbolic', ['restart'], _('Restarting…'))));
        box.add_child(buttonRow(
            actionButton(_('Logs'), 'text-x-generic-symbolic',
                () => ind.runComposeInTerminal(config, ['logs', '-f', '--tail', '200'])),
            actionButton(_('Terminal'), 'utilities-terminal-symbolic', () => ind.openTerminal(null, config.dir)),
            actionButton(_('Folder'), 'folder-open-symbolic', () => ind.openPath(config.dir))));
        box.add_child(buttonRow(actionButton(_('Remove containers'), null,
            () => ind.run(ind.docker.compose(config, ['down'])), {
                flat: true,
                danger: true,
                busy: _('Removing…'),
                confirm: ngettext('Removes %d container. Click again', 'Removes %d containers. Click again',
                    g.containers.length).format(g.containers.length),
            })));
    }
}

const ImageRow = GObject.registerClass(
class BerthImageRow extends ExpanderRow {
    _init(onExpand) {
        super._init(onExpand, 'berth-row berth-indent');
        this._name = label('', {x_expand: true});
        this._meta = label('', {style_class: 'berth-meta', opacity: 170});
        this.add_child(this._name);
        this.add_child(this._meta);
        this.add_child(this._chevron);
        this.label_actor = this._name;
    }

    update(image, usedBy) {
        this._name.text = image.tag || image.id;
        const parts = [image.size, image.age];
        if (usedBy.some(c => c.running))
            parts.push(_('running'));
        else if (usedBy.length)
            parts.push(_('in use'));
        this._meta.text = parts.join(' · ');
    }
});

function containerLabel(c) {
    const name = c.project ? `${c.project} / ${shortName(c, c.project)}` : c.name;
    return `${name} (${stateWord(c)})`;
}

class ImageEntry {
    constructor(indicator) {
        this._indicator = indicator;
        this.image = null;
        this.usedBy = [];
        this.otherTags = [];
        this.expanded = false;
        this._signature = '';
        this._destroyed = false;

        // The details panel exists only while the row is expanded.
        this.details = null;
        this._box = null;
        this.section = new PopupMenu.PopupMenuSection();
        this.row = new ImageRow(expanded => this.setExpanded(expanded));
        this.section.addMenuItem(this.row);
    }

    // otherTags: tags the same image carries besides this one; removing this
    // one then only untags.
    update(image, usedBy, otherTags) {
        // Re-render an open panel only when what it shows changed, so a refresh
        // doesn't cancel a pending "click again" or move the keyboard focus.
        const signature = JSON.stringify([image, usedBy.map(c => [c.id, c.state]), otherTags]);
        const changed = signature !== this._signature;
        this._signature = signature;
        this.image = image;
        this.usedBy = usedBy;
        this.otherTags = otherTags;
        this.row.update(image, usedBy);
        if (this.expanded && changed)
            this._render(false);
    }

    setExpanded(expanded) {
        if (expanded === this.expanded)
            return;
        this.expanded = expanded;
        this.row.setExpanded(expanded);
        if (expanded) {
            [this.details, this._box] = detailsItem();
            this.details.visible = true;
            this.section.addMenuItem(this.details);
            this._render(true);
        } else {
            this.details?.destroy();
            this.details = this._box = null;
        }
    }

    markDestroyed() {
        this._destroyed = true;
    }

    destroy() {
        this._destroyed = true;
        this.section.destroy();
    }

    _render(scroll) {
        const i = this.image;
        const ind = this._indicator;
        const box = this._box;
        const focus = global.stage.key_focus;
        const hadFocus = focus !== null && box.contains(focus);
        box.destroy_all_children();

        const tools = [];
        if (i.repo && i.tag)
            tools.push(actionButton(_('Pull'), 'folder-download-symbolic', () => ind.pullImage(i.ref)));
        tools.push(actionButton(_('Inspect'), 'dialog-information-symbolic', () => ind.inspectImage(i.ref)));
        const toolRow = buttonRow(...tools);
        box.add_child(toolRow);

        box.add_child(middleEllipsis(label(`${i.ref} · ${i.id} · ${i.size}`, {style_class: 'berth-value', opacity: 170})));
        box.add_child(kvRow(_('Created'), i.created.replace(/ [+-]\d{4}.*$/, '')));
        if (this.otherTags.length)
            box.add_child(kvRow(_('Also tagged'), this.otherTags.join('\n')));

        if (this.usedBy.length) {
            const list = vbox();
            for (const c of this.usedBy)
                list.add_child(middleEllipsis(label(containerLabel(c), {style_class: 'berth-value'})));
            box.add_child(kvRow(_('Used by'), list));
        } else {
            box.add_child(kvRow(_('Used by'), _('no container')));
        }

        // Removing one of several tags only untags; the image and its containers stay.
        const untagOnly = this.otherTags.length > 0;
        const running = this.usedBy.filter(c => c.running);
        let note = null;
        let force = false;
        if (untagOnly)
            note = _('Removes only this tag. The image stays under its other tags.');
        else if (running.length)
            note = _('A running container uses this image. Stop it before removing the image.');
        else if (this.usedBy.length)
            force = true, note = _('Removing it leaves these containers without an image: they can’t start again until it is pulled or rebuilt.');
        if (note)
            box.add_child(wrappingLabel(note, {opacity: 170}));
        if (untagOnly || !running.length) {
            box.add_child(buttonRow(actionButton(_('Remove'), null, async () => {
                await ind.run(ind.docker.removeImage(i.ref, force));
                ind.images.refresh(true);
            }, {flat: true, danger: true, busy: _('Removing…'), confirm: _('Click again to remove')})));
        }

        if (hadFocus)
            this.row.grab_key_focus();
        if (scroll)
            ind.scrollIntoView(ind.imagesScroll, this.row, box);
    }
}

class RepoEntry {
    constructor(indicator, name, collapsed) {
        this._indicator = indicator;
        this.name = name;
        this.group = null;
        this.images = new Map();
        this.collapsed = collapsed;
        this._built = false;
        this._data = null;
        this._destroyed = false;

        this.section = new PopupMenu.PopupMenuSection();
        this.section.actor.add_style_class_name('berth-group');
        this.row = new HeaderRow(expanded => this.setCollapsed(!expanded));
        this.row.setExpanded(!collapsed);
        this.body = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this.row);
        this.section.addMenuItem(this.body);
    }

    // data: {byImage, tagsById}, shared by all repositories of one refresh.
    update(g, data) {
        this.group = g;
        this._data = data;
        const inUse = g.images.filter(i => data.byImage.has(i.id)).length;
        let counts;
        if (!this.name)
            counts = ngettext('%d image', '%d images', g.images.length).format(g.images.length);
        else if (inUse)
            counts = `${ngettext('%d tag', '%d tags', g.images.length).format(g.images.length)} · ${_('%d in use').format(inUse)}`;
        else
            counts = ngettext('%d tag', '%d tags', g.images.length).format(g.images.length);
        this.row.update(g.name || _('Untagged'), counts);
        if (this._built)
            this._sync();
    }

    // Image rows exist only while the repository is unfolded, or while the filter
    // reaches into it; the 100-odd untagged images cost one row until opened.
    _setBuilt(built) {
        if (built === this._built)
            return;
        this._built = built;
        if (built) {
            this._sync();
        } else {
            for (const entry of this.images.values())
                entry.destroy();
            this.images.clear();
        }
    }

    _sync() {
        const {byImage, tagsById} = this._data;
        const seen = new Set();
        this.group.images.forEach((i, n) => {
            let entry = this.images.get(i.ref);
            if (!entry) {
                entry = new ImageEntry(this._indicator);
                this.images.set(i.ref, entry);
                this.body.addMenuItem(entry.section);
            }
            place(this.body, entry.section, n);
            const otherTags = (tagsById.get(i.id) ?? []).filter(ref => ref !== i.ref);
            entry.update(i, byImage.get(i.id) ?? [], otherTags);
            seen.add(i.ref);
        });
        for (const [ref, entry] of this.images) {
            if (!seen.has(ref)) {
                entry.destroy();
                this.images.delete(ref);
            }
        }
    }

    // Shows what matches text; returns whether anything does.
    applyFilter(text) {
        const matching = text
            ? new Set(this.group.images.filter(i => imageMatches(i, text)).map(i => i.ref))
            : null;
        const any = !matching || matching.size > 0;
        const open = !this.collapsed || (!!text && any);
        this._setBuilt(open);
        this.body.actor.visible = open;
        for (const [ref, entry] of this.images)
            entry.section.actor.visible = !matching || matching.has(ref);
        this.section.actor.visible = any;
        return any;
    }

    setCollapsed(collapsed) {
        this.collapsed = collapsed;
        this.row.setExpanded(!collapsed);
        this._indicator.images.rememberFolded(this.name, collapsed);
        this.applyFilter(this._indicator.imagesFilterText());
    }

    markDestroyed() {
        this._destroyed = true;
        for (const entry of this.images.values())
            entry.markDestroyed();
    }

    destroy() {
        this._destroyed = true;
        for (const entry of this.images.values())
            entry.destroy();
        this.images.clear();
        this.section.destroy();
    }
}

// The image list of the second page: one group per repository with its tags,
// untagged images folded at the bottom. Its rows exist only while the page is
// shown; the listing itself is kept, so coming back shows it at once.
class ImagesEntry {
    constructor(indicator) {
        this._indicator = indicator;
        this.active = false;
        this.untagged = 0;
        this.repos = new Map();
        // Folded repositories, remembered while their rows come and go.
        this._folded = new Set(['']);
        this._images = null;
        this._busy = false;
        this._again = null;
        this._refreshId = 0;
        this._destroyed = false;

        this.section = new PopupMenu.PopupMenuSection();
        [this._status, this._statusBox] = detailsItem('berth-message');
        this._statusLabel = wrappingLabel('', {opacity: 170});
        this._statusBox.add_child(this._statusLabel);
        this.body = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._status);
        this.section.addMenuItem(this.body);
    }

    setActive(active) {
        this.active = active;
        if (active) {
            if (this._images)
                this._show();
            else
                this._setStatus(_('Loading…'));
            this.refresh(true);
        } else {
            this._clearRows();
        }
    }

    rememberFolded(name, folded) {
        if (folded)
            this._folded.add(name);
        else
            this._folded.delete(name);
    }

    // relist: ask Docker for the images again (after image events); otherwise only
    // which containers use them is recomputed.
    queueRefresh(relist) {
        if (relist)
            this._stale = true;
        if (!this.active || this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._refreshId = 0;
            this.refresh(this._stale);
            return GLib.SOURCE_REMOVE;
        });
    }

    // One refresh at a time; a request arriving meanwhile runs once afterwards.
    async refresh(relist) {
        if (!this.active || this._destroyed)
            return;
        if (this._busy) {
            this._again = (this._again ?? false) || relist;
            return;
        }
        this._busy = true;
        try {
            await this._load(relist || !this._images);
        } finally {
            this._busy = false;
        }
        if (this._again !== null) {
            const again = this._again;
            this._again = null;
            this.refresh(again);
        }
    }

    async _load(relist) {
        const ind = this._indicator;
        try {
            if (relist) {
                this._stale = false;
                this._images = await ind.docker.images();
            }
            this._usage = await ind.docker.containerImages(ind.containers.map(c => c.id));
        } catch (e) {
            if (!isCancelled(e) && !this._destroyed && this.active)
                this._setStatus(e.message);
            return;
        }
        if (this._destroyed || !this.active)
            return;
        this.untagged = this._images.filter(i => !i.repo).length;
        this._show();
        ind.onImagesLoaded();
    }

    _show() {
        const ind = this._indicator;
        const images = this._images;
        // Which containers were created from each image, by its short id.
        const byImage = new Map();
        for (const c of ind.containers) {
            const id = this._usage?.get(c.id)?.replace(/^sha256:/, '').slice(0, 12);
            if (!id)
                continue;
            if (!byImage.has(id))
                byImage.set(id, []);
            byImage.get(id).push(c);
        }
        const tagsById = new Map();
        for (const i of images) {
            if (i.tag)
                tagsById.set(i.id, [...tagsById.get(i.id) ?? [], i.ref]);
        }
        const data = {byImage, tagsById};

        this._status.visible = false;
        const seen = new Set();
        groupImages(images).forEach((g, i) => {
            let repo = this.repos.get(g.name);
            if (!repo) {
                repo = new RepoEntry(ind, g.name, this._folded.has(g.name));
                this.repos.set(g.name, repo);
                this.body.addMenuItem(repo.section);
            }
            place(this.body, repo.section, i);
            repo.update(g, data);
            seen.add(g.name);
        });
        for (const [name, repo] of this.repos) {
            if (!seen.has(name)) {
                repo.destroy();
                this.repos.delete(name);
            }
        }
        this.applyFilter(ind.imagesFilterText());
    }

    // Hides what doesn't match the filter.
    applyFilter(text) {
        let any = false;
        for (const repo of this.repos.values())
            any = repo.applyFilter(text) || any;
        if (this.repos.size) {
            if (text && !any)
                this._setStatus(_('No matching images'));
            else
                this._status.visible = false;
        }
    }

    _setStatus(text) {
        this._statusLabel.text = text;
        this._status.visible = true;
    }

    _clearRows() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        for (const repo of this.repos.values())
            repo.destroy();
        this.repos.clear();
    }

    // Docker went away: forget everything it said.
    clear() {
        this._clearRows();
        this._images = null;
        this._usage = null;
        this.untagged = 0;
    }

    markDestroyed() {
        this._destroyed = true;
        for (const repo of this.repos.values())
            repo.markDestroyed();
    }

    destroy() {
        this._destroyed = true;
        this._clearRows();
        this.section.destroy();
    }
}

export const Indicator = GObject.registerClass(
class BerthIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Berth', false);
        this._extension = extension;
        this.settings = extension.getSettings();
        this.docker = new Docker(this._dockerCommand());

        this._projects = new Map();
        this._order = [];
        this.containers = [];
        this._error = null;
        this._stopping = new Set();
        this._notified = new Set();
        this._source = null;
        this._page = 'main';
        this._openCard = null;
        this._menuDirty = true;
        this._refreshing = false;
        this._refreshAgain = false;
        this._firstQueuedAt = 0;
        this._retrySeconds = RETRY_SECONDS;
        this._shownError = null;
        this._diskSeq = 0;
        this._diskCache = null;
        this._diskQuery = null;
        this._diskButtons = null;
        this._diskButtonsKey = null;
        this._watchStarted = 0;
        this._refreshId = 0;
        this._retryId = 0;
        this._statsId = 0;
        this._focusId = 0;
        this._statsBusy = false;
        this._destroyed = false;

        this._gicon = Gio.icon_new_for_string(`${extension.path}/icons/berth-symbolic.svg`);
        const panelBox = hbox();
        this._icon = new St.Icon({gicon: this._gicon, style_class: 'system-status-icon'});
        this._panelLabel = label('', {style_class: 'berth-panel-label'});
        panelBox.add_child(this._icon);
        panelBox.add_child(this._panelLabel);
        this.add_child(panelBox);

        this._buildMenu();

        this.settings.connectObject(
            'changed::panel-label', () => this._render(),
            'changed::show-stopped', () => this._render(),
            'changed::hide-oneoff', () => this._render(),
            'changed::group-by-project', () => this._render(),
            'changed::show-stats', () => this._reloadExpanded(),
            'changed::docker-command', () => this._restartDocker(),
            this);
        this.menu.connectObject('open-state-changed', (_menu, open) => this._onMenuOpen(open), this);

        this._connect();
    }

    _dockerCommand() {
        return this.settings.get_string('docker-command').trim() || 'docker';
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('berth-menu');

        // Main page: the containers.
        this._main = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._main);

        const top = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._filter = this._filterEntry(_('Filter containers…'), () => this._applyFilter(), () => this._openFirstMatch());
        top.add_child(this._filter);
        const prefs = new St.Button({
            style_class: 'icon-button berth-icon-button',
            icon_name: 'emblem-system-symbolic',
            accessible_name: _('Preferences'),
            can_focus: true,
        });
        prefs.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        top.add_child(prefs);
        this._main.addMenuItem(top);

        const summaryItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._summary = label('', {opacity: 170});
        this._stoppedToggle = linkButton('', () =>
            this.settings.set_boolean('show-stopped', !this.settings.get_boolean('show-stopped')));
        summaryItem.add_child(this._summary);
        summaryItem.add_child(this._stoppedToggle);
        this._main.addMenuItem(summaryItem);
        this._main.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        [this._message, this._messageBox] = detailsItem('berth-message');
        this._main.addMenuItem(this._message);
        [this._noMatch, this._noMatchBox] = detailsItem('berth-message');
        this._noMatchBox.add_child(label(_('No matching containers'), {opacity: 170}));
        this._main.addMenuItem(this._noMatch);

        // The list scrolls on its own so the filter and the footer stay in view.
        this._list = new PopupMenu.PopupMenuSection();
        this.mainScroll = this._scrollView(this._list);
        this._main.addMenuItem(this.mainScroll.section);

        this._footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._main.addMenuItem(this._footerSeparator);
        this._toSecond = new NavRow(_('Images and disk'), false, () => this._showPage('second'));
        this._main.addMenuItem(this._toSecond);

        // Second page: images and disk space.
        this._second = new PopupMenu.PopupMenuSection();
        this._second.actor.visible = false;
        this.menu.addMenuItem(this._second);

        this._back = new NavRow(_('Images and disk'), true, () => this._showPage('main'));
        this._second.addMenuItem(this._back);
        [this._disk, this._diskBox] = detailsItem();
        this._disk.visible = true;
        this._second.addMenuItem(this._disk);
        this._second.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const imagesTop = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._imagesFilter = this._filterEntry(_('Filter images…'),
            () => this.images.applyFilter(this.imagesFilterText()), () => {});
        imagesTop.add_child(this._imagesFilter);
        this._second.addMenuItem(imagesTop);

        this.images = new ImagesEntry(this);
        this.imagesScroll = this._scrollView(this.images.section);
        this._second.addMenuItem(this.imagesScroll.section);
    }

    _filterEntry(hint, onChange, onActivate) {
        const entry = new St.Entry({
            style_class: 'search-entry berth-filter',
            hint_text: hint,
            can_focus: true,
            x_expand: true,
        });
        entry.clutter_text.connectObject('text-changed', onChange, 'activate', onActivate, this);
        return entry;
    }

    _scrollView(listSection) {
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: listSection.actor,
        });
        scroll.section = new PopupMenu.PopupMenuSection();
        scroll.section.actor.add_child(scroll);
        return scroll;
    }

    // One project card at a time, and a press anywhere else in the menu closes it,
    // like a popover. Watched only while a card is open, on the menu's outer actor:
    // the menu's grab starts event delivery there, so inner actors never see it.
    setOpenCard(project, open) {
        if (open) {
            if (this._openCard && this._openCard !== project)
                this._openCard.closePanel();
            this._openCard = project;
            this.menu.actor.connectObject('captured-event', (_actor, event) => this._onMenuPress(event), this);
        } else if (this._openCard === project) {
            this._openCard = null;
            this.menu.actor.disconnectObject(this);
        }
    }

    _onMenuPress(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const [x, y] = event.get_coords();
            if (this._openCard && !this._openCard.ownsPress(global.stage.get_event_actor(event), x, y))
                this._openCard.closePanel();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _showPage(name) {
        this._openCard?.closePanel();
        this._page = name;
        this._main.actor.visible = name === 'main';
        this._second.actor.visible = name === 'second';
        this.images.setActive(name === 'second');
        if (name === 'second') {
            this._renderDisk();
            this._back.grab_key_focus();
        } else {
            this._imagesFilter.text = '';
            this._filter.grab_key_focus();
        }
    }

    // Docker access

    // Starts listening to Docker, unless that would wake a stopped daemon.
    async _connect() {
        this._removeSource('_retryId');
        try {
            if (await this.docker.daemonStopped()) {
                if (this._destroyed)
                    return;
                this.docker.stopEvents();
                this._showError(Object.assign(new Error('stopped'), {stopped: true}));
                this._scheduleRetry();
                return;
            }
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            this._showError(e);
            this._scheduleRetry();
            return;
        }
        if (this._destroyed)
            return;
        this._watchStarted = now();
        this.docker.watchEvents(e => this._onEvent(e), () => this._onEventsExit());
        this._refresh();
    }

    _onEventsExit() {
        // A stream that ran for a while ended because the daemon stopped or restarted:
        // look again soon. One that failed at once means Docker is unreachable.
        if (now() - this._watchStarted > 5) {
            this._retrySeconds = RETRY_SECONDS;
            this._scheduleRetry(1);
        } else {
            this._scheduleRetry();
        }
    }

    // While Docker stays away, look less and less often (15 s up to 5 min), so a
    // laptop without Docker running isn't woken up all day. Opening the menu
    // always looks again at once.
    _scheduleRetry(seconds = null) {
        if (seconds === null) {
            seconds = this._retrySeconds;
            this._retrySeconds = Math.min(this._retrySeconds * 2, MAX_RETRY_SECONDS);
        }
        this._removeSource('_retryId');
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retryId = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restartDocker() {
        this.docker.destroy();
        this.docker = new Docker(this._dockerCommand());
        this._connect();
    }

    // Menu opened: reconnect after an error, else refresh. Expanded rows reload by
    // themselves when their container's state changed.
    _update() {
        if (this._error) {
            this.docker.forgetContext();
            this._retrySeconds = RETRY_SECONDS;
            this._connect();
            return;
        }
        this._refresh();
    }

    _reloadExpanded() {
        for (const entry of this._entries()) {
            if (entry.expanded)
                entry.reload();
        }
    }

    _entries() {
        return [...this._projects.values()].flatMap(p => [...p.containers.values()]);
    }

    _onEvent(e) {
        if (e.Type === 'image') {
            this._diskCache = null;
            this.images.queueRefresh(true);
            return;
        }
        const id = e.Actor?.ID ?? e.id;
        const attrs = e.Actor?.Attributes ?? {};
        switch (e.Action) {
        case 'kill':
            if (STOP_SIGNALS.has(attrs.signal))
                this._stopping.add(id);
            // A signal changes nothing by itself; the die that follows does.
            return;
        case 'stop':
            return;
        case 'start':
            this._stopping.delete(id);
            break;
        case 'die':
            // A die after a stop signal is someone stopping the container, not a crash.
            if (!this._stopping.delete(id))
                this._notifyCrash(id, attrs);
            break;
        case 'destroy':
            this._stopping.delete(id);
            this._notified.delete(id);
            this._diskCache = null;
            break;
        }
        this._queueRefresh();
    }

    async _notifyCrash(id, attrs) {
        if (!this.settings.get_boolean('notify-exit') ||
            ['0', '130'].includes(attrs.exitCode) ||
            attrs['com.docker.compose.oneoff'] === 'True')
            return;
        let info;
        try {
            info = await this.docker.inspect(id);
        } catch {
            // Already gone: a `docker run --rm` someone was watching.
            return;
        }
        // Attached to a terminal: whoever started it saw it exit.
        if (this._destroyed || info.Config?.AttachStdout || info.HostConfig?.AutoRemove)
            return;
        // A crash loop is one piece of news, not one per restart. It becomes news
        // again once the container has run for a while between crashes.
        const ranFor = (Date.parse(info.State?.FinishedAt) - Date.parse(info.State?.StartedAt)) / 1000;
        if (this._notified.has(id) && !(ranFor >= CRASH_REARM_SECONDS))
            return;
        this._notified.add(id);
        const looping = (info.RestartCount ?? 0) > 0;
        this.notify((looping ? _('%s keeps crashing') : _('%s stopped unexpectedly')).format(attrs.name),
            _('Exit code %s').format(attrs.exitCode), false,
            [_('Show Logs'), () => this.showLogs({id})]);
    }

    // Waits for a burst of events (a compose up, a test run) to go quiet before
    // asking Docker once. The wait is short while the menu is open and longer while
    // only the panel count shows, with a cap so a never-ending burst still updates.
    _queueRefresh() {
        const t = now();
        this._firstQueuedAt ||= t;
        const [quiet, cap] = this.menu.isOpen ? [0.3, 2] : [1.5, 5];
        const delay = Math.max(0, Math.min(quiet, this._firstQueuedAt + cap - t));
        this._removeSource('_refreshId');
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(delay * 1000), () => {
            this._refreshId = 0;
            this._firstQueuedAt = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // One `docker ps` at a time; a request arriving meanwhile runs once afterwards.
    async _refresh() {
        if (this._refreshing) {
            this._refreshAgain = true;
            return;
        }
        this._refreshing = true;
        let containers = null;
        let error = null;
        try {
            containers = await this.docker.list();
        } catch (e) {
            error = e;
        }
        this._refreshing = false;
        if (isCancelled(error) || this._destroyed)
            return;
        if (error) {
            this._showError(error);
        } else {
            this.containers = containers;
            this._error = null;
            this._retrySeconds = RETRY_SECONDS;
            this._render();
        }
        if (this._refreshAgain) {
            this._refreshAgain = false;
            this._refresh();
        }
    }

    // Rendering

    _render() {
        if (this._error) {
            this._showError(this._error);
            return;
        }

        const all = this.containers.filter(c =>
            !(c.oneoff && this.settings.get_boolean('hide-oneoff')));
        const running = all.filter(c => c.running).length;
        const paused = all.filter(c => c.state === 'paused').length;
        const stopped = all.length - running - paused;
        // Failing: health check failing or stuck in a restart loop. The panel turns red for them.
        const failing = all.filter(c => dotClass(c) === 'berth-dot-bad').length;
        const showStopped = this.settings.get_boolean('show-stopped');
        const visible = all.filter(c => showStopped || c.active);
        const byProject = this.settings.get_boolean('group-by-project');

        this._icon.opacity = 255;
        this._setWarning(failing > 0);
        this._setPanelLabel(running, all.length);
        this._shownError = null;
        // Nobody sees the menu while it is closed: build it when it opens.
        if (!this.menu.isOpen) {
            this._menuDirty = true;
            return;
        }
        this._menuDirty = false;
        this._footerSeparator.visible = true;
        this._toSecond.visible = true;

        const parts = [_('%d running').format(running)];
        if (paused)
            parts.push(_('%d paused').format(paused));
        if (failing)
            parts.push(_('%d failing').format(failing));
        // The stopped count is the switch that shows or hides them.
        this._summary.text = parts.join(' · ') + (stopped ? ' · ' : '');
        this._stoppedToggle.visible = stopped > 0;
        this._stoppedToggle.label = showStopped ? _('Hide stopped') : _('Show %d stopped').format(stopped);

        this.mainScroll.visible = true;
        this._message.visible = false;
        if (!visible.length) {
            this._showMessage(all.length ? _('No running containers') : _('No containers'),
                all.length ? null : _('Containers you create appear here.'));
        }

        const totals = new Map();
        for (const g of group(all, byProject)) {
            totals.set(g.key, {
                active: g.containers.filter(c => c.active).length,
                total: g.containers.length,
            });
        }

        const groups = group(visible, byProject);
        const nameCount = new Map();
        for (const g of groups)
            nameCount.set(g.name, (nameCount.get(g.name) ?? 0) + 1);

        const seen = new Set();
        this._order = groups.map(g => g.key);
        groups.forEach((g, i) => {
            let project = this._projects.get(g.key);
            const t = totals.get(g.key);
            if (!project) {
                project = new ProjectEntry(this, g);
                // Projects with nothing running start folded so stopped ones don't flood the list.
                project.collapsed = t.active === 0;
                project.row.setExpanded(!project.collapsed);
                this._projects.set(g.key, project);
                this._list.addMenuItem(project.section);
            }
            place(this._list, project.section, i);
            let title = g.name;
            if (!title)
                title = byProject ? _('Standalone') : _('Containers');
            else if (nameCount.get(g.name) > 1)
                title = `${g.name} (${GLib.path_get_basename(GLib.path_get_dirname(g.dir))})`;
            project.update(g, title, _('%d of %d running').format(t.active, t.total));
            seen.add(g.key);
        });
        for (const [key, project] of this._projects) {
            if (!seen.has(key)) {
                project.destroy();
                this._projects.delete(key);
            }
        }

        this._applyFilter();
        this.images.queueRefresh(false);
    }

    _setPanelLabel(running, total) {
        const mode = this.settings.get_string('panel-label');
        this._panelLabel.visible = mode !== 'none';
        this._panelLabel.text = mode === 'running-total' ? `${running}/${total}` : `${running}`;
    }

    _setWarning(warning) {
        for (const actor of [this._icon, this._panelLabel]) {
            if (warning)
                actor.add_style_class_name('berth-panel-warning');
            else
                actor.remove_style_class_name('berth-panel-warning');
        }
    }

    _showError(e) {
        this._error = e;
        let title, hint = null, button = null;
        const startButton = {
            text: _('Start Docker'),
            icon: 'media-playback-start-symbolic',
            callback: () => this.run(this.docker.startDaemon()).then(() => {
                if (!this._destroyed)
                    this._connect();
            }),
        };
        if (e.stopped) {
            title = _('Docker is not running');
            button = startButton;
        } else if (e.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT)) {
            title = _('Docker CLI not found');
            hint = _('Install Docker, or set the docker command in preferences.');
        } else if (/permission denied/i.test(e.message)) {
            title = _('No permission to use Docker');
            hint = _('Add your user to the docker group, then log out and back in.');
        } else if (/cannot connect to the docker daemon|is the docker daemon running/i.test(e.message) ||
                   e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
                   e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED)) {
            // The CLI's words, or the socket's: missing (daemon never started) or refusing.
            title = _('Docker is not running');
            button = startButton;
        } else if (e.timedOut) {
            title = _('Docker is not answering');
            hint = _('Berth keeps trying.');
        } else {
            title = _('Docker did not answer');
            hint = e.message;
        }

        this._icon.opacity = 128;
        this._setWarning(false);
        this._panelLabel.text = '–';
        const shown = `${title}\n${hint}\n${!!button}`;
        if (shown === this._shownError)
            return;
        this._shownError = shown;
        this._summary.text = '';
        this._stoppedToggle.visible = false;
        for (const project of this._projects.values())
            project.destroy();
        this._projects.clear();
        this.images.clear();
        if (this._page !== 'main')
            this._showPage('main');
        this._noMatch.visible = false;
        this.mainScroll.visible = false;
        this._footerSeparator.visible = false;
        this._toSecond.visible = false;
        this._showMessage(title, hint, button);
    }

    _showMessage(title, hint = null, button = null) {
        const box = this._messageBox;
        box.destroy_all_children();
        box.add_child(label(title, {style_class: 'berth-header-name'}));
        if (hint)
            box.add_child(wrappingLabel(hint, {opacity: 170}));
        if (button)
            box.add_child(buttonRow(actionButton(button.text, button.icon, button.callback)));
        this._message.visible = true;
    }

    filterText() {
        return this._filter.text.trim().toLowerCase();
    }

    imagesFilterText() {
        return this._imagesFilter.text.trim().toLowerCase();
    }

    _applyFilter() {
        const text = this.filterText();
        let any = false;
        for (const project of this._projects.values())
            any = project.applyFilter(text) || any;
        this._noMatch.visible = !!text && !any && !this._error;
    }

    // Enter in the filter jumps to the first match, and opens it when it is the only one.
    _openFirstMatch() {
        const matches = this._order
            .map(key => this._projects.get(key))
            .filter(p => p?.section.actor.visible)
            .flatMap(p => p.group.containers.map(c => p.containers.get(c.id)))
            .filter(e => e?.section.actor.visible);
        if (!matches.length)
            return;
        if (matches.length === 1)
            matches[0].setExpanded(true);
        matches[0].row.grab_key_focus();
    }

    // The disk block at the top of the second page. `docker system df` walks every
    // volume and layer (over a second here), so its answer is kept for a minute and
    // dropped when something changes; it never runs twice at once.
    async _renderDisk() {
        const seq = ++this._diskSeq;
        const box = this._diskBox;
        box.destroy_all_children();
        this._diskButtons = null;
        this._diskButtonsKey = null;
        const usage = wrappingLabel('', {opacity: 170});
        box.add_child(usage);

        const cache = this._diskCache;
        let disk = cache?.disk;
        if (!cache || now() - cache.at > DISK_CACHE_SECONDS) {
            usage.text = _('Measuring disk usage…');
            try {
                this._diskQuery ??= this.docker.df().finally(() => (this._diskQuery = null));
                disk = diskUsage(await this._diskQuery);
            } catch (e) {
                if (!isCancelled(e) && !this._destroyed && seq === this._diskSeq)
                    usage.text = e.message;
                return;
            }
            if (this._destroyed || seq !== this._diskSeq)
                return;
            this._diskCache = {at: now(), disk};
        }

        usage.text = _('Docker uses %s: images %s, volumes %s, containers %s, build cache %s')
            .format(disk.total, disk.images ?? '?', disk.volumes ?? '?', disk.containers ?? '?', disk.buildCache ?? '?');
        this._diskButtons = vbox();
        box.add_child(this._diskButtons);
        this._renderDiskButtons();
    }

    _renderDiskButtons() {
        const disk = this._diskCache?.disk;
        const box = this._diskButtons;
        if (!disk || !box)
            return;
        // Rebuilt only when a label changes, so a pending "click again" survives refreshes.
        const untagged = this.images.untagged ? `${this.images.untagged}` : null;
        const key = JSON.stringify([disk.reclaimableContainers, untagged, disk.reclaimableBuildCache]);
        if (key === this._diskButtonsKey)
            return;
        this._diskButtonsKey = key;
        box.destroy_all_children();
        const prune = (kind, text, size, confirm) => actionButton(size ? `${text} (${size})` : text,
            'user-trash-symbolic', async () => {
                const reclaimed = await this.run(this.docker.prune(kind));
                if (this._destroyed)
                    return;
                this._diskCache = null;
                if (reclaimed)
                    this.notify(text, reclaimed, true);
                if (this._page === 'second') {
                    this._renderDisk();
                    this.images.refresh(true);
                }
            }, {danger: true, busy: _('Removing…'), confirm});
        box.add_child(buttonRow(prune('container', _('Remove stopped containers'), disk.reclaimableContainers,
            _('Removes every stopped container. Click again'))));
        box.add_child(buttonRow(prune('image', _('Remove untagged images'), untagged,
            _('Removes every untagged image. Click again'))));
        box.add_child(buttonRow(prune('builder', _('Clear build cache'), disk.reclaimableBuildCache,
            _('Clears the build cache. Click again'))));
    }

    // The image count arrives after the disk block; put it on the untagged button then.
    onImagesLoaded() {
        if (this._page === 'second')
            this._renderDiskButtons();
    }

    // Menu life cycle

    _onMenuOpen(open) {
        if (open) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const height = (Main.layoutManager.primaryMonitor?.height ?? 1080) / scale;
            const style = `max-height: ${Math.floor(height * 0.6)}px;`;
            this.mainScroll.style = style;
            this.imagesScroll.style = style;

            // Events that arrived while closed only updated the panel; catch up now.
            if (this._menuDirty)
                this._render();
            this._update();
            global.stage.connectObject('notify::key-focus', () => this._scrollToFocus(), this);
            this._focusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
                this._focusId = 0;
                this._filter.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
            this._statsId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STATS_SECONDS, () => {
                this.updateStats();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._openCard?.closePanel();
            global.stage.disconnectObject(this);
            this._removeSource('_focusId');
            this._removeSource('_statsId');
            this._filter.text = '';
            if (this._page !== 'main')
                this._showPage('main');
        }
    }

    // Once panel has been laid out, scroll so it is in view, with its row first
    // when the panel is taller than the list.
    scrollIntoView(scroll, row, panel) {
        const id = panel.connect('notify::allocation', () => {
            panel.disconnect(id);
            ensureActorVisibleInScrollView(scroll, panel);
            ensureActorVisibleInScrollView(scroll, row);
        });
    }

    _scrollToFocus() {
        const focus = global.stage.key_focus;
        for (const scroll of [this.mainScroll, this.imagesScroll]) {
            if (focus && scroll.contains(focus))
                ensureActorVisibleInScrollView(scroll, focus);
        }
    }

    async updateStats() {
        if (this._statsBusy || !this.settings.get_boolean('show-stats'))
            return;
        // Only rows someone can see: not on the other page, filtered out or folded away.
        const entries = this._entries().filter(e =>
            e.expanded && e.container.state === 'running' && e.details?.mapped);
        if (!entries.length)
            return;

        this._statsBusy = true;
        try {
            const stats = await this.docker.stats(entries.map(e => e.container.id));
            for (const s of stats)
                entries.find(e => e.container.id.startsWith(s.ID))?.setStats(s);
        } catch {
            // A container stopping between list and stats is normal; the next tick catches up.
        } finally {
            this._statsBusy = false;
        }
    }

    // Actions, shared with the rows

    // Resolves to the command's result, or undefined when it failed (after telling the user).
    async run(promise) {
        try {
            return await promise;
        } catch (e) {
            if (!isCancelled(e) && !this._destroyed)
                this.notify(_('Docker command failed'), e.message, true);
            return undefined;
        }
    }

    openPath(path) {
        this.openUri(Gio.File.new_for_path(path).get_uri());
    }

    openUri(uri) {
        this.menu.close();
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            this.notify(_('Could not open %s').format(uri), e.message, true);
        }
    }

    // Runs a shell script in the user's terminal. Every value put into a script
    // goes through GLib.shell_quote().
    openTerminal(script, cwd = null) {
        this.menu.close();
        try {
            const custom = this.settings.get_string('terminal-command').trim();
            const prefix = custom
                ? GLib.shell_parse_argv(custom)[1]
                : TERMINALS.find(([bin]) => GLib.find_program_in_path(bin));
            if (!prefix)
                throw new Error(_('No terminal emulator found. Set one in preferences.'));

            let body = script ?? 'exec "${SHELL:-sh}"';
            if (cwd)
                body = `cd ${GLib.shell_quote(cwd)} || exit 1; ${body}`;
            // Launched as an app, the terminal gets a startup token and opens focused.
            // The command line is an Exec line: quoted for the shell, with % doubled.
            const commandline = [...prefix, 'sh', '-c', body]
                .map(a => GLib.shell_quote(a)).join(' ').replaceAll('%', '%%');
            Gio.AppInfo.create_from_commandline(commandline, null, Gio.AppInfoCreateFlags.NONE)
                .launch([], global.create_app_launch_context(0, -1));
        } catch (e) {
            this.notify(_('Could not open a terminal'), e.message, true);
        }
    }

    _hold(command) {
        // Keep the window open after Ctrl+C or an error so the output can be read.
        const prompt = GLib.shell_quote(_('Press Enter to close'));
        return `trap : INT; ${command}; printf '\\n%s' ${prompt}; read _`;
    }

    _shellJoin(argv) {
        return argv.map(a => GLib.shell_quote(a)).join(' ');
    }

    showLogs(c) {
        this.openTerminal(this._hold(this._shellJoin([...this.docker.argv, 'logs', '-f', '--tail', '500', c.id])));
    }

    showInspect(c) {
        this.openTerminal(`${this._shellJoin([...this.docker.argv, 'inspect', c.id])} | less`);
    }

    openShell(c) {
        let shell = this.settings.get_string('container-shell');
        if (!/^[\w./-]+$/.test(shell))
            shell = 'sh';
        const inner = `command -v ${shell} >/dev/null 2>&1 && exec ${shell} || exec sh`;
        const prompt = GLib.shell_quote(_('Press Enter to close'));
        this.openTerminal(`${this._shellJoin([...this.docker.argv, 'exec', '-it', c.id, 'sh', '-c', inner])}` +
            ` || { printf '\\n%s' ${prompt}; read _; }`);
    }

    pullImage(ref) {
        this.openTerminal(this._hold(this._shellJoin([...this.docker.argv, 'pull', ref])));
    }

    inspectImage(ref) {
        this.openTerminal(`${this._shellJoin([...this.docker.argv, 'image', 'inspect', ref])} | less`);
    }

    runComposeInTerminal(config, args) {
        this.openTerminal(this._hold(this._shellJoin(this.docker.composeArgv(config, args))), config.dir);
    }

    notify(title, body, transient, action = null) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Berth', icon: this._gicon});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({
            source: this._source,
            title,
            body,
            isTransient: transient,
        });
        if (action)
            notification.addAction(...action);
        this._source.addNotification(notification);
    }

    _removeSource(name) {
        if (this[name])
            GLib.source_remove(this[name]);
        this[name] = 0;
    }

    // A normal disable. At shutdown the Shell destroys its UI in no particular
    // order, so menu sections and notifications are only torn down here.
    destroy() {
        // Close first: closing touches the focused row and runs our close handler,
        // so both must still exist.
        this.menu.close();
        this.menu.disconnectObject(this);
        this._source?.destroy();
        for (const project of this._projects.values())
            project.destroy();
        this._projects.clear();
        this.images.destroy();
        this._list.destroy();
        this._main.destroy();
        this._second.destroy();
        super.destroy();
    }

    // Runs however the button gets destroyed, shutdown included. Touches no actors.
    _onDestroy() {
        this._destroyed = true;
        for (const project of this._projects.values())
            project.markDestroyed();
        this.images.markDestroyed();
        for (const name of ['_refreshId', '_retryId', '_statsId', '_focusId'])
            this._removeSource(name);
        global.stage.disconnectObject(this);
        this.settings.disconnectObject(this);
        this.docker.destroy();
        super._onDestroy();
    }
});
