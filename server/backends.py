"""Local speech engine adapters; called serially by the speech executor."""
import gc
import json
import logging
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import tempfile

import numpy as np
import soundfile as sf

from .library import DATA

POCKET_ROOT = Path.home() / 'Library/Caches/local-reader-pocket'
POCKET_PYTHON = POCKET_ROOT / 'venv/bin/python'
KOKORO_VOICES = {'af_heart': 'Heart · American', 'af_bella': 'Bella · American', 'af_sarah': 'Sarah · American',
                 'am_michael': 'Michael · American', 'am_fenrir': 'Fenrir · American',
                 'bf_emma': 'Emma · British', 'bm_daniel': 'Daniel · British', 'bm_george': 'George · British'}
POCKET_VOICES = {name: name.title() for name in ['alba', 'marius', 'javert', 'jean', 'anna', 'vera', 'charles', 'paul']}


def ffmpeg():
    # Servers started by the Mac app inherit launchd's minimal PATH, so also
    # look in the usual Homebrew and Nix locations.
    user = os.environ.get('USER', '')
    candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg',
                  str(Path.home() / '.nix-profile/bin/ffmpeg'), f'/etc/profiles/per-user/{user}/bin/ffmpeg']
    return shutil.which('ffmpeg') or next((c for c in candidates if os.access(c, os.X_OK)), 'ffmpeg')


def normalized_audio(path):
    # Every adapter returns mono float32 PCM at 24 kHz for the existing player.
    result = subprocess.run([ffmpeg(), '-v', 'error', '-i', str(path), '-ar', '24000', '-ac', '1',
                             '-f', 'f32le', 'pipe:1'], capture_output=True, check=True, timeout=30)
    audio = np.frombuffer(result.stdout, dtype='<f4').copy()
    if not audio.size:
        raise RuntimeError('The speech engine returned empty audio.')
    return audio


def approximate_timings(words, audio):
    """Estimated word intervals, explicitly identified as approximate in the UI.

    Pocket and say do not expose phoneme alignment. Speech length and punctuation
    weights give a rough follow-along guide, not a claim of forced alignment.
    """
    active = np.flatnonzero(np.abs(audio) > 0.004)
    start = max(0, (int(active[0])-480)/24000) if active.size else 0
    end = min(len(audio)/24000, (int(active[-1])+480)/24000) if active.size else len(audio)/24000
    weights = [max(1, len(re.findall(r'[aeiouy]+', word.lower()))) +
               (0.8 if re.search(r'[.!?][”\'"’)]*$', word) else 0.35 if re.search(r'[,;:]', word) else 0)
               for word in words]
    edges = start + np.concatenate(([0], np.cumsum(weights))) / sum(weights) * (end-start)
    return [{'start': float(edges[i]), 'end': float(edges[i+1])} for i in range(len(words))]


class PocketSpeech:
    def __init__(self):
        self.log = (DATA / 'pocket.log').open('a')
        self.process = None
        try:
            self.process = subprocess.Popen([str(POCKET_PYTHON), '-u', str(Path(__file__).with_name('pocket_worker.py'))],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True,
                env={**os.environ, 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1'})
            if not self._reply().get('ready'):
                raise RuntimeError('Pocket could not load its local model.')
        except Exception:
            self.close()
            raise

    def _reply(self):
        if not select.select([self.process.stdout], [], [], 180)[0]:
            raise RuntimeError('Pocket took too long. Retry or select Kokoro.')
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Pocket stopped unexpectedly. Select it again to retry; see pocket.log.')
        result = json.loads(line)
        if result.get('error'):
            raise RuntimeError('Pocket: ' + result['error'])
        return result

    def render(self, words, voice, speed):
        with tempfile.TemporaryDirectory(prefix='local-reader-pocket-') as temp:
            output = Path(temp) / 'speech.wav'
            self.process.stdin.write(json.dumps({'voice': voice, 'text': ' '.join(words), 'output': str(output)})+'\n')
            self.process.stdin.flush()
            self._reply()
            audio = normalized_audio(output)
        return audio, approximate_timings(words, audio)

    def close(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            for stream in (self.process.stdin, self.process.stdout):
                if stream:
                    stream.close()
        self.log.close()


class MacSpeech:
    def render(self, words, voice, speed):
        with tempfile.TemporaryDirectory(prefix='local-reader-mac-') as temp:
            text_file, output = Path(temp)/'text.txt', Path(temp)/'speech.aiff'
            text_file.write_text(' '.join(words).replace('[[', '['))
            subprocess.run(['/usr/bin/say', '-v', voice, '-r', '175', '-o', str(output), '-f', str(text_file)],
                           check=True, capture_output=True, timeout=90)
            audio = normalized_audio(output)
        return audio, approximate_timings(words, audio)


class BackendManager:
    def __init__(self):
        self.engine = None
        self.active = None
        self.loading = None
        self.last_errors = {}
        mac_voices = {}
        if Path('/usr/bin/say').exists():
            try:
                listing = subprocess.run(['/usr/bin/say', '-v', '?'], capture_output=True, text=True, timeout=10).stdout
                installed = {m[1]: m[2] for m in re.finditer(r'^(.+?)\s+(en_\w+)\s+#', listing, re.M)}
                for name in ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Rishi', 'Fred']:
                    if name in installed:
                        mac_voices[name] = f'{name} · {installed[name].replace("en_", "")}'
            except (OSError, subprocess.SubprocessError):
                logging.exception('Could not list Mac voices')
        self.definitions = {
            'kokoro': {'name': 'Kokoro', 'model': 'Kokoro 82M · Apple Metal', 'voices': KOKORO_VOICES, 'timing': 'model-derived'},
            'pocket': {'name': 'Pocket TTS', 'model': 'Pocket TTS · CPU', 'voices': POCKET_VOICES, 'timing': 'approximate'},
            'macos': {'name': 'Mac voices', 'model': 'macOS · built-in voices', 'voices': mac_voices, 'timing': 'approximate'},
        }

    def available(self, name):
        if name == 'kokoro':
            return any((Path.home()/'.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16/snapshots').glob('*/config.json'))
        if name == 'pocket':
            return POCKET_PYTHON.exists() and (POCKET_ROOT/'assets.json').exists()
        return bool(self.definitions[name]['voices'])

    def describe(self, name):
        definition = self.definitions[name]
        available = self.available(name)
        error = None
        if not available:
            error = 'Run scripts/install-pocket.command while online to install Pocket.' if name == 'pocket' else 'This local speech engine is not installed.'
        return {'id': name, **definition, 'available': available,
                'status': 'loading' if self.loading == name else 'ready' if available else 'unavailable',
                'error': error, 'last_error': self.last_errors.get(name)}

    def catalog(self):
        return [self.describe(name) for name in self.definitions]

    def prepare(self, name):
        if self.active == name and self.engine is not None:
            return self.engine
        if not self.available(name):
            raise RuntimeError(self.describe(name)['error'])
        self.close()
        self.loading = name
        try:
            if name == 'kokoro':
                from .speech import Speech
                engine = Speech()
            elif name == 'pocket':
                engine = PocketSpeech()
            else:
                engine = MacSpeech()
            self.engine = engine
            self.active = name
            self.last_errors.pop(name, None)
            return engine
        except Exception as exc:
            self.last_errors[name] = str(exc)
            raise
        finally:
            self.loading = None

    def render(self, name, words, voice, speed):
        native_speed = min(speed, 1.5) if name == 'kokoro' else 1.0
        try:
            audio, times = self.prepare(name).render(words, voice, native_speed)
            return audio, times, native_speed
        except ValueError:
            # Kokoro's phoneme context limit is handled by the caller's chunk split.
            raise
        except Exception:
            self.close()
            raise

    def close(self):
        if self.engine is not None:
            close = getattr(self.engine, 'close', None)
            if close:
                close()
            self.engine = None
            self.active = None
            gc.collect()
