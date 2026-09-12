"""Bounded openWakeWord inference; model paths are installed, pinned local files.

Interface: dscripka/openWakeWord (see THIRD-PARTY.md). Three graphs in sequence — a
melspectrogram, a shared speech embedding, and the small model that recognizes one phrase.
Nothing here transcribes: the only question it can answer is whether the name was said.
"""
from pathlib import Path
import numpy as np
from endpoint import read_mono_16k, session

# The score openWakeWord itself treats as a detection. Held here so a check that fails
# is recorded as unqualified rather than answered by moving the line.
THRESHOLD = 0.5
# The embedding reads this many mel frames at a time, stepping this far between reads.
EMBED_FRAMES = 76
EMBED_STRIDE = 8
# The phrase model reads this many embeddings, which is a little under two seconds of audio.
EMBED_COUNT = 16
FRAMES_NEEDED = EMBED_FRAMES + EMBED_STRIDE * (EMBED_COUNT - 1)
# Mel hop is ten milliseconds at 16 kHz, plus one frame of slack for the window.
SAMPLES_NEEDED = (FRAMES_NEEDED + 1) * 160


def _only_input(model):
    """openWakeWord has renamed these inputs between releases; ask the graph instead."""
    return model.get_inputs()[0].name


def melspectrogram(samples, wake_path):
    model = session(str(Path(wake_path) / "melspectrogram.onnx"))
    mel = model.run(None, {_only_input(model): samples[None, :].astype(np.float32)})[0]
    # openWakeWord's own scaling, applied before the embedding sees it.
    return np.squeeze(mel) / 10.0 + 2.0


def embeddings(mel, wake_path):
    model = session(str(Path(wake_path) / "embedding_model.onnx"))
    name = _only_input(model)
    windows = [
        mel[start : start + EMBED_FRAMES][None, :, :, None].astype(np.float32)
        for start in range(0, len(mel) - EMBED_FRAMES + 1, EMBED_STRIDE)
    ][-EMBED_COUNT:]
    if not windows:
        return None
    found = [np.squeeze(model.run(None, {name: window})[0]) for window in windows]
    if len(found) < EMBED_COUNT:
        # A short clip is padded at the front, so the phrase still lands at the end.
        found = [found[0]] * (EMBED_COUNT - len(found)) + found
    return np.stack(found)[None, :, :].astype(np.float32)


def predict(path, wake_path, phrase="hey_jarvis_v0.1.onnx"):
    """The probability that the clip ends with the wake phrase."""
    return predict_samples(read_mono_16k(path), wake_path, phrase)


def predict_samples(samples, wake_path, phrase="hey_jarvis_v0.1.onnx"):
    """Score the live ring without a file or a trip through the generation queue."""
    audio = samples[-SAMPLES_NEEDED:]
    if len(audio) < 1600:
        return {"score": 0.0, "awake": False}
    if len(audio) < SAMPLES_NEEDED:
        audio = np.pad(audio, (SAMPLES_NEEDED - len(audio), 0))
    mel = melspectrogram(audio, wake_path)
    if mel.ndim != 2 or len(mel) < EMBED_FRAMES:
        return {"score": 0.0, "awake": False}
    stack = embeddings(mel, wake_path)
    if stack is None:
        return {"score": 0.0, "awake": False}
    model = session(str(Path(wake_path) / phrase))
    score = float(np.squeeze(model.run(None, {_only_input(model): stack})[0]))
    return {"score": score, "awake": score >= THRESHOLD}
