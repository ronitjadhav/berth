#!/usr/bin/env -S gjs -m
// Run with: gjs -m tests/docker.test.js

import {composeConfig, describeStatus, parseApiList, unixPath, diskUsage, errorText, group, groupImages, healthOf, parseImages, parseList, parsePorts, portUrl, shortAge, stateWord, stripAnsi, tidySize} from '../docker.js';

let failures = 0;
function eq(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e)
        return;
    failures++;
    print(`FAIL ${what}\n  expected ${e}\n  got      ${a}`);
}

const line = fields => JSON.stringify({
    id: 'a', names: 'x', image: 'img', state: 'running', status: 'Up 2 hours',
    ports: '', project: '', service: '', dir: '', files: '',
    envFile: '', oneoff: '', ...fields,
});

const [c] = parseList(`${line({status: 'Up 5 hours (healthy)', files: '/p/a.yml,/p/b.yml', envFile: '/p/.env', oneoff: 'True'})}\n`);
eq(c.health, 'healthy', 'health parsed from status');
eq([c.running, c.active], [true, true], 'running state');
eq(c.files, ['/p/a.yml', '/p/b.yml'], 'compose files split');
eq(c.envFiles, ['/p/.env'], 'env files split');
eq(c.oneoff, false, 'one-off label alone does not hide a container');
eq(parseList(line({names: 'shop-worker-run-ca506e325ff9', oneoff: 'True'}))[0].oneoff, true, 'compose run one-off hidden');
eq(parseList(line({names: 'shop_worker_run_1', oneoff: 'True'}))[0].oneoff, true, 'compose v1 one-off hidden');
eq(parseList(line({names: 'shop-worker-run-ca506e325ff9', oneoff: 'False'}))[0].oneoff, false, 'run-like name without the label');
eq(parseList('').length, 0, 'empty list');

const [paused] = parseList(line({state: 'paused', status: 'Up 1 hour (Paused)'}));
eq([paused.running, paused.active], [false, true], 'paused is active but not running');
eq(parseList(line({names: 'db,web/db'}))[0].name, 'db', 'legacy link aliases ignored');

eq(healthOf('Up 3 seconds (health: starting)'), 'starting', 'health starting');
eq(healthOf('Exited (1) 2 days ago'), null, 'no health');

eq(parsePorts('0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 5432/tcp'),
    [{hostIp: '0.0.0.0', hostPort: '8080', hostPortEnd: null, containerPort: '80', proto: 'tcp'}],
    'ports deduplicated, exposed-only skipped');
eq(parsePorts('127.0.0.1:8000-8001->8000-8001/tcp'),
    [{hostIp: '127.0.0.1', hostPort: '8000', hostPortEnd: '8001', containerPort: '8000-8001', proto: 'tcp'}],
    'port ranges kept');
eq(parsePorts(''), [], 'no ports');

eq(portUrl({hostIp: '0.0.0.0', hostPort: '8080', containerPort: '80'}), 'http://localhost:8080', 'any address -> localhost');
eq(portUrl({hostIp: '[::]', hostPort: '8080', containerPort: '80'}), 'http://localhost:8080', 'any IPv6 address -> localhost');
eq(portUrl({hostIp: '192.168.1.5', hostPort: '8443', containerPort: '443'}), 'https://192.168.1.5:8443', 'bound address and https');

eq(shortAge('Up 2 hours (healthy)'), '2h', 'age hours');
eq(shortAge('Up About a minute'), '1m', 'age about a minute');
eq(shortAge('Up Less than a second'), '0s', 'age less than a second');
eq(shortAge('Exited (0) 3 weeks ago'), '3w', 'age weeks');
eq(shortAge('Up 2 months'), '2mo', 'age months');
eq(shortAge('Created'), '', 'no age');

const containers = parseList([
    line({id: '1', names: 'z-db', state: 'exited', status: 'Exited (0) 1 day ago', project: 'zeta', service: 'db', dir: '/z', files: '/z/c.yml'}),
    line({id: '2', names: 'lonely'}),
    line({id: '3', names: 'a-web', project: 'alpha', service: 'web', dir: '/a', files: '/a/c.yml'}),
    line({id: '4', names: 'a-db', project: 'alpha', service: 'db', dir: '/a', files: '/a/c.yml', state: 'exited', status: 'Exited (1) 1 day ago'}),
    line({id: '5', names: 'a-cache', project: 'alpha', service: 'cache', dir: '/a', files: '/a/c.yml'}),
    line({id: '6', names: 'other-app', project: 'alpha', service: 'app', dir: '/elsewhere/alpha', files: '/elsewhere/alpha/c.yml'}),
].join('\n'));

const groups = group(containers);
eq(groups.map(g => [g.name, g.dir]), [['alpha', '/a'], ['alpha', '/elsewhere/alpha'], ['zeta', '/z'], ['', '']],
    'same project name in two folders stays two projects; standalone last');
eq(groups[0].containers.map(x => x.service), ['cache', 'web', 'db'], 'running first, then by service');
eq(group(containers, false).map(g => g.containers.length), [6], 'grouping disabled');

eq(composeConfig(groups[0]), {name: 'alpha', dir: '/a', files: ['/a/c.yml'], envFiles: []}, 'compose config of a project');
const mixed = {...groups[0], containers: [...groups[0].containers, {...groups[0].containers[0], files: ['/a/other.yml']}]};
eq(composeConfig(mixed), null, 'containers that disagree on files give no config');
eq(composeConfig(groups[3]), null, 'standalone has no config');

eq(errorText('time="x" level=warning msg="the attribute `version` is obsolete"\nError response from daemon: port is already allocated\n'),
    'Error response from daemon: port is already allocated', 'compose warnings skipped');
eq(errorText(' Container a Starting\n Container a Error\nError response from daemon: no such image\n'),
    'Error response from daemon: no such image', 'last error line wins over progress lines');
eq(errorText(''), '', 'empty output');

const imageLine = f => JSON.stringify({id: 'abc', repo: 'nginx', tag: 'latest', size: '43MB', created: '2026-10-01 10:00:00 +0200 CEST', since: '2 days ago', ...f});
const images = parseImages([
    imageLine({id: 'a1', repo: 'nginx', tag: 'alpine', created: '2026-10-20 10:00:00 +0200 CEST'}),
    imageLine({id: 'a2', repo: 'nginx', tag: '1.27', created: '2026-09-01 10:00:00 +0200 CEST'}),
    imageLine({id: 'b1', repo: 'postgres', tag: '16'}),
    imageLine({id: 'c1', repo: '<none>', tag: '<none>', since: '3 weeks ago'}),
    imageLine({id: 'd1', repo: 'busybox', tag: '<none>'}),
].join('\n'));
eq(images[0].ref, 'nginx:alpine', 'image ref');
eq(images[0].age, '2d', 'image age');
eq([images[3].repo, images[3].tag, images[3].ref, images[3].age], ['', '', 'c1', '3w'], 'untagged image');
eq(images[4].ref, 'd1', 'repository without a tag is addressed by id');
const imageGroups = groupImages(images);
eq(imageGroups.map(g => g.name), ['busybox', 'nginx', 'postgres', ''], 'repositories by name, untagged last');
eq(imageGroups[1].images.map(i => i.tag), ['alpine', '1.27'], 'newest image first');

const st = (state, status, health = null) => ({state, status, health});
eq(describeStatus(st('running', 'Up 5 hours (healthy)', 'healthy'), {HostConfig: {RestartPolicy: {Name: 'unless-stopped'}}}),
    'Running for 5 hours · healthy · restarts automatically', 'status: running, healthy, auto restart');
eq(describeStatus(st('running', 'Up About a minute')), 'Running for 1 minute', 'status: about a minute');
eq(describeStatus(st('running', 'Up 3 seconds (health: starting)', 'starting')), 'Running for 3 seconds · health check starting', 'status: health starting');
eq(describeStatus(st('paused', 'Up 2 hours (Paused)')), 'Paused', 'status: paused');
eq(describeStatus(st('exited', 'Exited (0) 3 weeks ago')), 'Stopped 3 weeks ago', 'status: clean exit');
eq(describeStatus(st('exited', 'Exited (143) 3 weeks ago')), 'Stopped 3 weeks ago', 'status: SIGTERM exit');
eq(describeStatus(st('exited', 'Exited (1) 3 weeks ago')), 'Failed 3 weeks ago · exit code 1', 'status: failed');
eq(describeStatus(st('exited', 'Exited (137) 2 days ago'), {State: {OOMKilled: true}}), 'Killed 2 days ago: out of memory', 'status: OOM');
eq(describeStatus(st('restarting', 'Restarting (1) 5 seconds ago')), 'Keeps restarting · exit code 1', 'status: restart loop');
eq(describeStatus(st('created', 'Created')), 'Not started yet', 'status: created');
eq([stateWord(st('exited', 'Exited (0) 1 day ago')), stateWord(st('exited', 'Exited (2) 1 day ago')), stateWord(st('created', 'Created'))],
    ['stopped', 'failed', 'not started'], 'state words');

eq(diskUsage([
    {Type: 'Images', Size: '78.74GB', Reclaimable: '45.07GB (57%)'},
    {Type: 'Containers', Size: '977.6MB', Reclaimable: '977.6MB (99%)'},
    {Type: 'Local Volumes', Size: '238.4GB', Reclaimable: '13.28GB (5%)'},
    {Type: 'Build Cache', Size: '17.69GB', Reclaimable: '1.755GB'},
]), {total: '336 GB', images: '78.74 GB', containers: '977.6 MB', volumes: '238.4 GB', buildCache: '17.69 GB',
    reclaimableContainers: '977.6 MB', reclaimableBuildCache: '1.755 GB'}, 'disk usage');
eq(tidySize('45.07GB (57%)'), '45.07 GB', 'size without percentage');

const api = JSON.stringify([{
    Id: 'f'.repeat(64), Names: ['/shop-web-1', '/other/web'], Image: 'nginx:alpine', ImageID: 'sha256:abc',
    State: 'running', Status: 'Up 2 hours (healthy)',
    Ports: [
        {IP: '::', PrivatePort: 80, PublicPort: 18080, Type: 'tcp'},
        {IP: '0.0.0.0', PrivatePort: 80, PublicPort: 18080, Type: 'tcp'},
        {PrivatePort: 443, Type: 'tcp'},
    ],
    Labels: {
        'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web',
        'com.docker.compose.project.working_dir': '/p/shop',
        'com.docker.compose.project.config_files': '/p/shop/compose.yaml',
        'com.docker.compose.oneoff': 'False',
    },
}, {Id: 'e'.repeat(64), Names: ['/lonely'], Image: 'alpine', State: 'exited', Status: 'Exited (1) 2 days ago', Ports: [], Labels: {}}]);
const [web, lonely] = parseApiList(api);
eq([web.name, web.project, web.service, web.dir, web.files, web.envFiles, web.oneoff, web.health, web.running, web.imageId],
    ['shop-web-1', 'shop', 'web', '/p/shop', ['/p/shop/compose.yaml'], [], false, 'healthy', true, 'sha256:abc'],
    'API container mapped like a ps line');
eq(parsePorts(web.ports).map(p => `${p.hostIp}:${p.hostPort}->${p.containerPort}`), ['0.0.0.0:18080->80'],
    'API ports read like ps ports, IPv6 duplicate dropped');
eq(web.ports, '0.0.0.0:18080->80/tcp, [::]:18080->80/tcp, 443/tcp', 'API ports written in ps style');
eq([lonely.project, lonely.files, lonely.running], ['', [], false], 'API container without compose labels');
eq([unixPath('unix:///run/user/1000/docker.sock'), unixPath('tcp://1.2.3.4:2376'), unixPath(undefined)],
    ['/run/user/1000/docker.sock', null, null], 'unix socket paths');

eq(stripAnsi('\x1b[31mERROR\x1b[0m boom\x1b[?25l'), 'ERROR boom', 'ANSI colours stripped');

if (failures)
    throw new Error(`${failures} failure(s)`);
print('ok');
