#!/usr/bin/env python3
"""Start one local server, then open the reader in the default browser."""
from pathlib import Path
import json
import os
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
CACHES = Path.home() / 'Library/Caches'
# LOCAL_READER_PYTHON, else the standard venv, else the venv path used by earlier installs.
PYTHON = Path(os.environ['LOCAL_READER_PYTHON']).expanduser() if os.environ.get('LOCAL_READER_PYTHON') else next(
    (p for p in (CACHES / 'local-reader/venv/bin/python', CACHES / 'antikythera-local-tts/venv/bin/python') if p.exists()),
    CACHES / 'local-reader/venv/bin/python')
DATA = Path.home() / 'Library/Application Support/Local Reader'
URL = 'http://127.0.0.1:8787'


def running():
    try:
        with urlopen(URL + '/api/status', timeout=1) as response:
            return json.load(response).get('local') is True
    except Exception:
        return False


if not running():
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / 'server.log').open('a') as log:
        subprocess.Popen([str(PYTHON), '-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '8787'],
                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(120):
        if running():
            break
        time.sleep(.5)
    else:
        raise SystemExit(f'Could not start Local Reader. Check {DATA / "server.log"}')
subprocess.run(['/usr/bin/open', URL], check=True)
