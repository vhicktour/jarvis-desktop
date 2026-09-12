"""Local open-vocabulary wake detection. Audio is decoded only against configured keywords.

Sherpa-ONNX GigaSpeech 3.3M, Apache-2.0; model archive and the five runtime files are pinned.
"""
import hashlib
import io
import re
import tarfile
import tempfile
import urllib.request
from pathlib import Path

import numpy as np

ARCHIVE = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{ARCHIVE}.tar.bz2"
SHA256 = "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"
SUFFIX = "epoch-12-avg-2-chunk-16-left-64.int8.onnx"
FILES = [f"{role}-{SUFFIX}" for role in ("encoder", "decoder", "joiner")] + ["tokens.txt", "bpe.model", "README.md"]


def install(target):
    """Called only by an explicit model installation; no executable/archive paths are extracted."""
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read(25_000_001)
    if len(data) > 25_000_000 or hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("The keyword model archive did not match its pinned checksum.")
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:bz2") as archive:
        for name in FILES:
            member = archive.getmember(f"{ARCHIVE}/{name}")
            if not member.isfile() or member.size > 8_000_000:
                raise ValueError("The keyword model contains an invalid file.")
            (target / name).write_bytes(archive.extractfile(member).read())
    return SHA256


class KeywordListener:
    def __init__(self, path, name="Jarvis", bare=True):
        import sentencepiece as spm
        import sherpa_onnx
        if not 2 <= len(name) <= 32 or not re.fullmatch(r"[A-Za-z]+(?:[ '-][A-Za-z]+){0,2}", name):
            raise ValueError("Use a wake name of 2–32 English letters, up to three words.")
        root = Path(path)
        tokenizer = spm.SentencePieceProcessor(model_file=str(root / "bpe.model"))
        names = [f"HEY {name.upper()}"] + ([name.upper()] if bare else [])
        keywords = "\n".join(" ".join(tokenizer.encode(text, out_type=str)) + (" @HEY" if index == 0 else " @NAME") for index, text in enumerate(names))
        # The C++ constructor requires an existing keyword file and exits the process if it is
        # absent. Stream keywords are additive, so a fresh detector owns exactly this name.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf8") as config:
            config.write(keywords + "\n")
            config.flush()
            self.detector = sherpa_onnx.KeywordSpotter(
                tokens=str(root / "tokens.txt"),
                encoder=str(root / f"encoder-{SUFFIX}"),
                decoder=str(root / f"decoder-{SUFFIX}"),
                joiner=str(root / f"joiner-{SUFFIX}"),
                keywords_file=config.name, num_threads=1, provider="cpu",
                max_active_paths=8, keywords_score=1.0, keywords_threshold=0.25, num_trailing_blanks=1,
            )
        self.reset()

    def reset(self):
        self.stream = self.detector.create_stream()

    def accept(self, samples):
        self.stream.accept_waveform(16000, np.asarray(samples, dtype=np.float32))
        found = None
        while self.detector.is_ready(self.stream):
            self.detector.decode_stream(self.stream)
            result = self.detector.get_result(self.stream)
            if result:
                found = result if found != "HEY" else found
                self.detector.reset_stream(self.stream)
        return found
