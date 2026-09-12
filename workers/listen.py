"""A microphone heard as it happens.

The native helper streams what its tap hears as 16 kHz frames. They arrive here through the
service worker and are handled on their own thread, off the executor, so a generation in progress
cannot hold them up. Silero runs on every frame and reports only the transitions — somebody started,
somebody stopped — and Smart Turn is asked, on request, about the last eight seconds. Nothing here
transcribes.

Interfaces: snakers4/silero-vad and pipecat-ai/smart-turn (see THIRD-PARTY.md).
"""
import base64
import queue
import threading
import time
from pathlib import Path

import numpy as np

from endpoint import THRESHOLD, session, turn_probability

RATE = 16000
# Silero reads 512 samples at a time with 64 of context in front of them: one frame is 32 ms.
FRAME = 512
CONTEXT = 64
# Silero's own bar for speech, and the lower one a run of speech has to fall under before it is
# over, so a syllable that dips does not split a sentence in two.
SPEECH_START = 0.5
SPEECH_END = 0.35
# Frames over the bar before a start is reported: a click or a cough is not a word.
START_FRAMES = 3
# What Smart Turn reads.
HISTORY_SECONDS = 8


class Listener:
    def __init__(self, send, model_path):
        self.send = send
        self.model_path = model_path
        self.queue = queue.Queue(maxsize=512)
        self.generation = None
        self.silero = None
        self.turn = None
        self.wake = None
        self.keyword = None
        self.keyword_cache = None
        self.keyword_config = None
        self.dropped = 0
        self.last_wake = 0
        self.last_voice = 0
        self.ring = np.zeros(RATE * HISTORY_SECONDS, dtype=np.float32)
        self.reset()
        threading.Thread(target=self.run, name="listener", daemon=True).start()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT, dtype=np.float32)
        self.pending = np.zeros(0, dtype=np.float32)
        self.speaking = False
        self.run_length = 0
        self.spoke = False
        self.cursor = 0
        self.filled = 0
        self.frames = 0
        self.speech_frames = 0
        self.peak_probability = 0.0
        self.last_status = 0

    def push(self, item):
        """Called from the protocol thread. A listener that fell behind drops frames; it never blocks."""
        try:
            self.queue.put_nowait(item)
        except queue.Full:
            self.dropped += 1

    def run(self):
        # Everything below runs on this one thread, so the state needs no lock.
        while True:
            item = self.queue.get()
            try:
                if "_configure" in item:
                    self.configure(item)
                elif "_ask" in item:
                    self.answer(item)
                else:
                    self.hear(item)
            except Exception as error:
                self.silero = None
                self.event("listen.error", {"generation": item.get("generation"), "message": (str(error) or error.__class__.__name__)[:300]})

    def event(self, method, params):
        self.send({"version": 1, "method": method, "params": params})

    def configure(self, item):
        """A microphone opened: fresh state, and the models loaded before the first frame needs them."""
        self.generation = item.get("generation")
        self.reset()
        self.last_wake = 0
        self.last_voice = 0
        self.keyword = None
        self.wake = None
        self.detector = "vad"
        if item.get("wake"):
            if item.get("keyword"):
                from wake_keywords import KeywordListener
                config = (self.model_path("keyword"), item.get("name", "Jarvis"), bool(item.get("bare")))
                if config != self.keyword_config:
                    self.keyword_cache = KeywordListener(*config)
                    self.keyword_config = config
                else:
                    self.keyword_cache.reset()
                self.keyword = self.keyword_cache
                self.detector = "keyword"
            else:
                self.wake = self.model_path("openwakeword")
                self.detector = "phrase"
        self.silero = str(Path(self.model_path("silero")) / "onnx/model.onnx")
        session(self.silero)
        try:
            self.turn = self.model_path("smart-turn")
        except ValueError:
            # Asked only where it has passed its checks; absent is not a fault of the microphone.
            self.turn = None
        self.event("listen.ready", {"generation": self.generation, "semantic": self.turn is not None, "wake": self.detector != "vad", "detector": self.detector})

    def hear(self, item):
        generation = item.get("generation")
        if generation != self.generation or not self.silero:
            return
        raw = base64.b64decode(item.get("pcm") or "")
        if len(raw) < 2:
            return
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        self.frames += 1
        ends_at = float(item.get("elapsed") or 0.0)
        self.remember(samples)
        self.pending = np.concatenate([self.pending, samples])
        vad = session(self.silero)
        total = len(self.pending)
        offset = 0
        while offset + FRAME <= total:
            chunk = self.pending[offset:offset + FRAME]
            offset += FRAME
            output, self.state = vad.run(None, {"input": np.concatenate([self.context, chunk])[None, :], "state": self.state, "sr": np.array(RATE, dtype=np.int64)})
            self.context = chunk[-CONTEXT:]
            # The tap's clock is read at the end of its buffer; this frame ended before what follows it.
            self.judge(float(output[0, 0]), ends_at - (total - offset) / RATE, generation)
        self.pending = self.pending[offset:]
        if self.speaking:
            self.last_voice = ends_at
        # A streaming keyword decoder needs the whole signal, including the first syllable and
        # its following silence. VAD gates would clip both, and prevent a bare name from waking.
        matched = self.keyword.accept(samples) if self.keyword else None
        if matched:
            self.keyword = None
            self.event("listen.wake", {"generation": generation, "detector": "keyword", "awake": True, "nameOnly": matched == "NAME"})
        elif self.wake and self.last_voice and ends_at - self.last_voice < 1.5 and ends_at - self.last_wake >= 0.32:
            self.last_wake = ends_at
            from wake import predict_samples
            result = predict_samples(self.recent(), self.wake)
            if result["awake"]:
                # One detection per armed microphone. The service re-arms after the turn ends.
                self.wake = None
                self.event("listen.wake", {"generation": generation, **result})
        if time.monotonic() - self.last_status >= 1:
            self.last_status = time.monotonic()
            self.event("listen.status", {"generation": generation, "detector": self.detector,
                       "frames": self.frames, "speechFrames": self.speech_frames, "droppedFrames": self.dropped,
                       "peakSpeechProbability": round(self.peak_probability, 4)})

    def judge(self, probability, at, generation):
        self.peak_probability = max(self.peak_probability, probability)
        if probability >= SPEECH_START:
            self.speech_frames += 1
        if not self.speaking:
            if probability < SPEECH_START:
                self.run_length = 0
                return
            self.run_length += 1
            if self.run_length < START_FRAMES:
                return
            self.speaking = True
            self.spoke = True
            self.event("listen.speech", {"generation": generation, "speaking": True, "at": round(at - START_FRAMES * FRAME / RATE, 3), "probability": round(probability, 3)})
        elif probability < SPEECH_END:
            self.speaking = False
            self.run_length = 0
            self.event("listen.speech", {"generation": generation, "speaking": False, "at": round(at, 3), "probability": round(probability, 3)})

    def remember(self, samples):
        size = len(self.ring)
        count = len(samples)
        if count >= size:
            self.ring[:] = samples[-size:]
            self.cursor = 0
            self.filled = size
            return
        end = self.cursor + count
        if end <= size:
            self.ring[self.cursor:end] = samples
        else:
            first = size - self.cursor
            self.ring[self.cursor:] = samples[:first]
            self.ring[:count - first] = samples[first:]
        self.cursor = end % size
        self.filled = min(self.filled + count, size)

    def recent(self):
        if self.filled < len(self.ring):
            return self.ring[:self.filled].copy()
        return np.concatenate([self.ring[self.cursor:], self.ring[:self.cursor]])

    def answer(self, item):
        """Smart Turn over what the ring holds, answered here so a busy executor cannot delay it."""
        request_id = item["_ask"]
        try:
            if item.get("generation") != self.generation:
                raise ValueError("That microphone is no longer open.")
            if not self.spoke:
                result = {"hasSpeech": False, "speechAtEnd": False, "complete": False, "probability": 0.0}
            elif self.speaking:
                result = {"hasSpeech": True, "speechAtEnd": True, "complete": False, "probability": 0.0}
            elif not self.turn:
                raise ValueError("Install Smart Turn first.")
            else:
                probability = turn_probability(self.recent(), self.turn)
                result = {"hasSpeech": True, "speechAtEnd": False, "complete": probability >= THRESHOLD, "probability": probability}
            self.send({"version": 1, "id": request_id, "result": result})
        except Exception as error:
            self.send({"version": 1, "id": request_id, "error": (str(error) or error.__class__.__name__)[:1600]})
