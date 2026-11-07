"""One-time online setup: download pinned Pocket assets; never synthesizes audio."""
from importlib.util import find_spec
import json
from pathlib import Path
import yaml
from huggingface_hub import hf_hub_download

ROOT = Path.home() / 'Library/Caches/local-reader-pocket'
LANGUAGE = 'english_2026-04'
VOICES = ['alba', 'marius', 'javert', 'jean', 'anna', 'vera', 'charles', 'paul']


def download(uri):
    repo_a, repo_b, rest = uri.removeprefix('hf://').split('/', 2)
    filename, revision = rest.rsplit('@', 1)
    return hf_hub_download(repo_id=f'{repo_a}/{repo_b}', filename=filename, revision=revision)


def main():
    package = Path(find_spec('pocket_tts').origin).parent
    config = yaml.safe_load((package / 'config' / f'{LANGUAGE}.yaml').read_text())
    print('Downloading Pocket model and tokenizer...', flush=True)
    # Use Kyutai's public preset-voice weights; no login or cloning permission needed.
    config['weights_path'] = download(config['weights_path_without_voice_cloning'])
    config['weights_path_without_voice_cloning'] = None
    lookup = config['flow_lm']['lookup_table']
    lookup['tokenizer_path'] = download(lookup['tokenizer_path'])
    voices = {}
    for name in VOICES:
        print(f'Downloading voice: {name}', flush=True)
        voices[name] = download(f'hf://kyutai/pocket-tts-without-voice-cloning/languages/{LANGUAGE}/embeddings/{name}.safetensors@e81d79e8194ad4c7ce879c87a4258ef20cbf2487')
    ROOT.mkdir(parents=True, exist_ok=True)
    config_file = ROOT / 'model.yaml'
    config_file.write_text(yaml.safe_dump(config))
    manifest = {'version': 'pocket-tts-3.1.0-english_2026-04', 'config': str(config_file), 'voices': voices}
    temp = ROOT / 'assets.json.tmp'
    temp.write_text(json.dumps(manifest, indent=2))
    temp.replace(ROOT / 'assets.json')
    print(f'Pocket assets installed for offline use: {ROOT}', flush=True)


if __name__ == '__main__':
    main()
