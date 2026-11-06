#!/usr/bin/env python3
"""RAZ-15: real Docker test of archived sources. Removes only its unique resources.
Run from the repository: python3 scripts/test-installation.py [commit]
Needs Linux, Git, Docker access and network for image builds. No production install.
"""
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parent.parent


def command(args, *, cwd=None, env=None, data=None, ok=True):
    result = subprocess.run(args, cwd=cwd, env=env, input=data, text=True, capture_output=True)
    if ok and result.returncode:
        # Only synthetic tests; still never echo commands/env or input credentials.
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stdout[-2500:]} {result.stderr[-2500:]}')
    return result


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


SEED = r'''
import { randomUUID } from 'node:crypto';
import { openDatabase, RecordRepository, PushSubscriptions } from '@razem/db';
import { ReminderWorker } from './apps/worker/dist/worker.js';
const db=openDatabase(process.env.DATABASE_PATH), s=db.sqlite;
s.prepare('UPDATE users SET must_change_password=0').run();
const users=s.prepare('SELECT * FROM users ORDER BY login').all();
const A={userId:users[0].id,householdId:users[0].household_id};
const repo=new RecordRepository(db);
for(const visibility of ['private','shared']) {
 const r=repo.create(A,{entityType:'note',id:randomUUID(),visibility,data:{title:`synthetic ${visibility}`,body:'synthetic only'}});
 if(r.status!=='ack') throw Error('seed note');
}
const due=new Date(Date.now()+7*86400000).toISOString();
const r=repo.create(A,{entityType:'task',id:randomUUID(),visibility:'private',data:{title:'synthetic reminder',description:'',assignee:'self',dueDate:null,dueAt:due,timezone:'Europe/Warsaw',completedAt:null,recurrence:null}});
if(r.status!=='ack') throw Error('seed task');
const session=randomUUID(), at=new Date().toISOString();
s.prepare('INSERT INTO sessions VALUES (?,?,?,NULL,NULL,?,?,?)').run(session,A.userId,randomUUID().replaceAll('-','').repeat(2),at,at,new Date(Date.now()+30*86400000).toISOString());
new PushSubscriptions(db).subscribe(A.userId,session,{deviceId:randomUUID(),subscription:{endpoint:`https://web.push.apple.com/${randomUUID()}`,expirationTime:null,keys:{p256dh:'synthetic',auth:'synthetic'}}},at);
new ReminderWorker(db,async()=>{throw Error('no outbound push allowed')}).plan();
if(s.prepare("SELECT count(*) n FROM reminder_dispatches WHERE state='pending'").get().n!==1) throw Error('missing real queue');
db.close();
'''

CHECK = r'''
import { openDatabase, RecordRepository } from '@razem/db';
const db=openDatabase(process.env.DATABASE_PATH), s=db.sqlite;
const users=s.prepare('SELECT * FROM users ORDER BY login').all();
if(users.length!==2) throw Error('accounts');
const A={userId:users[0].id,householdId:users[0].household_id}, B={userId:users[1].id,householdId:users[1].household_id};
const repo=new RecordRepository(db);
if(repo.list(A,'note').length!==2 || repo.list(B,'note').length!==1) throw Error('privacy');
if(s.pragma('integrity_check',{simple:true})!=='ok' || s.pragma('foreign_key_check').length) throw Error('integrity');
console.log(JSON.stringify({users,notes:s.prepare('SELECT * FROM notes ORDER BY id').all(),migrations:s.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),queue:s.prepare('SELECT * FROM reminder_dispatches ORDER BY id').all(),sessions:s.prepare('SELECT * FROM sessions ORDER BY id').all()}));
db.close();
'''


def inside(project, commit):
    root = Path.cwd()
    testdir = root.parent
    port, tlsport = free_port(), free_port()
    used_ports = [port, tlsport]
    # All Docker default pools can already be allocated by unrelated projects.
    # Choose a free explicit /28; never remove or reconfigure any existing network.
    import ipaddress
    network_ids = command(['docker', 'network', 'ls', '-q']).stdout.split()
    allocated = [ipaddress.ip_network(c['Subnet']) for n in json.loads(command(['docker', 'network', 'inspect', *network_ids]).stdout)
                 for c in (n['IPAM']['Config'] or []) if c.get('Subnet')]
    subnet = next(str(n) for n in ipaddress.ip_network('10.249.0.0/16').subnets(new_prefix=28)
                  if not any(n.overlaps(a) for a in allocated if a.version == 4))
    version = commit[:7]
    env = dict(os.environ, APP_VERSION=version, INSTALL_USER='synthetic-owner', INSTALL_UID='1000',
               INSTALL_GID='1000', INSTALL_HOME='/home/synthetic-owner', RAZEM_PROJECT_NAME=project,
               HTTP_PORT=str(port), VAPID_SUBJECT='mailto:synthetic@example.test', RAZEM_NETWORK_SUBNET=subnet)
    bootstrap = {'householdName': 'Synthetic only', 'timezone': 'Europe/Warsaw', 'members': [
        {'login': 'alpha@example.test', 'displayName': 'Synthetic A', 'temporaryPassword': 'Temporary-5qWe!0987'},
        {'login': 'beta@example.test', 'displayName': 'Synthetic B', 'temporaryPassword': 'Temporary-9zRt!5432'}]}
    bootstrap_file = testdir / 'bootstrap.json'
    bootstrap_file.write_text(json.dumps(bootstrap))
    bootstrap_file.chmod(0o600)
    env['RAZEM_BOOTSTRAP_FILE'] = str(bootstrap_file)
    (root / '.env').write_text('UNRELATED=keep-literal-$(not-executed)\n')
    (root / '.env').chmod(0o600)
    os.chown(root / '.env', 1000, 1000)
    print(f'TEST {project}: HTTP {port}, TLS {tlsport}, subnet {subnet}', flush=True)
    checks = []
    images = set()
    extra_projects = []

    def passed(label):
        checks.append(label)
        print(f'PASS {label}', flush=True)

    def install(extra=None, success=True, args=()):
        result = command(['sh', 'scripts/install_server.sh', *args], cwd=root,
                         env=dict(env, **(extra or {})), ok=False)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        for member in bootstrap['members']:
            assert member['temporaryPassword'] not in result.stdout + result.stderr
        if (root / '.razem/config.json').exists():
            key = state()['env'].get('VAPID_PRIVATE_KEY')
            assert not key or key not in result.stdout + result.stderr
        return result

    def state():
        return json.loads((root / '.razem/config.json').read_text())

    def dc(*args, data=None, config=None, check=True):
        cfg = config or state()
        cenv = {'PATH': os.environ['PATH'], 'HOME': '/root', **cfg['env']}
        return command(['docker', 'compose', '--project-name', cfg['project'], '--env-file', '/dev/null',
                        '-f', str(root / 'deploy/compose.yaml'), *args], cwd=root, env=cenv, data=data, ok=check)

    def js(code, database=None):
        args = ['exec', '-T']
        if database:
            args += ['-e', f'DATABASE_PATH={database}']
        return dc(*args, 'app', 'node', '--input-type=module', '-', data=code).stdout

    def snapshot():
        return json.loads(js(CHECK))

    try:
        before = (root / '.env').read_bytes()
        install(args=('--preflight',))
        assert not (root / '.razem').exists() and (root / '.env').read_bytes() == before
        passed('read-only preflight from git archive without .git')
        install()
        cfg = state()
        images.add(cfg['env']['RAZEM_IMAGE'])
        assert (root / '.env').read_text() == f'UNRELATED=keep-literal-$(not-executed)\nAPP_VERSION={version}\n'
        assert cfg['env']['RAZEM_BIND_ADDRESS'] == '127.0.0.1'
        assert cfg['env']['VAPID_PUBLIC_KEY'] and cfg['env']['VAPID_PRIVATE_KEY']
        logs = dc('logs', '--no-color', 'app', 'worker').stdout
        assert cfg['env']['VAPID_PRIVATE_KEY'] not in logs
        assert all(m['temporaryPassword'] not in logs for m in bootstrap['members'])
        assert (root / '.env').stat().st_uid == 1000 and (root / '.env').stat().st_mode & 0o777 == 0o600
        assert command(['curl', '-fsS', f'http://127.0.0.1:{port}/']).stdout.startswith('<!doctype html>')
        passed('fresh install: healthy app+worker, HTTP+UI, VAPID, INSTALL_*, version after success')
        js(SEED)
        baseline = snapshot()
        assert len(baseline['migrations']) == 6 and len(baseline['queue']) == 1
        hashes = [u['password_hash'] for u in baseline['users']]
        bootstrap_file.unlink()
        env.pop('RAZEM_BOOTSTRAP_FILE')
        env.pop('HTTP_PORT')  # prove persisted nondefault port is honored
        install()
        assert snapshot() == baseline and state()['env']['HTTP_PORT'] == str(port)
        assert state()['env']['VAPID_PRIVATE_KEY'] == cfg['env']['VAPID_PRIVATE_KEY']
        assert [u['password_hash'] for u in snapshot()['users']] == hashes
        passed('repeat: data, password hashes, VAPID, queue and port preserved; migrations once')
        dc('restart', 'app', 'worker')
        dc('up', '-d', '--wait', '--wait-timeout', '90', 'app', 'worker')
        assert snapshot() == baseline
        ids = dc('ps', '-q', 'app', 'worker').stdout.split()
        inspect = json.loads(command(['docker', 'inspect', *ids]).stdout)
        for item in inspect:
            assert item['Config']['User'] == 'node'
            assert item['HostConfig']['ReadonlyRootfs']
            assert item['State']['Health']['Status'] == 'healthy'
            assert item['HostConfig']['RestartPolicy']['Name'] == 'unless-stopped'
            assert all(portname == '3100/tcp' for portname in item['NetworkSettings']['Ports'])
        passed('container restart: SQLite+real reminder queue preserved, non-root, readonly, no DB port')
        # Unrelated service on a chosen port; an install must fail without stopping its own services.
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen()
            badport = occupied.getsockname()[1]
            used_ports.append(badport)
            result = install({'HTTP_PORT': str(badport), 'APP_VERSION': 'should-not-publish'}, success=False)
            assert 'zajęty' in result.stderr
            assert (root / '.env').read_bytes() == before + f'APP_VERSION={version}\n'.encode()
            assert all(x['State']['Running'] for x in json.loads(command(['docker', 'inspect', *ids]).stdout))
        passed('occupied foreign port refused before service mutation; version unchanged')
        # Failed build must leave the running installation and successful version alone.
        dockerfile = root / 'deploy/Dockerfile'
        original = dockerfile.read_text()
        dockerfile.write_text('FROM this-image-does-not-exist.invalid/raz15:0\n')
        result = install({'APP_VERSION': 'broken-build'}, success=False)
        dockerfile.write_text(original)
        assert 'build obrazu' in result.stderr and snapshot() == baseline
        assert f'APP_VERSION={version}\n' in (root / '.env').read_text()
        passed('controlled build failure: nonzero exit, no false version, existing app survives')
        # Actual update; explicitly bind only a host bridge address reachable by a container proxy.
        gateway = json.loads(command(['docker', 'network', 'inspect', 'bridge']).stdout)[0]['IPAM']['Config'][0]['Gateway']
        updated = version + '-update'
        install({'APP_VERSION': updated, 'RAZEM_BIND_ADDRESS': gateway})
        cfg2 = state()
        images.add(cfg2['env']['RAZEM_IMAGE'])
        assert snapshot() == baseline and state()['env']['VAPID_PRIVATE_KEY'] == cfg['env']['VAPID_PRIVATE_KEY']
        assert (root / '.razem/previous.json').exists()
        assert f'APP_VERSION={updated}\n' in (root / '.env').read_text()
        passed('update: old-image verified backup, data+queue+keys preserved, HTTP_PORT retained')
        network = project + '_default'
        command(['docker', 'run', '--rm', '--network', network, '--entrypoint', 'curl', os.environ['RAZ15_HARNESS'],
                 '-fsS', f'http://{gateway}:{port}/readyz'])
        passed('HTTP upstream reachable from isolated container proxy network on selected port')
        # Force startup failure after backup/migration. No false version, then repair using same sources.
        env['RAZEM_TRUST_PROXY'] = 'invalid-proxy-address'
        result = install({'APP_VERSION': version + '-bad-start'}, success=False)
        images.add(f'razem-{project}:{version}-bad-start')
        assert 'start i gotowość' in result.stderr
        assert f'APP_VERSION={updated}\n' in (root / '.env').read_text()
        env.pop('RAZEM_TRUST_PROXY')
        install({'APP_VERSION': updated, 'RAZEM_BIND_ADDRESS': gateway})
        assert snapshot() == baseline
        passed('controlled startup failure and repair: nonzero exit, successful version+data preserved')
        # Restore newest checked daily backup, without replacing the live SQLite file.
        archive = js("import{readdirSync,readFileSync}from'node:fs';const p='/data/backups/';const a=readdirSync(p).filter(n=>JSON.parse(readFileSync(p+n+'/manifest.json')).kind==='daily');console.log(p+a.at(-1))").strip()
        dc('exec', '-T', 'app', 'node', 'apps/server/dist/admin.js', 'restore', '--archive', archive, '--target', '/data/recovery-test')
        recovered = json.loads(js(CHECK, '/data/recovery-test/razem.sqlite'))
        assert recovered['users'] == baseline['users'] and recovered['notes'] == baseline['notes']
        assert recovered['migrations'] == baseline['migrations'] and recovered['sessions'] == []
        assert recovered['queue'] == []  # FK cascade after subscription revocation
        # Run the retained old image against the restored directory on an isolated port.
        recovery_port = free_port()
        used_ports.append(recovery_port)
        name = project + '-recovery'
        volume = project + '_data'
        command(['docker', 'run', '-d', '--name', name, '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp',
                 '-e', 'DATABASE_PATH=/data/recovery-test/razem.sqlite', '-p', f'127.0.0.1:{recovery_port}:3100',
                 '-v', volume + ':/data', cfg['image_id']])
        try:
            for _ in range(30):
                ready = command(['curl', '-fsS', f'http://127.0.0.1:{recovery_port}/readyz'], ok=False)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            assert ready.returncode == 0
        finally:
            command(['docker', 'rm', '-f', name])
        passed('verified restore + old-image rollback HTTP: ACL/data preserved, sessions/push revoked')
        # Real schema upgrade v3 -> v6 plus snapshot restore, with synthetic private/shared data.
        js("""
import {openDatabase,migrate,migrations} from '@razem/db';
const d=openDatabase('/data/legacy/razem.sqlite'); migrate(d.sqlite,{list:migrations.slice(0,3)});
d.sqlite.exec("ATTACH DATABASE '/data/razem.sqlite' AS current; INSERT INTO households SELECT * FROM current.households; INSERT INTO users SELECT * FROM current.users; INSERT INTO notes SELECT * FROM current.notes; DETACH DATABASE current;");
d.close();
""")
        def legacy_admin(*args, success=True):
            result = dc('run', '--rm', '--no-deps', '-T', '-e', 'DATABASE_PATH=/data/legacy/razem.sqlite',
                        'app', 'node', 'apps/server/dist/admin.js', *args, check=False)
            assert (result.returncode == 0) == success
            return result.stdout
        assert '4, 5, 6' in legacy_admin('migrate')
        legacy = json.loads(js(CHECK, '/data/legacy/razem.sqlite'))
        assert legacy['notes'] == baseline['notes'] and len(legacy['migrations']) == 6
        assert 'Schemat aktualny' in legacy_admin('migrate')
        assert json.loads(js(CHECK, '/data/legacy/razem.sqlite')) == legacy
        snapshot_path = js("import{readdirSync}from'node:fs';const a=readdirSync('/data/legacy').filter(n=>n.includes('.pre-migration-v3-'));if(a.length!==1)throw Error('snapshot count');console.log('/data/legacy/'+a[0])").strip()
        dc('exec', '-T', 'app', 'node', 'apps/server/dist/admin.js', 'restore', '--snapshot', snapshot_path,
           '--target', '/data/legacy-rollback')
        info = json.loads(js("import{readFileSync}from'node:fs';console.log(readFileSync('/data/legacy-rollback/restore.json','utf8'))"))
        assert info['schemaVersion'] == 3
        js("import{openDatabase}from'@razem/db';const d=openDatabase(process.env.DATABASE_PATH);d.sqlite.prepare(\"UPDATE schema_migrations SET checksum='controlled-corruption' WHERE version=6\").run();d.close()", '/data/legacy/razem.sqlite')
        legacy_admin('migrate', success=False)
        # Repair only the deliberately corrupted test ledger from the untouched baseline.
        checksum = baseline['migrations'][-1]['checksum']
        js(f"import{{openDatabase}}from'@razem/db';const d=openDatabase(process.env.DATABASE_PATH);d.sqlite.prepare('UPDATE schema_migrations SET checksum=? WHERE version=6').run({json.dumps(checksum)});d.close()", '/data/legacy/razem.sqlite')
        legacy_admin('migrate')
        passed('schema v3->v6: snapshot before migration, idempotent repeat, v3 restore, corrupt checksum refused and repaired')
        # Optional non-root Caddy, real local CA and TLS verification (no -k).
        cenv = {'PATH': os.environ['PATH'], 'HOME': '/root', **state()['env'], 'RAZEM_SITE_ADDRESS': 'razem.test',
                'RAZEM_HTTPS_PORT': str(tlsport), 'RAZEM_CADDY_IMAGE': project + '-caddy:check'}
        images.add(cenv['RAZEM_CADDY_IMAGE'])
        cargs = ['docker', 'compose', '--project-name', project, '--env-file', '/dev/null', '-f', str(root / 'deploy/compose.yaml'),
                 '-f', str(root / 'deploy/compose.caddy.yaml'), '--profile', 'caddy']
        caddy_result = command(cargs + ['up', '-d', '--build', '--wait', '--wait-timeout', '90'], cwd=root, env=cenv, ok=False)
        if caddy_result.returncode:
            print(command(cargs + ['logs', '--tail', '30', 'caddy'], cwd=root, env=cenv).stdout, flush=True)
            cid = command(cargs + ['ps', '-aq', 'caddy'], cwd=root, env=cenv).stdout.strip()
            print(command(['docker', 'inspect', cid, '--format', '{{json .State.Health}}']).stdout, flush=True)
        assert caddy_result.returncode == 0, 'Caddy not healthy'
        crt = command(cargs + ['exec', '-T', 'caddy', 'cat', '/data/caddy/pki/authorities/local/root.crt'], cwd=root, env=cenv).stdout
        cert = testdir / 'root.crt'
        cert.write_text(crt)
        command(['curl', '-fsS', '--noproxy', '*', '--cacert', str(cert), '--resolve', f'razem.test:{tlsport}:127.0.0.1', f'https://razem.test:{tlsport}/readyz'])
        passed('optional Caddy: non-root local CA, trusted TLS and proxied readiness')
        print(json.dumps({'commit': commit, 'checks': checks, 'ports': used_ports, 'cleanup': 'see final cleanup assertion'}), flush=True)
    finally:
        # Exact unique project labels only. Also catches containers from failed compose run/build.
        for p in [project, *extra_projects]:
            ids = command(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={p}']).stdout.split()
            if ids:
                command(['docker', 'rm', '-f', *ids])
            networks = command(['docker', 'network', 'ls', '-q', '--filter', f'label=com.docker.compose.project={p}']).stdout.split()
            if networks:
                command(['docker', 'network', 'rm', *networks])
            volumes = command(['docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={p}']).stdout.split()
            if volumes:
                command(['docker', 'volume', 'rm', *volumes])
        # Capture tags even if installer failed before persisting successful state.
        images.update(command(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', f'reference=razem-{project}:*']).stdout.split())
        for image in images:
            command(['docker', 'image', 'rm', image], ok=False)
        for path in [root / '.razem', testdir / 'bootstrap.json', testdir / 'root.crt']:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
        for portnumber in used_ports:
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(('127.0.0.1', portnumber))
        print('PASS cleanup: own containers/networks/volumes removed; ports free; temporary private files removed', flush=True)


def outside(revision):
    commit = command(['git', 'rev-parse', '--verify', revision + '^{commit}'], cwd=REPO).stdout.strip()
    project = 'raz15-' + uuid.uuid4().hex[:10]
    harness = project + '-harness:check'
    with tempfile.TemporaryDirectory(prefix=project + '-') as temp:
        testdir = Path(temp)
        root = testdir / 'installation'
        root.mkdir()
        archive = subprocess.check_output(['git', 'archive', commit], cwd=REPO)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(root, filter='data')
        assert not (root / '.git').exists()
        shutil.copy2(__file__, testdir / 'suite.py')
        (testdir / 'Dockerfile.harness').write_text('FROM docker:29.1.3-dind\nRUN apk add --no-cache python3 curl\n')
        try:
            print('Building isolated root/Linux/Docker CLI harness...', flush=True)
            command(['docker', 'build', '-f', str(testdir / 'Dockerfile.harness'), '-t', harness, str(testdir)])
            result = subprocess.run(['docker', 'run', '--rm', '--network', 'host', '--entrypoint', 'python3',
                                     '-e', 'RAZ15_HARNESS=' + harness, '-v', '/var/run/docker.sock:/var/run/docker.sock',
                                     '-v', f'{testdir}:{testdir}', '-w', str(root), harness, str(testdir / 'suite.py'),
                                     '--inside', project, commit])
            if result.returncode:
                raise RuntimeError('isolated installation suite failed (resources cleaned in finally)')
        finally:
            # Backstop even when an assertion interrupts the suite's final checks.
            command(['docker', 'run', '--rm', '--entrypoint', 'node', '-v', f'{testdir}:/cleanup',
                     'node:26.13.0-bookworm-slim', '-e',
                     "require('node:fs').rmSync('/cleanup/installation/.razem',{recursive:true,force:true})"], ok=False)
            command(['docker', 'image', 'rm', harness], ok=False)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--inside']:
        inside(sys.argv[2], sys.argv[3])
    else:
        outside(sys.argv[1] if len(sys.argv) > 1 else 'HEAD')
