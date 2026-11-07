"""Private JSON-lines worker, isolated from the Kokoro Python environment."""
import json
import os
from pathlib import Path
import sys
import time

# Runtime only reads installed assets. Online downloads live in prepare_pocket.py.
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
protocol = sys.stdout
sys.stdout = sys.stderr


def emit(value):
    protocol.write(json.dumps(value) + '\n')
    protocol.flush()


def main():
    import torch
    import soundfile as sf
    from pocket_tts import TTSModel
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    assets = json.loads((Path.home() / 'Library/Caches/local-reader-pocket/assets.json').read_text())
    model = TTSModel.load_model(config=assets['config'])
    model.has_voice_cloning = False
    voices = {}
    emit({'ready': True})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            voice = request['voice']
            if voice not in assets['voices']:
                raise ValueError('Unknown Pocket preset voice')
            if voice not in voices:
                voices[voice] = model.get_state_for_audio_prompt(Path(assets['voices'][voice]))
            # Pocket starts generation/decoder threads internally and already uses
            # torch.no_grad. Inference-mode tensors cannot be mutated by those threads.
            started = time.perf_counter()
            audio = model.generate_audio(voices[voice], request['text'], copy_state=True)
            elapsed = time.perf_counter() - started
            duration = audio.numel() / model.sample_rate
            print(f'Pocket: {duration:.2f}s audio in {elapsed:.2f}s ({duration/max(elapsed, 0.001):.2f}x realtime)', file=sys.stderr, flush=True)
            sf.write(request['output'], audio.detach().cpu().numpy().reshape(-1), model.sample_rate, subtype='PCM_16')
            emit({'ok': True, 'sample_rate': model.sample_rate})
        except Exception as exc:
            emit({'error': str(exc)})


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit({'error': str(exc)})
        raise SystemExit(1)
