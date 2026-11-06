#!/usr/bin/env python3
"""Root entry for ToDo's archived sources. No git, host Node, stdin or TTY."""
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.razem'
STEP = 'preflight'
KEYS = ('RAZEM_PUBLIC_ORIGIN', 'RAZEM_TRUST_PROXY', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'RAZEM_NETWORK_SUBNET')


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def private(path, directory=False):
    st = path.lstat()
    owners = {0, int(os.environ.get('INSTALL_UID', os.getuid()))}
    require((stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode))
            and st.st_uid in owners and st.st_mode & 0o077 == 0,
            'plik/katalog prywatny wymaga własnego właściciela i trybu 0600/0700')


def atomic(path, content, uid=0, gid=0):
    fd, name = tempfile.mkstemp(prefix='.install-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
            os.fchown(out.fileno(), uid, gid)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(args, env=None, data=None):
    result = subprocess.run(args, cwd=ROOT, env=env if env is not None else base_env(), input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    diagnostics = {
        'all predefined address pools have been fully subnetted': 'Docker nie ma wolnej podsieci; wybierz wolny RAZEM_NETWORK_SUBNET',
        'port is already allocated': 'Docker zgłasza zajęty port hosta',
        'no space left on device': 'brak miejsca w magazynie Docker/danych',
        'permission denied': 'odmowa dostępu do Docker/pliku/wolumenu',
        'unhealthy': 'kontener unhealthy; sprawdź prywatnie logs app/worker i konfigurację',
    }
    diagnosis = next((value for key, value in diagnostics.items() if key in (result.stdout + result.stderr).lower()),
                     'sprawdź Docker, konfigurację i stan usług')
    require(result.returncode == 0, f'{STEP}: polecenie {args[0]} nie powiodło się (kod {result.returncode}); {diagnosis}')
    return result.stdout


def base_env():
    # Do not inherit Compose overrides, bootstrap credentials or unrelated secrets.
    return {'PATH': os.environ.get('PATH', '/usr/sbin:/usr/bin:/sbin:/bin'), 'HOME': '/root'}


def compose(config, *args, data=None):
    env = base_env()
    env.update(config['env'])
    return run(['docker', 'compose', '--project-name', config['project'], '--env-file', '/dev/null',
                '-f', str(ROOT / 'deploy/compose.yaml'), *args], env, data)


def containers(project):
    ids = run(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={project}']).split()
    return json.loads(run(['docker', 'inspect', *ids])) if ids else []


def load_config():
    if STATE.exists() or STATE.is_symlink():
        private(STATE, True)
    path = STATE / 'config.json'
    if path.exists() or path.is_symlink():
        private(path)
        return json.loads(path.read_text())
    return None


def configuration(old):
    # Legacy .env is read as data, never sourced or evaluated. Private permissions required.
    legacy = {}
    if (ROOT / '.env').exists() or (ROOT / '.env').is_symlink():
        private(ROOT / '.env')
        for line in (ROOT / '.env').read_text().splitlines():
            match = re.fullmatch(r'([A-Z_]+)=(.*)', line)
            if match:
                legacy[match[1]] = match[2].strip().strip('\"\'')
    env = dict(old['env']) if old else {key: legacy.get(key, '') for key in KEYS}
    if not old:
        env['RAZEM_PUBLIC_ORIGIN'] = legacy.get('RAZEM_PUBLIC_ORIGIN', legacy.get('PUBLIC_ORIGIN', ''))
        env['RAZEM_TRUST_PROXY'] = legacy.get('RAZEM_TRUST_PROXY', legacy.get('TRUST_PROXY', ''))
    for key in KEYS:
        if key in os.environ:
            # Existing VAPID keys remain stable. A rotation is a separate explicit operation.
            require(not (old and key.startswith('VAPID_') and env.get(key) and env[key] != os.environ[key]),
                    'odmowa zmiany istniejącego VAPID; użyj osobnej procedury rotacji')
            env[key] = os.environ[key]
    project = os.environ.get('RAZEM_PROJECT_NAME', old['project'] if old else 'razem')
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,48}', project), 'niepoprawna nazwa projektu Compose')
    require(not old or old['project'] == project, 'nie zmieniaj nazwy projektu istniejącego wolumenu')
    port = os.environ.get('HTTP_PORT') or (old['env']['HTTP_PORT'] if old else legacy.get('HTTP_PORT') or legacy.get('RAZEM_PORT') or '3000')
    require(re.fullmatch(r'[0-9]{1,5}', port) and 1024 <= int(port) <= 65535, 'HTTP_PORT musi być w zakresie 1024–65535')
    bind = os.environ.get('RAZEM_BIND_ADDRESS', env.get('RAZEM_BIND_ADDRESS', legacy.get('RAZEM_BIND_ADDRESS', '127.0.0.1')))
    require(ipaddress.ip_address(bind).version == 4 and bind != '0.0.0.0', 'RAZEM_BIND_ADDRESS: podaj konkretny IPv4 hosta (domyślnie loopback)')
    version = os.environ.get('APP_VERSION', '')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,80}', version), 'wymagany poprawny APP_VERSION (SHA albo wersja pakietu)')
    env.update(HTTP_PORT=port, RAZEM_BIND_ADDRESS=bind, RAZEM_IMAGE=f'razem-{project}:{version}')
    if env.get('RAZEM_NETWORK_SUBNET'):
        require(ipaddress.ip_network(env['RAZEM_NETWORK_SUBNET']).version == 4, 'podsieć Docker musi być IPv4')
    require(not old or env.get('RAZEM_NETWORK_SUBNET', '') == old['env'].get('RAZEM_NETWORK_SUBNET', ''),
            'zmiana podsieci istniejącej instalacji wymaga osobnej operacji')
    require(all('\n' not in value and '\r' not in value for value in env.values()), 'konfiguracja musi być jednoliniowa')
    config = {'project': project, 'env': env, 'version': version}
    return config


def preflight(config):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'instalator wymaga Linux i root')
    require(shutil.which('docker'), 'wymagany Docker Engine i plugin Compose v2')
    run(['docker', 'info', '--format', '{{.OSType}}'])
    version = run(['docker', 'compose', 'version', '--short']).strip().lstrip('v').split('.')
    require(tuple(map(int, version[:2])) >= (2, 24), 'wymagany Compose >=2.24')
    require(shutil.disk_usage(ROOT).free >= 2 * 1024**3, 'wymagane minimum 2 GiB wolnego miejsca')
    if os.environ.get('INSTALL_UID'):
        require(int(os.environ['INSTALL_UID']) >= 0 and int(os.environ['INSTALL_GID']) >= 0
                and os.environ.get('INSTALL_USER') and os.environ.get('INSTALL_HOME', '').startswith('/'), 'niepełne INSTALL_*')
    owned = containers(config['project'])
    for item in owned:
        labels = item['Config']['Labels']
        require(labels.get('com.docker.compose.project.working_dir') == str(ROOT / 'deploy'),
                'nazwa Compose zajęta przez inną instalację; wybierz RAZEM_PROJECT_NAME')
    port = config['env']['HTTP_PORT']
    bind = config['env']['RAZEM_BIND_ADDRESS']
    own_port = any(item['State']['Running'] and any(p['HostIp'] == bind and p['HostPort'] == port
                   for p in (item['NetworkSettings']['Ports'].get('3100/tcp') or [])) for item in owned)
    if not own_port:
        with socket.socket() as sock:
            try:
                sock.bind((bind, int(port)))
            except OSError:
                raise RuntimeError('wybrany HTTP_PORT/adres jest zajęty albo niedostępny; nie zmieniono usług') from None
    compose(config, 'config', '--quiet')


def bootstrap_data():
    raw = os.environ.get('RAZEM_BOOTSTRAP_JSON', '')
    if os.environ.get('RAZEM_BOOTSTRAP_FILE'):
        require(not raw, 'podaj jeden sposób dostarczenia bootstrapu')
        path = Path(os.environ['RAZEM_BOOTSTRAP_FILE'])
        private(path)
        require(path.stat().st_size <= 16384, 'bootstrap jest zbyt duży')
        raw = path.read_text()
    require(len(raw) <= 16384, 'bootstrap jest zbyt duży')
    if raw:
        try:
            json.loads(raw)
        except ValueError:
            raise RuntimeError('niepoprawny JSON bootstrapu') from None
    return raw


def install():
    global STEP
    old = load_config()
    config = configuration(old)
    bootstrap = bootstrap_data()
    preflight(config)
    if sys.argv[1:] == ['--preflight']:
        print('Razem: preflight OK; bez zmian')
        return
    require(not sys.argv[1:], 'użycie: sh scripts/install_server.sh [--preflight]')
    if not STATE.exists():
        STATE.mkdir(mode=0o700)
    private(STATE, True)
    lock = (STATE / 'install.lock')
    if lock.exists() or lock.is_symlink():
        private(lock)
    with lock.open('a') as handle:
        os.chmod(lock, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('inna instalacja Razem już trwa') from None
        require(load_config() == old, 'konfiguracja zmieniła się podczas preflight; ponów instalację')
        STEP = 'build obrazu'
        print('Razem: preflight OK; budowanie obrazu', flush=True)
        compose(config, 'build', 'app')
        env = config['env']
        if env.get('VAPID_SUBJECT') and not env.get('VAPID_PUBLIC_KEY') and not env.get('VAPID_PRIVATE_KEY'):
            STEP = 'generowanie VAPID'
            keys = json.loads(compose(config, 'run', '--rm', '--no-deps', '-T', 'app', 'node', '-e',
                                     "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"))
            env.update(VAPID_PUBLIC_KEY=keys['publicKey'], VAPID_PRIVATE_KEY=keys['privateKey'])
        # Persist fresh secrets before any fallible migration/start; retries reuse them.
        if not old:
            atomic(STATE / 'config.json', json.dumps(config))
        STEP = 'zatrzymanie własnych usług'
        compose(old or config, 'stop', 'worker', 'app')
        if old and old.get('image_id'):
            STEP = 'backup przed aktualizacją (stary obraz, bez migracji)'
            old_image = old.get('image_id')
            backup_config = json.loads(json.dumps(old))
            if old_image:
                # Compose v5 interprets a bare sha256 ID as repository:tag and may rebuild it.
                # Give the immutable image an explicit local tag; never pull/build during backup.
                retained = f"razem-{config['project']}:retained-{old_image.removeprefix('sha256:')[:24]}"
                run(['docker', 'image', 'tag', old_image, retained])
                backup_config['env']['RAZEM_IMAGE'] = retained
            compose(backup_config, 'run', '--rm', '--no-deps', '--no-build', '--pull', 'never', '-T', 'app', 'node',
                    'apps/server/dist/admin.js', 'backup', '--config-file', '/data/installation.env')
            atomic(STATE / 'previous.json', json.dumps(old))
        STEP = 'kontrolowane migracje'
        compose(config, 'run', '--rm', '--no-deps', '-T', 'app', 'node', 'apps/server/dist/admin.js', 'migrate')
        STEP = 'bootstrap dwóch kont (prywatny JSON)'
        compose(config, 'run', '--rm', '--no-deps', '-T', 'app', 'node', 'deploy/bootstrap.mjs', data=bootstrap)
        STEP = 'zapis prywatnej konfiguracji do backupu'
        installation_env = ''.join(f'{key}={value}\n' for key, value in env.items())
        compose(config, 'run', '--rm', '--no-deps', '-T', 'app', 'node', '-e',
                "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('node:fs').writeFileSync('/data/installation.env',s,{mode:0o600}))", data=installation_env)
        STEP = 'start i gotowość app/worker'
        compose(config, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'app', 'worker')
        STEP = 'gotowość HTTP na wybranym porcie'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://{env['RAZEM_BIND_ADDRESS']}:{env['HTTP_PORT']}/readyz", timeout=5) as response:
            require(response.status == 200, 'HTTP readiness nie zwraca 200')
        config['image_id'] = run(['docker', 'image', 'inspect', env['RAZEM_IMAGE'], '--format', '{{.Id}}']).strip()
        atomic(STATE / 'config.json', json.dumps(config))
        STEP = 'zapis wersji po sukcesie'
        path = ROOT / '.env'
        st = path.stat() if path.exists() else None
        text = path.read_text() if st else ''
        text = re.sub(r'^APP_VERSION=.*(?:\n|$)', '', text, flags=re.M)
        atomic(path, text.rstrip('\n') + ('\n' if text else '') + f"APP_VERSION={config['version']}\n",
               st.st_uid if st else int(os.environ.get('INSTALL_UID', 0)),
               st.st_gid if st else int(os.environ.get('INSTALL_GID', 0)))
        print(f"Razem: gotowe; HTTP {env['RAZEM_BIND_ADDRESS']}:{env['HTTP_PORT']}; app i worker healthy; wersja {config['version']}")


if __name__ == '__main__':
    try:
        if sys.argv[1:2] == ['compose']:
            config = load_config()
            require(config, 'brak konfiguracji instalacji')
            # Operators intentionally get normal Docker output. Never use config without --quiet in logs.
            env = base_env()
            env.update(config['env'])
            os.execvpe('docker', ['docker', 'compose', '--project-name', config['project'], '--env-file', '/dev/null',
                                 '-f', str(ROOT / 'deploy/compose.yaml'), *sys.argv[2:]], env)
        else:
            install()
    except (RuntimeError, OSError, ValueError, KeyError):
        # No exception values from JSON/URLs/subprocess output: these can contain secrets.
        error = sys.exc_info()[1]
        message = str(error) if isinstance(error, RuntimeError) else 'niepoprawne dane lub niedostępny zasób'
        print(f'Razem: BŁĄD [{STEP}]: {message}', file=sys.stderr)
        sys.exit(1)
