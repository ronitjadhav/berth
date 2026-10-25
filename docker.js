// Berth - Docker containers in the GNOME top bar
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// One JSON object per line; the compose labels tell us where a container was started from.
const PS_FORMAT = '{"id":{{json .ID}},"names":{{json .Names}},"image":{{json .Image}},' +
    '"state":{{json .State}},"status":{{json .Status}},"ports":{{json .Ports}},' +
    '"project":{{json (.Label "com.docker.compose.project")}},' +
    '"service":{{json (.Label "com.docker.compose.service")}},' +
    '"dir":{{json (.Label "com.docker.compose.project.working_dir")}},' +
    '"files":{{json (.Label "com.docker.compose.project.config_files")}},' +
    '"envFile":{{json (.Label "com.docker.compose.project.environment_file")}},' +
    '"oneoff":{{json (.Label "com.docker.compose.oneoff")}}}';

// Labels only docker compose itself puts on a container. An image carrying them
// would make its containers claim a project folder they were not started from.
const LOCATION_LABELS = [
    'com.docker.compose.project.working_dir',
    'com.docker.compose.project.config_files',
    'com.docker.compose.project.environment_file',
];

// Healthcheck ticks show up as exec_* events; they are noise, so only subscribe to state changes.
const EVENTS = ['create', 'start', 'die', 'stop', 'kill', 'pause', 'unpause',
    'destroy', 'rename', 'restart', 'health_status',
    'pull', 'delete', 'tag', 'untag', 'prune'];

const IMAGES_FORMAT = '{"id":{{json .ID}},"repo":{{json .Repository}},"tag":{{json .Tag}},' +
    '"size":{{json .Size}},"created":{{json .CreatedAt}},"since":{{json .CreatedSince}}}';

const QUERY_TIMEOUT = 20;
const SLOW_QUERY_TIMEOUT = 120;

const SYSTEMD = 'org.freedesktop.systemd1';

// The same container shape from `docker ps` lines and from the Engine API.
function normalize(c) {
    // Legacy --link aliases show up as extra names like "web/db".
    c.name = c.names.split(',').find(n => !n.includes('/')) ?? c.names;
    delete c.names;
    c.health = healthOf(c.status);
    c.running = c.state === 'running' || c.state === 'restarting';
    c.active = c.running || c.state === 'paused';
    c.files = c.files ? c.files.split(',') : [];
    c.envFiles = c.envFile ? c.envFile.split(',') : [];
    delete c.envFile;
    // An image can carry the one-off label to hide its containers from the list, but it
    // can't choose the name Compose gives a one-off: <project>-<service>-run-<12 hex>
    // (Compose v1: _run_<n>). A one-off started with --name stays visible.
    c.oneoff = c.oneoff === 'True' && /(-run-[0-9a-f]{12}|_run_\d+)$/.test(c.name);
    return c;
}

export function parseList(stdout) {
    return stdout.split('\n').filter(l => l).map(line => normalize(JSON.parse(line)));
}

// GET /containers/json?all=1, in the shape parseList gives. Ports are written the
// way `docker ps` writes them, so the rest of the code reads one format.
export function parseApiList(json) {
    return JSON.parse(json).map(a => {
        const label = key => a.Labels?.[key] ?? '';
        const ports = (a.Ports ?? [])
            // Like the CLI: published ports first, by port, IPv4 before IPv6.
            .slice().sort((x, y) => Number(!x.PublicPort) - Number(!y.PublicPort) ||
                (x.PublicPort ?? 0) - (y.PublicPort ?? 0) || x.PrivatePort - y.PrivatePort ||
                Number(x.IP?.includes(':') ?? false) - Number(y.IP?.includes(':') ?? false))
            .map(p => {
                if (!p.PublicPort)
                    return `${p.PrivatePort}/${p.Type}`;
                const ip = p.IP?.includes(':') ? `[${p.IP}]` : p.IP;
                return `${ip}:${p.PublicPort}->${p.PrivatePort}/${p.Type}`;
            });
        return normalize({
            id: a.Id,
            names: (a.Names ?? []).map(n => n.replace(/^\//, '')).join(','),
            image: a.Image,
            imageId: a.ImageID,
            state: a.State,
            status: a.Status,
            ports: ports.join(', '),
            project: label('com.docker.compose.project'),
            service: label('com.docker.compose.service'),
            dir: label('com.docker.compose.project.working_dir'),
            files: label('com.docker.compose.project.config_files'),
            envFile: label('com.docker.compose.project.environment_file'),
            oneoff: label('com.docker.compose.oneoff'),
        });
    });
}

// "unix:///run/user/1000/docker.sock" -> "/run/user/1000/docker.sock"; null for other schemes.
export function unixPath(host) {
    return host?.startsWith('unix://') ? host.slice('unix://'.length) : null;
}

function readJson(path, cancellable) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
            try {
                resolve(JSON.parse(new TextDecoder().decode(file.load_contents_finish(res)[1])));
            } catch {
                resolve(null);
            }
        });
    });
}

// Where the docker CLI would connect, the way it decides: DOCKER_HOST, else
// DOCKER_CONTEXT, else the current context in config.json, else the default
// socket. Resolves to {context, path} for a local unix socket, or null for
// anything else (ssh://, tcp://), which stays on the CLI.
async function localEndpoint(cancellable) {
    const host = GLib.getenv('DOCKER_HOST');
    if (host) {
        const path = unixPath(host);
        return path ? {context: null, path} : null;
    }
    const configDir = GLib.getenv('DOCKER_CONFIG') || GLib.build_filenamev([GLib.get_home_dir(), '.docker']);
    const context = GLib.getenv('DOCKER_CONTEXT') ||
        (await readJson(GLib.build_filenamev([configDir, 'config.json']), cancellable))?.currentContext ||
        'default';
    if (context === 'default')
        return {context, path: '/var/run/docker.sock'};
    // The CLI keeps each context's endpoint under the SHA-256 of its name.
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, context, -1);
    const meta = await readJson(GLib.build_filenamev([configDir, 'contexts', 'meta', hash, 'meta.json']), cancellable);
    const path = unixPath(meta?.Endpoints?.docker?.Host);
    return path ? {context, path} : null;
}

export function healthOf(status) {
    const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
    if (!m)
        return null;
    return m[1] === 'health: starting' ? 'starting' : m[1];
}

// "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 127.0.0.1:9000-9001->9000-9001/tcp, 5432/tcp"
// -> [{hostIp, hostPort, hostPortEnd, containerPort, proto}], IPv4/IPv6 duplicates removed.
export function parsePorts(ports) {
    const seen = new Set();
    const result = [];
    for (const part of ports.split(', ')) {
        const m = /^(.*):(\d+)(?:-(\d+))?->(\d+(?:-\d+)?)\/(\w+)$/.exec(part);
        if (!m)
            continue;
        const [, hostIp, hostPort, hostPortEnd, containerPort, proto] = m;
        if (seen.has(`${hostPort}/${proto}`))
            continue;
        seen.add(`${hostPort}/${proto}`);
        result.push({hostIp, hostPort, hostPortEnd: hostPortEnd ?? null, containerPort, proto});
    }
    return result;
}

// Where a published port can be opened in a browser.
export function portUrl(p) {
    const any = ['0.0.0.0', '[::]', '::', ''].includes(p.hostIp);
    const host = any ? 'localhost' : p.hostIp;
    const scheme = p.containerPort === '443' || p.hostPort === '443' ? 'https' : 'http';
    return `${scheme}://${host}:${p.hostPort}`;
}

// Exit codes a deliberate stop leaves behind: clean exit, Ctrl+C, SIGTERM.
const STOPPED_CODES = ['0', '130', '143'];

export function exitCode(c) {
    return /^(?:Exited|Restarting) \((\d+)\)/.exec(c.status)?.[1] ?? null;
}

// One word for the row: "stopped", "failed", "paused", "not started", "restarting".
export function stateWord(c) {
    switch (c.state) {
    case 'exited':
    case 'dead':
        return STOPPED_CODES.includes(exitCode(c) ?? '0') ? 'stopped' : 'failed';
    case 'created':
        return 'not started';
    default:
        return c.state;
    }
}

// Docker's status, as a sentence: "Running for 5 hours · healthy · restarts automatically",
// "Failed 3 weeks ago · exit code 1". info is docker inspect output, when loaded.
export function describeStatus(c, info = null) {
    const code = exitCode(c) ?? (info?.State?.ExitCode === undefined ? null : `${info.State.ExitCode}`);
    const when = /(?:Up|Exited \(\d+\)|Restarting \(\d+\))\s+(.+?)(?:\s+\(.*\))?$/.exec(c.status)?.[1] ?? '';
    const duration = when.replace(/^About an? /, '1 ').replace(/^Less than an? /, 'under 1 ');
    const parts = [];
    switch (c.state) {
    case 'running': {
        parts.push(duration ? `Running for ${duration}` : 'Running');
        if (c.health === 'healthy')
            parts.push('healthy');
        else if (c.health === 'unhealthy')
            parts.push('unhealthy');
        else if (c.health === 'starting')
            parts.push('health check starting');
        const policy = info?.HostConfig?.RestartPolicy?.Name;
        if (policy === 'always' || policy === 'unless-stopped')
            parts.push('restarts automatically');
        else if (policy === 'on-failure')
            parts.push('restarts on failure');
        break;
    }
    case 'paused':
        parts.push('Paused');
        break;
    case 'restarting':
        parts.push('Keeps restarting');
        if (code)
            parts.push(`exit code ${code}`);
        break;
    case 'created':
        parts.push('Not started yet');
        break;
    case 'removing':
        parts.push('Being removed');
        break;
    default:
        if (info?.State?.OOMKilled)
            parts.push(`Killed ${duration}: out of memory`);
        else if (STOPPED_CODES.includes(code ?? '0'))
            parts.push(duration ? `Stopped ${duration}` : 'Stopped');
        else
            parts.push(duration ? `Failed ${duration}` : 'Failed', `exit code ${code}`);
    }
    return parts.join(' · ');
}

// "45.07GB (57%)" -> "45.07 GB"
export function tidySize(text) {
    return text.replace(/\s*\(.*\)$/, '').replace(/([\d.])([kMGTP]?B)$/, '$1 $2');
}

const SIZE_UNITS = {B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12};

function parseSize(text) {
    const m = /^([\d.]+)\s*([kMGTP]?B)/.exec(text.trim());
    return m ? parseFloat(m[1]) * (SIZE_UNITS[m[2]] ?? 0) : 0;
}

function formatSize(bytes) {
    for (const [unit, factor] of Object.entries(SIZE_UNITS).reverse()) {
        if (bytes >= factor)
            return `${(bytes / factor).toFixed(bytes / factor >= 10 ? 0 : 1)} ${unit}`;
    }
    return '0 B';
}

// docker system df rows -> what the disk block shows. Sizes are Docker's own,
// already free of double counting between images.
export function diskUsage(rows) {
    const by = Object.fromEntries(rows.map(r => [r.Type, r]));
    const get = (type, field) => by[type] ? tidySize(by[type][field]) : null;
    return {
        total: formatSize(rows.reduce((sum, r) => sum + parseSize(r.Size), 0)),
        images: get('Images', 'Size'),
        containers: get('Containers', 'Size'),
        volumes: get('Local Volumes', 'Size'),
        buildCache: get('Build Cache', 'Size'),
        reclaimableContainers: get('Containers', 'Reclaimable'),
        reclaimableBuildCache: get('Build Cache', 'Reclaimable'),
    };
}

// "Up 2 hours (healthy)" -> "2h", "Exited (0) 3 weeks ago" -> "3w"
export function shortAge(status) {
    const m = /(\d+|About an?|Less than an?) (second|minute|hour|day|week|month|year)/.exec(status);
    if (!m)
        return '';
    const n = m[1].startsWith('About') ? 1 : m[1].startsWith('Less') ? 0 : m[1];
    return `${n}${m[2] === 'month' ? 'mo' : m[2][0]}`;
}

// One entry per repository:tag; untagged layers have neither. The same image id
// shows up once per tag.
export function parseImages(stdout) {
    return stdout.split('\n').filter(l => l).map(line => {
        const i = JSON.parse(line);
        i.repo = i.repo.startsWith('<') ? '' : i.repo;
        i.tag = i.tag.startsWith('<') ? '' : i.tag;
        // A repository without a tag (pulled by digest, or re-tagged since) is only addressable by id.
        i.ref = i.repo && i.tag ? `${i.repo}:${i.tag}` : i.id;
        i.age = shortAge(i.since);
        delete i.since;
        return i;
    });
}

// Images -> [{name, images}], repositories by name, newest image first,
// untagged images last under an empty name.
export function groupImages(images) {
    const groups = new Map();
    for (const i of images) {
        if (!groups.has(i.repo))
            groups.set(i.repo, {name: i.repo, images: []});
        groups.get(i.repo).images.push(i);
    }
    const result = [...groups.values()].sort((a, b) => {
        if (!a.name !== !b.name)
            return a.name ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    for (const g of result)
        g.images.sort((a, b) => b.created.localeCompare(a.created));
    return result;
}

// Containers -> [{key, name, dir, containers}]. A project is a name in a folder:
// two folders called "app" both default to the project name "app".
export function group(containers, byProject = true) {
    const groups = new Map();
    for (const c of containers) {
        const project = byProject ? c.project : '';
        const key = project ? `${project}\n${c.dir}` : '';
        if (!groups.has(key))
            groups.set(key, {key, name: project, dir: project ? c.dir : '', containers: []});
        groups.get(key).containers.push(c);
    }
    const result = [...groups.values()].sort((a, b) => {
        if (!a.name !== !b.name)
            return a.name ? -1 : 1;
        return a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir);
    });
    for (const g of result) {
        g.containers.sort((a, b) => {
            if (a.active !== b.active)
                return a.active ? -1 : 1;
            return (a.service || a.name).localeCompare(b.service || b.name);
        });
    }
    return result;
}

// The compose files and env files a project was started with, or null when its
// containers disagree, in which case project-wide commands would be guesses.
export function composeConfig(g) {
    const [first] = g.containers;
    const same = g.containers.every(c =>
        c.files.join() === first.files.join() && c.envFiles.join() === first.envFiles.join());
    if (!g.name || !g.dir || !first.files.length || !same)
        return null;
    return {name: g.name, dir: g.dir, files: first.files, envFiles: first.envFiles};
}

// The line of a failed command's output that says what went wrong.
export function errorText(output) {
    const lines = stripAnsi(output).split('\n').map(l => l.trim())
        .filter(l => l && !/level=warn|^warn(ing)?\b/i.test(l));
    const line = lines.findLast(l => /error|denied|not found|no such|cannot|failed|refused/i.test(l)) ??
        lines.at(-1) ?? '';
    return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

export function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function cancelledError() {
    return new Gio.IOErrorEnum({message: 'Cancelled', code: Gio.IOErrorEnum.CANCELLED});
}

export class Docker {
    // command: how to run the docker CLI, e.g. "docker" or "flatpak-spawn --host docker".
    constructor(command) {
        try {
            this.argv = GLib.shell_parse_argv(command)[1].filter(a => a);
        } catch {
            this.argv = [];
        }
        if (!this.argv.length)
            this.argv = ['docker'];
        this.cancellable = new Gio.Cancellable();
        this._eventsCancel = null;
        this._eventsProc = null;
        this._timeouts = new Set();
        // A local socket to talk to directly; undefined until looked up, null for none.
        this._endpoint = undefined;
        this._session = null;
        this._eventsSession = null;
        // Facts that never change for a given id, so they are asked for once.
        this._imageOf = new Map();
        this._imageHasLocation = new Map();
        this._context = null;
    }

    async list() {
        if (!await this._local())
            return parseList(await this._docker(['ps', '-a', '--no-trunc', '--format', PS_FORMAT], {timeout: QUERY_TIMEOUT}));
        const containers = parseApiList(await this._get('/containers/json?all=1'));
        // The API says which image each container runs: no inspect needed for that.
        for (const c of containers)
            this._imageOf.set(c.id, c.imageId);
        return containers;
    }

    inspect(id) {
        return this._docker(['inspect', id], {timeout: QUERY_TIMEOUT}).then(out => JSON.parse(out)[0]);
    }

    // Last lines a container wrote to stdout and stderr, without terminal colours.
    logsTail(id, lines) {
        return this._docker(['logs', '--tail', `${lines}`, id], {timeout: QUERY_TIMEOUT, mergeStderr: true})
            .then(out => out.split('\n').map(stripAnsi).filter(l => l.trim()).slice(-lines)
                // A minified bundle or a stack trace can be one huge line; nobody reads past 300 characters.
                .map(l => l.length > 300 ? `${l.slice(0, 300)}…` : l));
    }

    // Newer Docker leaves untagged images out of the plain listing, older Docker
    // includes them, so ask for both and merge.
    async images() {
        const list = args => this._docker(['images', '--format', IMAGES_FORMAT, ...args], {timeout: QUERY_TIMEOUT});
        const [tagged, dangling] = await Promise.all([list([]), list(['--filter', 'dangling=true'])]);
        const images = parseImages(tagged);
        const seen = new Set(images.map(i => i.ref));
        for (const i of parseImages(dangling)) {
            if (!seen.has(i.ref))
                images.push(i);
        }
        return images;
    }

    // Which image each container was created from: Map of container id -> image id (sha256:…).
    // A container never changes image, so only containers not seen before are inspected.
    async containerImages(ids) {
        const unknown = ids.filter(id => !this._imageOf.has(id));
        if (unknown.length) {
            const out = await this._docker(['inspect', '--format', '{{.Id}} {{.Image}}', ...unknown],
                {timeout: QUERY_TIMEOUT});
            for (const [id, image] of out.split('\n').filter(l => l).map(l => l.split(' ')))
                this._imageOf.set(id, image);
        }
        // Forget removed containers so the cache doesn't grow for the whole session.
        const wanted = new Set(ids);
        for (const id of this._imageOf.keys()) {
            if (!wanted.has(id))
                this._imageOf.delete(id);
        }
        return new Map(ids.map(id => [id, this._imageOf.get(id)]));
    }

    // Removes a tag, or an untagged image by id. `force` also detaches stopped containers.
    removeImage(ref, force = false) {
        return this._docker(['image', 'rm', ...(force ? ['-f'] : []), ref], {keepOnDisable: true});
    }

    stats(ids) {
        return this._docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids], {timeout: QUERY_TIMEOUT})
            .then(out => out.split('\n').filter(l => l).map(l => JSON.parse(l)));
    }

    // True when one of the containers' images carries compose location labels itself,
    // so the project folder and files they report cannot be trusted.
    async labelsFromImage(ids) {
        const images = [...new Set((await this.containerImages(ids)).values())];
        const unknown = images.filter(id => !this._imageHasLocation.has(id));
        if (unknown.length) {
            const out = await this._docker(['image', 'inspect', '--format', '{{.Id}} {{json .Config.Labels}}', ...unknown],
                {timeout: QUERY_TIMEOUT});
            for (const line of out.split('\n').filter(l => l)) {
                const space = line.indexOf(' ');
                const labels = JSON.parse(line.slice(space + 1)) ?? {};
                this._imageHasLocation.set(line.slice(0, space), LOCATION_LABELS.some(k => k in labels));
            }
        }
        return images.some(id => this._imageHasLocation.get(id));
    }

    // verb: start stop restart pause unpause kill rm
    action(verb, id) {
        const args = verb === 'rm' ? ['rm', '-f', id] : [verb, id];
        return this._docker(args, {keepOnDisable: true});
    }

    compose(project, args) {
        return this._docker([...composeArgs(project), ...args], {cwd: project.dir, keepOnDisable: true});
    }

    composeArgv(project, args) {
        return [...this.argv, ...composeArgs(project), ...args];
    }

    // kind: container image builder. Resolves to the "Total reclaimed space" line.
    prune(kind) {
        return this._docker([kind, 'prune', '-f'], {keepOnDisable: true})
            .then(out => out.split('\n').find(l => /reclaimed/i.test(l))?.trim() ?? '');
    }

    df() {
        return this._docker(['system', 'df', '--format', '{{json .}}'], {timeout: SLOW_QUERY_TIMEOUT})
            .then(out => out.split('\n').filter(l => l).map(l => JSON.parse(l)));
    }

    // Any CLI call starts a socket-activated daemon, so when the CLI talks to the local
    // daemon, ask systemd whether it is running before calling it.
    // The context is looked up once per instance; forgetContext() makes the next call ask again.
    async daemonStopped() {
        if (GLib.getenv('DOCKER_HOST'))
            return false;
        const endpoint = await this._local();
        this._context ??= endpoint?.context ??
            (await this._docker(['context', 'show'], {timeout: QUERY_TIMEOUT})).trim();
        if (this._context !== 'default' && this._context !== 'rootless')
            return false;
        try {
            const bus = this._unitBus();
            const [path] = (await this._dbus(bus, '/org/freedesktop/systemd1', `${SYSTEMD}.Manager`,
                'LoadUnit', new GLib.Variant('(s)', ['docker.service']))).deepUnpack();
            // Unpack only the two strings: other properties hold 64-bit values GJS warns about.
            const [props] = (await this._dbus(bus, path, 'org.freedesktop.DBus.Properties',
                'GetAll', new GLib.Variant('(s)', [`${SYSTEMD}.Unit`]))).deepUnpack();
            return props.LoadState.unpack() === 'loaded' &&
                !['active', 'activating', 'reloading'].includes(props.ActiveState.unpack());
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            // No systemd, or no docker.service: nothing to wake by accident.
            return false;
        }
    }

    forgetContext() {
        this._context = null;
        this._endpoint = undefined;
        this._session?.abort();
        this._eventsSession?.abort();
        this._session = this._eventsSession = null;
    }

    // The local socket the CLI would use, when Berth may talk to it directly: only
    // with the plain docker command, whose context resolution localEndpoint() mirrors.
    async _local() {
        if (this._endpoint === undefined) {
            const plain = this.argv.length === 1 && GLib.path_get_basename(this.argv[0]) === 'docker';
            const endpoint = plain ? await localEndpoint(this.cancellable) : null;
            if (this._endpoint === undefined) {
                this._endpoint = endpoint;
                if (endpoint) {
                    const address = new Gio.UnixSocketAddress({path: endpoint.path});
                    this._session = new Soup.Session({remote_connectable: address, timeout: QUERY_TIMEOUT});
                    // The event stream may stay silent for hours: no I/O timeout.
                    this._eventsSession = new Soup.Session({remote_connectable: address, timeout: 0});
                }
            }
        }
        return this._endpoint;
    }

    // A GET on the Engine API; resolves to the body, rejects with Docker's own message.
    _get(path) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', `http://docker${path}`);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this.cancellable, (session, res) => {
                let text;
                try {
                    text = new TextDecoder().decode(session.send_and_read_finish(res).get_data() ?? new Uint8Array());
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
                        e.timedOut = true;
                    reject(e);
                    return;
                }
                if (msg.get_status() < 300) {
                    resolve(text);
                    return;
                }
                let message = `Docker answered ${msg.get_status()}`;
                try {
                    message = JSON.parse(text).message ?? message;
                } catch {}
                reject(new Error(message));
            });
        });
    }

    // StartUnit through systemd's D-Bus API; polkit asks for a password when needed.
    startDaemon() {
        return this._dbus(this._unitBus(), '/org/freedesktop/systemd1', `${SYSTEMD}.Manager`,
            'StartUnit', new GLib.Variant('(ss)', ['docker.service', 'replace']));
    }

    // Container and image events, as a stream: from the socket when there is one,
    // else from a long-lived `docker events`. onExit runs when the stream ends,
    // usually because the daemon went away.
    watchEvents(onEvent, onExit) {
        this.stopEvents();
        const cancel = new Gio.Cancellable();
        this._eventsCancel = cancel;
        this._local().then(endpoint => {
            if (cancel.is_cancelled())
                return;
            if (endpoint)
                this._eventsFromSocket(cancel, onEvent, onExit);
            else
                this._eventsFromCli(cancel, onEvent, onExit);
        }, e => {
            if (!cancel.is_cancelled())
                onExit(e);
        });
    }

    _eventsFromSocket(cancel, onEvent, onExit) {
        const filters = JSON.stringify({type: ['container', 'image'], event: EVENTS});
        const msg = Soup.Message.new('GET', `http://docker/events?filters=${encodeURIComponent(filters)}`);
        this._eventsSession.send_async(msg, GLib.PRIORITY_DEFAULT, cancel, (session, res) => {
            let input;
            try {
                input = session.send_finish(res);
            } catch (e) {
                this._eventsEnded(cancel, onExit, e);
                return;
            }
            if (msg.get_status() !== 200) {
                this._eventsEnded(cancel, onExit, new Error(`Docker answered ${msg.get_status()}`));
                return;
            }
            this._readEvents(new Gio.DataInputStream({base_stream: input}), cancel, onEvent, onExit);
        });
    }

    _eventsFromCli(cancel, onEvent, onExit) {
        const argv = [...this.argv, 'events', '--format', '{{json .}}',
            '--filter', 'type=container', '--filter', 'type=image'];
        for (const e of EVENTS)
            argv.push('--filter', `event=${e}`);

        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._eventsEnded(cancel, onExit, e);
            return;
        }
        if (!proc) {
            this._eventsEnded(cancel, onExit, new Error(`could not run ${argv[0]}`));
            return;
        }
        this._eventsProc = proc;
        this._readEvents(new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}), cancel, onEvent, onExit);
    }

    // One JSON event per line, from either source.
    _readEvents(stream, cancel, onEvent, onExit) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancel, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                this._eventsEnded(cancel, onExit, e);
                return;
            }
            if (line === null) {
                this._eventsEnded(cancel, onExit);
                return;
            }
            try {
                onEvent(JSON.parse(line));
            } catch (e) {
                console.warn(`[Berth] bad event: ${e.message}`);
            }
            this._readEvents(stream, cancel, onEvent, onExit);
        });
    }

    // Stops and reports a stream that ended on its own; a stopped one stays quiet.
    _eventsEnded(cancel, onExit, error = null) {
        if (cancel.is_cancelled() || error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        if (this._eventsCancel === cancel) {
            this.stopEvents();
            onExit(error);
        }
    }

    stopEvents() {
        this._eventsCancel?.cancel();
        this._eventsCancel = null;
        this._eventsProc?.force_exit();
        this._eventsProc = null;
    }

    destroy() {
        this.cancellable.cancel();
        this.stopEvents();
        this._session?.abort();
        this._eventsSession?.abort();
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
    }

    _unitBus() {
        const userUnit = GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', 'docker.service']);
        return GLib.file_test(userUnit, GLib.FileTest.EXISTS) ? Gio.DBus.session : Gio.DBus.system;
    }

    _dbus(bus, path, iface, method, params) {
        return new Promise((resolve, reject) => {
            bus.call(SYSTEMD, path, iface, method, params, null,
                Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, -1, this.cancellable, (b, res) => {
                    try {
                        resolve(b.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _docker(args, options = {}) {
        return this._run([...this.argv, ...args], options);
    }

    // Runs a command and resolves to its output. The process is killed when the
    // cancellable fires (on disable) or when the timeout, if any, runs out.
    // Commands that change something (keepOnDisable) are never killed: the screen
    // lock disables the extension, and a half-done `compose up` or prune is worse
    // than a result nobody reads.
    _run(argv, {cwd = null, mergeStderr = false, timeout = 0, keepOnDisable = false} = {}) {
        return new Promise((resolve, reject) => {
            if (this.cancellable.is_cancelled()) {
                reject(cancelledError());
                return;
            }
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE |
                    (mergeStderr ? Gio.SubprocessFlags.STDERR_MERGE : Gio.SubprocessFlags.STDERR_PIPE),
            });
            if (cwd)
                launcher.set_cwd(cwd);

            let proc;
            try {
                proc = launcher.spawnv(argv);
            } catch (e) {
                reject(e);
                return;
            }
            if (!proc) {
                reject(new Error(`could not run ${argv[0]}`));
                return;
            }

            let timedOut = false;
            let timeoutId = 0;
            if (timeout) {
                timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
                    this._timeouts.delete(timeoutId);
                    timeoutId = 0;
                    timedOut = true;
                    proc.force_exit();
                    return GLib.SOURCE_REMOVE;
                });
                this._timeouts.add(timeoutId);
            }
            const cancelId = keepOnDisable ? 0 : this.cancellable.connect(() => proc.force_exit());

            proc.communicate_utf8_async(null, null, (p, res) => {
                if (cancelId)
                    this.cancellable.disconnect(cancelId);
                if (timeoutId) {
                    GLib.source_remove(timeoutId);
                    this._timeouts.delete(timeoutId);
                }
                let stdout, stderr;
                try {
                    [, stdout, stderr] = p.communicate_utf8_finish(res);
                } catch (e) {
                    reject(e);
                    return;
                }
                if (this.cancellable.is_cancelled()) {
                    reject(cancelledError());
                } else if (timedOut) {
                    const e = new Error(`${argv.slice(0, 3).join(' ')} did not answer within ${timeout} s`);
                    e.timedOut = true;
                    reject(e);
                } else if (p.get_successful()) {
                    resolve(stdout);
                } else {
                    reject(new Error(errorText(stderr ?? stdout) ||
                        `${argv.slice(0, 2).join(' ')} failed (${p.get_exit_status()})`));
                }
            });
        });
    }
}

function composeArgs(project) {
    const args = ['compose', '-p', project.name, '--project-directory', project.dir];
    for (const f of project.files)
        args.push('-f', f);
    for (const f of project.envFiles)
        args.push('--env-file', f);
    return args;
}
