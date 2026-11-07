#!/usr/bin/env python3
"""Check or install a reviewed origin/main update for a source-installed Local Reader Mac app."""
import argparse
from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import shlex
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen
import uuid

APP = Path('/Applications/Local Reader.app')
DATA = Path.home() / 'Library/Application Support/Local Reader'
UPSTREAM_REPOSITORY = 'ethanniser/local-reader'


def default_python():
    """The reader's Python, resolved like the app: override, recorded at build, standard venv, earlier venv."""
    if os.environ.get('LOCAL_READER_PYTHON'):
        return Path(os.environ['LOCAL_READER_PYTHON']).expanduser()
    try:
        with (APP/'Contents/Info.plist').open('rb') as stream:
            recorded=plistlib.load(stream).get('LocalReaderPython')
        if isinstance(recorded,str) and recorded:
            return Path(recorded).expanduser()
    except Exception:
        pass
    current = Path.home() / 'Library/Caches/local-reader/venv/bin/python'
    legacy = Path.home() / 'Library/Caches/antikythera-local-tts/venv/bin/python'
    return legacy if not current.exists() and legacy.exists() else current


PYTHON = default_python()


def build_env():
    """Keep a custom Python recorded in the rebuilt app; standard locations need no record."""
    standard={Path.home()/'Library/Caches/local-reader/venv/bin/python',Path.home()/'Library/Caches/antikythera-local-tts/venv/bin/python'}
    return {} if PYTHON in standard else {'LOCAL_READER_PYTHON':str(PYTHON)}
# Launched from the app, PATH is launchd's minimal default; add the usual tool locations.
TOOL_PATH = os.pathsep.join([str(Path.home()/'.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', str(Path.home()/'.local/bin'),
                             os.environ.get('PATH','/usr/bin:/bin:/usr/sbin:/sbin')])


class UpdateError(Exception):
    pass


def run(args, cwd=None, *, timeout=180, env=None):
    result = subprocess.run([str(a) for a in args], cwd=cwd, env={**os.environ, 'PATH': TOOL_PATH, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS':'/usr/bin/false', 'SSH_ASKPASS':'/usr/bin/false', 'GCM_INTERACTIVE':'Never', 'GIT_SSH_COMMAND':'ssh -o BatchMode=yes', **(env or {})},
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if result.returncode:
        # Commands can emit credentials or article content. Never relay raw output.
        raise UpdateError(f'{Path(str(args[0])).name} failed. The current installation was kept where possible.')
    return result.stdout.strip()


def git(source, *args):
    return run(['git', '-C', source, *args])


def clean(source):
    return not git(source, 'status', '--porcelain', '--untracked-files=normal')


def ancestor(source, older, newer):
    return subprocess.run(['git', '-C', str(source), 'merge-base', '--is-ancestor', older, newer],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def version(source, revision):
    text = git(source, 'show', revision + ':desktop/build.sh')
    match = re.search(r"'CFBundleShortVersionString':\s*'([^']+)'", text)
    build = re.search(r"'CFBundleVersion':\s*'([^']+)'", text)
    return (match[1] if match else 'unknown') + ' (' + (build[1] if build else '?') + ')'


def github_repository(url):
    """Return 'owner/name' (lowercase) for a GitHub SSH/HTTPS remote, else None."""
    match = re.fullmatch(r'(?:git@github\.com:|ssh://git@github\.com/|https://github\.com/)([A-Za-z0-9-]+/[A-Za-z0-9._-]+?)(?:\.git)?/?', url.strip())
    return match[1].lower() if match else None


def expected_repository():
    """The only repository updates may come from: an override, the one recorded when the app was built, or upstream."""
    if os.environ.get('LOCAL_READER_UPDATE_REPOSITORY'):
        return os.environ['LOCAL_READER_UPDATE_REPOSITORY']
    try:
        with (APP/'Contents/Info.plist').open('rb') as stream:
            recorded=plistlib.load(stream).get('LocalReaderUpdateRepository')
    except Exception:  # missing or malformed plist: fall back to upstream
        recorded=None
    return recorded if isinstance(recorded,str) and re.fullmatch(r'[A-Za-z0-9-]+/[A-Za-z0-9._-]+',recorded) else UPSTREAM_REPOSITORY


def inspect(source, *, fetch=True):
    if not source.is_dir() or git(source, 'rev-parse', '--show-toplevel') != str(source):
        raise UpdateError('Choose the installed Local Reader repository root.')
    origin=git(source,'remote','get-url','origin')
    repository=expected_repository()
    if github_repository(origin)!=repository.lower():
        raise UpdateError(f'Origin is not the expected {repository} repository. No fetch was attempted.')
    current = git(source, 'rev-parse', 'HEAD')
    branch = git(source, 'branch', '--show-current')
    if fetch:
        git(source, 'fetch', '--quiet', 'origin', 'main')
        latest = git(source, 'rev-parse', 'FETCH_HEAD')
    else:
        latest = git(source, 'rev-parse', 'origin/main')
    try:
        with (APP/'Contents/Info.plist').open('rb') as stream: installed=plistlib.load(stream)
    except Exception: installed={}
    installed_revision=installed.get('LocalReaderRevision','')
    installed_version=str(installed.get('CFBundleShortVersionString','unknown'))+' ('+str(installed.get('CFBundleVersion','?'))+')'
    dirty = not clean(source)
    compatible = ancestor(source, current, latest)
    reason = 'Ready to update.'
    if dirty: reason = 'The installed source has local changes. Commit or move them before updating.'
    elif branch != 'main': reason = 'The installed source must be on main before updating.'
    elif not compatible: reason = 'Installed main has diverged; update it manually without discarding local commits.'
    elif current == latest and installed_revision == latest: reason = 'Already up to date.'
    return {'currentCommit':current, 'latestCommit':latest, 'updateAvailable':current != latest or installed_revision != latest, 'installedCommit':installed_revision,
            'dirty':dirty, 'canInstall':not dirty and branch == 'main' and compatible,
            'currentVersion':installed_version, 'latestVersion':version(source,latest), 'message':reason}


def backup_database(source, destination):
    if not source.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(source)) as original, closing(sqlite3.connect(destination)) as backup:
        original.backup(backup)
        backup.commit()
    os.chmod(destination, 0o600)


def restore_source(source, old, installed):
    if git(source, 'rev-parse', 'HEAD') != installed or not clean(source):
        raise UpdateError('Source changed during update. Automatic rollback stopped to preserve your edits.')
    # --keep aborts rather than overwriting local changes. Never use --hard here.
    git(source, 'reset', '--keep', old)


def listener(source):
    found = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:8787', '-sTCP:LISTEN', '-t'], capture_output=True, text=True)
    pids = set(found.stdout.split())
    if not pids: return None
    if len(pids) != 1: raise UpdateError('More than one process owns port 8787; stop Local Reader manually.')
    pid = int(pids.pop())
    command = run(['/bin/ps','-ww','-p',str(pid),'-o','command='])
    cwd = run(['/usr/sbin/lsof','-a','-p',str(pid),'-d','cwd','-Fn'])
    args=shlex.split(command)
    expected=[str(PYTHON),'-m','uvicorn','server.app:app','--host','127.0.0.1','--port','8787']
    if args != expected or 'n'+str(source) not in cwd.splitlines():
        raise UpdateError('Port 8787 belongs to an unrecognized process. No process was stopped.')
    return pid


def stop_server(source):
    pid = listener(source)
    if pid is None: return
    os.kill(pid, signal.SIGTERM)
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        try: os.kill(pid,0)
        except ProcessLookupError: return
        time.sleep(.25)
    raise UpdateError('Local Reader server did not exit cleanly. No force-kill was attempted.')


def start_server(source):
    DATA.mkdir(parents=True,exist_ok=True)
    with (DATA/'server.log').open('a') as log:
        return subprocess.Popen([str(PYTHON),'-m','uvicorn','server.app:app','--host','127.0.0.1','--port','8787'],cwd=source,
                                stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)


def healthy(process, source, seconds=30):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if process.poll() is not None: return False
        try:
            with urlopen('http://127.0.0.1:8787/api/status',timeout=1) as response:
                if json.load(response).get('local') is True and listener(source)==process.pid: return True
        except Exception: pass
        time.sleep(.3)
    return False


def wait_parent(pid):
    if not pid: return
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        result=subprocess.run(['/bin/ps','-ww','-p',str(pid),'-o','command='],capture_output=True,text=True)
        if result.returncode: return
        if str(APP/'Contents/MacOS/LocalReader') not in result.stdout:
            raise UpdateError('The supplied parent process is not the installed Local Reader app.')
        time.sleep(.25)
    raise UpdateError('Close the Local Reader window application before installing the update.')


def check_app_closed():
    result=subprocess.run(['/usr/bin/pgrep','-f','^'+re.escape(str(APP/'Contents/MacOS/LocalReader'))+'( |$)'],capture_output=True,text=True)
    if result.returncode == 0: raise UpdateError('Quit Local Reader.app before installing. The library server can stay running.')


def replace_directory(staged, destination):
    replacement=destination.with_name(destination.name+'.update-'+uuid.uuid4().hex)
    try:
        shutil.copytree(staged,replacement)
    except Exception:
        if replacement.exists(): shutil.rmtree(replacement)
        raise
    parked=destination.with_name(destination.name+'.previous-'+uuid.uuid4().hex)
    try:
        if destination.exists(): os.replace(destination,parked)
        try: os.replace(replacement,destination)
        except Exception:
            if parked.exists(): os.replace(parked,destination)
            raise
    finally:
        if replacement.exists(): shutil.rmtree(replacement)
    if parked.exists(): shutil.rmtree(parked)


def install(source, revision, parent_pid, dry_run=False):
    info=inspect(source,fetch=not dry_run)
    if not info['canInstall']: raise UpdateError(info['message'])
    target=revision or info['latestCommit']
    if not re.fullmatch(r'[0-9a-f]{40,64}',target) or not ancestor(source,target,info['latestCommit']) or not ancestor(source,info['currentCommit'],target):
        raise UpdateError('Requested revision is not a fast-forward on fetched origin/main. Check for updates again.')
    if target == info['currentCommit'] and target == info.get('installedCommit'): return {**info,'success':True,'message':'Already up to date.'}
    if not PYTHON.is_file() or not APP.is_dir(): raise UpdateError('The existing Python environment or installed app is missing.')
    for command in ['git','bun','xcrun']:
        if not shutil.which(command,path=TOOL_PATH): raise UpdateError('Required command is missing: '+command)
    if dry_run: return {**info,'success':True,'dryRun':True,'targetCommit':target,'message':'Would build, back up, fast-forward, install, and verify this revision. No changes made.'}
    old=info['currentCommit']; changed=False; stopped=False; process=None; rollback=None
    backup=DATA/'updates'/(time.strftime('%Y%m%d-%H%M%S')+'-'+old[:10]+'-'+uuid.uuid4().hex[:6])
    with tempfile.TemporaryDirectory(prefix='local-reader-update-') as temporary:
        stage=Path(temporary)/'source'
        try:
            print('Building and checking the candidate update…',file=sys.stderr)
            git(source,'worktree','add','--detach',str(stage),target)
            run(['bun','install','--frozen-lockfile'],stage,timeout=600)
            run(['bun','run','build'],stage,timeout=600)
            testenv={'LOCAL_READER_DATA':str(Path(temporary)/'test-data')}
            run([PYTHON,'-m','unittest','discover','-s','tests','-p','test_*.py'],stage,timeout=600,env=testenv)
            run(['bun','test','tests'],stage,timeout=180)
            run([stage/'desktop/build.sh',source],stage,timeout=600,env=build_env())
            built=stage/'desktop/build/Local Reader.app'
            with (built/'Contents/Info.plist').open('rb') as stream: plist=plistlib.load(stream)
            if plist.get('LocalReaderSourcePath') != str(source) or plist.get('LocalReaderRevision') != target or not (built/'Contents/MacOS/LocalReader').is_file():
                raise UpdateError('Candidate app validation failed.')
            wait_parent(parent_pid); check_app_closed()
            if git(source,'rev-parse','HEAD') != old or not clean(source): raise UpdateError('Source changed while building; the update was not installed.')
            listener(source)  # Recognize the server before altering anything.
            backup.mkdir(parents=True,mode=0o700)
            shutil.copytree(APP,backup/'Local Reader.app')
            if (source/'dist').exists(): shutil.copytree(source/'dist',backup/'dist')
            stopped=True; stop_server(source)
            backup_database(DATA/'library.sqlite3',backup/'library.sqlite3')
            (backup/'revision.txt').write_text(old+'\n')
            git(source,'merge','--ff-only',target); changed=True
            replace_directory(stage/'dist',source/'dist')
            replace_directory(built,APP)
            process=start_server(source)
            if not healthy(process,source): raise UpdateError('The new local server did not pass its health check.')
            return {'success':True,'currentCommit':target,'previousCommit':old,'message':'Local Reader updated successfully.'}
        except Exception as error:
            if changed:
                print('Update did not complete; restoring the previous installation…',file=sys.stderr)
                try:
                    if process is not None and process.poll() is None:
                        process.terminate(); process.wait(timeout=30)
                    restore_source(source,old,target)
                    if (backup/'dist').exists(): replace_directory(backup/'dist',source/'dist')
                    replace_directory(backup/'Local Reader.app',APP)
                    # Keep the newer DB intact and restore the pre-update snapshot after stopping the new process.
                    db=DATA/'library.sqlite3'
                    if (backup/'library.sqlite3').exists():
                        if db.exists(): backup_database(db,backup/'failed-library.sqlite3')
                        for suffix in ('-wal','-shm'):
                            Path(str(db)+suffix).unlink(missing_ok=True)
                        shutil.copy2(backup/'library.sqlite3',db)
                    restored=start_server(source)
                    if not healthy(restored,source): raise UpdateError('Previous source restored, but its server needs manual attention.')
                except Exception as restore_error:
                    rollback = str(restore_error) if isinstance(restore_error,UpdateError) else 'Automatic rollback needs manual attention. Backups were retained.'
            elif stopped:
                try:
                    if listener(source) is None: start_server(source)
                except Exception: rollback='The previous server needs a manual restart.'
            message=str(error) if isinstance(error,UpdateError) else 'Update failed before completion. Inspect prerequisites and retry.'
            if rollback: message+=' '+rollback
            raise UpdateError(message) from None
        finally:
            try: git(source,'worktree','remove','--force',str(stage))
            except Exception: pass


def receipt(result):
    value={'id':uuid.uuid4().hex,'time':time.time(),**result}
    DATA.mkdir(parents=True,exist_ok=True)
    path=DATA/'update-result.json'; temp=path.with_suffix('.tmp')
    temp.write_text(json.dumps(value)); os.chmod(temp,0o600); os.replace(temp,path)
    return value


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--check',action='store_true');action.add_argument('--install',action='store_true')
    parser.add_argument('--json',action='store_true',help='Emit machine-readable JSON (the default).')
    parser.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[1],help='Installed repository root (default: the checkout containing this script).')
    parser.add_argument('--revision',help='Install exactly this previously checked full commit SHA.')
    parser.add_argument('--parent-pid',type=int,help='Wait for the installed window app to exit before replacement.')
    parser.add_argument('--dry-run',action='store_true',help='Use already-fetched origin/main and report only; no fetch/build/install.')
    args=parser.parse_args();source=args.source.expanduser().resolve();another_update=False
    if args.parent_pid is not None and args.parent_pid<=1: parser.error('parent PID must be greater than 1')
    try:
        if args.dry_run:
            result=inspect(source,fetch=False) if args.check else install(source,args.revision,args.parent_pid,True)
            print(json.dumps(result));return 0
        DATA.mkdir(parents=True,exist_ok=True)
        with (DATA/'update.lock').open('a') as lock:
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                another_update=True
                raise UpdateError('Another Local Reader update check/install is running.')
            result=inspect(source,fetch=not args.dry_run) if args.check else install(source,args.revision,args.parent_pid,args.dry_run)
        if args.install and not args.dry_run: result=receipt(result)
        print(json.dumps(result))
        return 0
    except Exception as error:
        message=str(error) if isinstance(error,UpdateError) else 'Update could not complete. Check Git access, dependencies, and local file permissions.'
        result={'success':False,'error':message}
        if args.install and not args.dry_run and not another_update:
            try: result=receipt(result)
            except Exception: pass
        print(json.dumps(result));return 1
    finally:
        if args.install and not args.dry_run and not another_update and APP.exists():
            subprocess.run(['/usr/bin/open',str(APP)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


if __name__=='__main__': sys.exit(main())
