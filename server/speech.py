"""Kokoro inference with model-derived word timings; all calls use one GPU worker."""
from pathlib import Path
import re
import numpy as np
import mlx.core as mx
from kokoro_mlx import KokoroTTS


def aligned_forward(model, phonemes, style, speed):
    # Adapted from kokoro-mlx 0.1.2 model.forward (MIT, Soroush Yousefpour).
    # See THIRD_PARTY_NOTICES. Preserve duration predictions alongside the waveform.
    if style.ndim == 1:
        style = style[None, :]
    ids = [model.vocab[c] for c in phonemes if c in model.vocab]
    inputs = mx.array([[0, *ids, 0]])
    size = inputs.shape[1]
    lengths = mx.array([size])
    mask = mx.zeros((1, size), dtype=mx.bool_)
    encoded = model.bert_encoder(model.bert(inputs)).transpose(0, 2, 1)
    prosody, decoder = style[:, 128:], style[:, :128]
    d = model.predictor.text_encoder(encoded, prosody, lengths, mask)
    duration = mx.sigmoid(model.predictor.duration_proj(model.predictor.lstm(d))).sum(axis=-1) / speed
    durations = mx.maximum(mx.round(duration).astype(mx.int32).squeeze(0), 1)
    mx.eval(durations)
    frames = np.array(durations.tolist())
    alignment = np.zeros((size, int(frames.sum())), dtype=np.float32)
    cursor = 0
    for i, count in enumerate(frames):
        alignment[i, cursor:cursor + count] = 1
        cursor += count
    alignment = mx.array(alignment)[None]
    expanded = d.transpose(0, 2, 1) @ alignment
    f0, noise = model.predictor.F0Ntrain(expanded, prosody)
    text = model.text_encoder(inputs, lengths, mask) @ alignment
    audio = model.decoder(text, f0, noise, decoder).squeeze()
    mx.eval(audio)
    return np.array(audio.tolist(), dtype=np.float32), frames


class Speech:
    def __init__(self):
        # Use the already downloaded snapshot. No network is needed at runtime.
        snapshots = Path.home() / '.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16/snapshots'
        paths = sorted(snapshots.glob('*'))
        if not paths:
            raise RuntimeError('The local Kokoro model is missing. See README.md for setup.')
        self.tts = KokoroTTS.from_pretrained(paths[-1])
        self.render(['Your local reader is ready.'], 'af_heart', 1.0)

    def render(self, words, voice, speed):
        text = ' '.join(words)
        phonemizer = self.tts._get_phonemizer(None, voice)
        phonemes, tokens = phonemizer._g2p(text, preprocess=False)
        vocab = self.tts._config.vocab
        count = sum(c in vocab for c in phonemes)
        if count > 508:
            raise ValueError('Phoneme context is too long')
        style = self.tts._voices.get_style(self.tts._voices.load_voice(voice), count + 2)
        audio, frames = aligned_forward(self.tts._model, phonemes, style, speed)
        cumulative = np.concatenate(([0], np.cumsum(frames)))
        seconds_per_frame = len(audio) / 24000 / frames.sum()
        spans = [(m.start(), m.end()) for m in re.finditer(r'\S+', text)]
        bounds = [[] for _ in spans]
        char_cursor, phone_cursor = 0, 1  # BOS consumes one duration slot.
        for token in tokens:
            start = text.find(token.text, char_cursor)
            if start < 0:
                raise RuntimeError('Could not align phonemizer tokens to the source text')
            end = start + len(token.text)
            length = sum(c in vocab for c in (token.phonemes or ''))
            t0 = float(cumulative[phone_cursor] * seconds_per_frame)
            t1 = float(cumulative[phone_cursor + length] * seconds_per_frame)
            overlaps = [(i, max(0, min(end, b) - max(start, a))) for i, (a, b) in enumerate(spans) if b > start and a < end]
            total = sum(n for _, n in overlaps) or 1
            offset = 0
            for i, n in overlaps:
                bounds[i].extend([t0 + (t1-t0)*offset/total, t0 + (t1-t0)*(offset+n)/total])
                offset += n
            phone_cursor += length + sum(c in vocab for c in token.whitespace)
            char_cursor = end
        times = []
        for i, points in enumerate(bounds):
            start = min(points) if points else (times[-1]['end'] if times else 0)
            end = max(points) if points else start
            times.append({'start': round(start, 4), 'end': round(end, 4)})
        # Remove only long boundary silence, preserving 45 ms for natural joins.
        # Keep every voiced sample; timings are shifted by the same amount.
        active = np.flatnonzero(np.abs(audio) > 0.004)
        if active.size:
            left = min(max(0, int(active[0]) - 1080), max(0, int(times[0]['start'] * 24000)))
            right = max(min(len(audio), int(active[-1]) + 1080), int(times[-1]['end'] * 24000))
            audio = audio[left:right]
            for t in times:
                t['start'] = max(0, t['start'] - left/24000)
                t['end'] = min(len(audio)/24000, max(t['start'], t['end'] - left/24000))
        return audio, times

    def close(self):
        self.tts.close()
        self.tts = None
        mx.clear_cache()
