"""Bounded Silero + Smart Turn inference; model paths are installed, pinned local files.

Interfaces: snakers4/silero-vad and pipecat-ai/smart-turn (see THIRD-PARTY.md).
"""
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from math import gcd

_SESSIONS = {}
_EXTRACTOR = None
# The product only finishes a turn when the model is clearly past the conservative bar.
THRESHOLD = 0.65

def session(path):
    # Inference runtimes stay unimported until endpointing actually runs.
    import onnxruntime as ort
    if path not in _SESSIONS:
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 2
        _SESSIONS[path] = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
    return _SESSIONS[path]

def read_mono_16k(path):
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != 16000:
        divisor = gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
    return audio

def voice_activity(audio, silero_path):
    """Whether the clip contains speech, and whether it is still speaking at the end."""
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
    return sum(score > 0.5 for score in scores) >= 3, any(score > 0.5 for score in scores[-10:])

def turn_probability(audio, turn_path):
    """Smart Turn's probability that the last eight seconds of 16 kHz audio end a finished thought."""
    global _EXTRACTOR
    if _EXTRACTOR is None:
        from transformers import WhisperFeatureExtractor
        _EXTRACTOR = WhisperFeatureExtractor(chunk_length=8)
    audio = audio[-128000:]
    samples = np.pad(audio, (max(0, 128000 - len(audio)), 0))
    features = _EXTRACTOR(samples, sampling_rate=16000, return_tensors="np", padding="max_length", max_length=128000, truncation=True, do_normalize=True).input_features.astype(np.float32)
    model = session(str(Path(turn_path) / "smart-turn-v3.2-cpu.onnx"))
    return float(model.run(None, {"input_features": features})[0][0, 0])

def predict(path, silero_path, turn_path=None):
    """Omit turn_path to read only the speech-activity view of the clip."""
    audio = read_mono_16k(path)[-128000:]
    if len(audio) < 512:
        return {"hasSpeech": False, "speechAtEnd": False, "complete": False, "probability": 0.0}
    has_speech, speech_at_end = voice_activity(audio, silero_path)
    if not has_speech or speech_at_end or turn_path is None:
        return {"hasSpeech": has_speech, "speechAtEnd": speech_at_end, "complete": False, "probability": 0.0}
    probability = turn_probability(audio, turn_path)
    return {"hasSpeech": has_speech, "speechAtEnd": False, "complete": probability >= THRESHOLD, "probability": probability}
