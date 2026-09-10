"""Bounded Silero + Smart Turn inference; model paths are installed, pinned local files.

Interfaces: snakers4/silero-vad and pipecat-ai/smart-turn (see THIRD-PARTY.md).
"""
from pathlib import Path
import numpy as np
import onnxruntime as ort
import soundfile as sf
from scipy.signal import resample_poly
from math import gcd
from transformers import WhisperFeatureExtractor

_SESSIONS = {}
_EXTRACTOR = None

def session(path):
    if path not in _SESSIONS:
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 2
        _SESSIONS[path] = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
    return _SESSIONS[path]

def predict(path, silero_path, turn_path):
    global _EXTRACTOR
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != 16000:
        divisor = gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
    audio = audio[-128000:]
    if len(audio) < 512:
        return {"hasSpeech": False, "complete": False, "probability": 0.0}
    vad = session(str(Path(silero_path) / "onnx/model.onnx"))
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros(64, dtype=np.float32)
    scores = []
    for offset in range(0, len(audio), 512):
        chunk = audio[offset:offset + 512]
        if len(chunk) < 512:
            chunk = np.pad(chunk, (0, 512 - len(chunk)))
        samples = np.concatenate([context, chunk])[None, :]
        output, state = vad.run(None, {"input": samples, "state": state, "sr": np.array(16000, dtype=np.int64)})
        context = chunk[-64:]
        scores.append(float(output[0, 0]))
    has_speech = sum(score > 0.5 for score in scores) >= 3
    speech_at_end = any(score > 0.5 for score in scores[-10:])
    if not has_speech or speech_at_end:
        return {"hasSpeech": has_speech, "speechAtEnd": speech_at_end, "complete": False, "probability": 0.0}
    if _EXTRACTOR is None:
        _EXTRACTOR = WhisperFeatureExtractor(chunk_length=8)
    samples = np.pad(audio, (max(0, 128000 - len(audio)), 0))
    features = _EXTRACTOR(samples, sampling_rate=16000, return_tensors="np", padding="max_length", max_length=128000, truncation=True, do_normalize=True).input_features.astype(np.float32)
    model = session(str(Path(turn_path) / "smart-turn-v3.2-cpu.onnx"))
    probability = float(model.run(None, {"input_features": features})[0][0, 0])
    return {"hasSpeech": has_speech, "speechAtEnd": False, "complete": probability >= 0.65, "probability": probability}
