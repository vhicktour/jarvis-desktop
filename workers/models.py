"""Credential-free, serial MLX/ONNX worker. Only explicit install requests use the network."""
import concurrent.futures
import gc
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import uuid

PROTOCOL = sys.stdout
sys.stdout = sys.stderr
LOCK = threading.Lock()
ROOT = Path(sys.argv[1]).resolve()
MODELS = ROOT / "models"
TEMP = ROOT / "ephemeral"
MODELS.mkdir(parents=True, exist_ok=True, mode=0o700)
TEMP.mkdir(parents=True, exist_ok=True, mode=0o700)
CANCELLED = set()
PENDING = set()
EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=1)
# Weights stay loaded between turns. A spoken exchange moves between transcription, recall,
# reasoning and speech every single time, and reloading them costs far more than holding them:
# 7.25 s of reloading against 0.45 s of the actual work, measured on this Mac. What is held is
# bounded, and the least recently used model leaves first when the next one will not fit.
RESIDENT_BUDGET = 4_500_000_000
RESIDENT = {}
RESIDENT_BYTES = {}
CATALOG = json.loads(Path(sys.argv[2]).read_text())
# One fixed phrase renders every cross-model check, so results stay comparable between runs.
QUALIFY_TEXT = "Good evening. I am Jarvis. Ready when you are."
QUALIFY_KEY = "ready when you are"
# Synthesis is not bit-identical between renders, so endpointing is judged over several takes.
QUALIFY_TAKES = 3
# Roles this worker has a real load path for. Anything else cannot be installed or checked.
RUNNABLE_ROLES = {"asr", "tts", "reasoning", "embedding", "vad", "turn", "vision"}

def send(value):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(data.encode()) > 1_048_576:
        raise ValueError("Response exceeds the protocol limit.")
    with LOCK:
        PROTOCOL.write(data + "\n")
        PROTOCOL.flush()

def event(method, params):
    send({"version": 1, "method": method, "params": params})

def manifest(model_id):
    path = MODELS / model_id / "manifest.json"
    return json.loads(path.read_text()) if path.exists() else None

def catalog(model_id):
    return next((item for item in CATALOG if item["id"] == model_id), None)

def model_path(model_id):
    record = manifest(model_id)
    if not record:
        raise ValueError("Install this local model in Settings first.")
    return str(MODELS / model_id / "weights")

def weights_bytes(model_id):
    return sum(f.stat().st_size for f in (MODELS / model_id / "weights").rglob("*") if f.is_file())

def release(key):
    RESIDENT.pop(key, None)
    RESIDENT_BYTES.pop(key, None)
    # mlx-whisper holds its own module-level reference; dropping ours is not enough to free it.
    if key[0] == "whisper" and "mlx_whisper.transcribe" in sys.modules:
        holder = sys.modules["mlx_whisper.transcribe"].ModelHolder
        holder.model = None
        holder.model_path = None
    gc.collect()

def make_room(needed, mx):
    while RESIDENT and sum(RESIDENT_BYTES.values()) + needed > RESIDENT_BUDGET:
        release(next(iter(RESIDENT)))
        mx.clear_cache()

def load(model_id, role):
    key = (model_id, role)
    if key in RESIDENT:
        RESIDENT[key] = RESIDENT.pop(key)  # most recently used moves to the end
        return RESIDENT[key]
    import mlx.core as mx
    mx.set_cache_limit(256 * 1024**2)
    mx.set_memory_limit(6 * 1024**3)
    path = model_path(model_id)
    size = weights_bytes(model_id)
    make_room(size, mx)
    os.environ["HF_HUB_OFFLINE"] = "1"
    before = mx.get_active_memory()
    if role == "asr":
        if model_id == "whisper":
            from mlx_whisper.transcribe import ModelHolder
            model = ModelHolder.get_model(path, mx.float16)
        else:
            from mlx_audio.stt.utils import load_model
            model = load_model(path, model_type="parakeet")
    elif role == "tts":
        prepare_espeak()
        from mlx_audio.tts.utils import load_model
        model = load_model(path, model_type="kokoro")
    elif role in ("reasoning", "vision"):
        from mlx_vlm import load as load_vlm
        model = load_vlm(path, trust_remote_code=False)
    elif role == "embedding":
        from mlx_embeddings.utils import load as load_embeddings
        model = load_embeddings(path)
    else:
        raise ValueError("This capability requires device qualification before activation.")
    RESIDENT[key] = model
    RESIDENT_BYTES[key] = max(mx.get_active_memory() - before, size)
    return model

# espeak-ng keeps its data directory in a fixed 160-byte buffer. Given a longer path it silently
# falls back to the one compiled into the wheel — a build machine's directory that exists nowhere —
# and then calls exit() when the phoneme tables are not there, taking the whole worker with it and
# leaving no traceback to explain itself. Inside an installed application the bundled directory is
# 167 bytes, so it is reached through a short link that lives beside the models.
ESPEAK_PATH_LIMIT = 160

def espeak_data_path():
    import espeakng_loader
    data = Path(espeakng_loader.get_data_path())
    if len(str(data).encode()) < ESPEAK_PATH_LIMIT:
        return str(data)
    link = ROOT / "espeak-ng-data"
    if not (link.is_symlink() and link.resolve() == data.resolve()):
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(data, target_is_directory=True)
    if len(str(link).encode()) >= ESPEAK_PATH_LIMIT:
        raise ValueError("The path to this profile is too long for speech synthesis to start.")
    return str(link)

def prepare_espeak():
    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    # misaki sets these on import and would otherwise overwrite the short path with the long one.
    import misaki.espeak  # noqa: F401
    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    EspeakWrapper.set_data_path(espeak_data_path())

def bounded_audio(path):
    path = Path(path).resolve()
    if not path.is_relative_to(TEMP) or path.stat().st_size > 80 * 1024**2:
        raise ValueError("Audio must be a bounded temporary recording.")
    return str(path)

def synthesize(text, voice, speed, cancelled=None):
    import numpy as np
    model = load("kokoro", "tts")
    voices = Path(model_path("kokoro")) / "voices"
    selected = (voices / (voice + ".safetensors")).resolve()
    if not selected.is_relative_to(voices) or not selected.is_file():
        raise ValueError("This voice is not present in the installed Kokoro revision.")
    chunks = []
    rate = 24000
    for chunk in model.generate(text=text[:12_000], voice=str(selected), lang_code="b", speed=speed):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        chunks.append(np.asarray(chunk.audio, dtype=np.float32))
        rate = chunk.sample_rate
    if not chunks:
        raise ValueError("No speech was generated.")
    return np.concatenate(chunks), rate

def write_audio(samples, rate):
    import soundfile as sf
    path = TEMP / (str(uuid.uuid4()) + ".wav")
    sf.write(str(path), samples, rate)
    return path

def transcribe(model_id, path):
    model = load(model_id, "asr")
    if model_id == "whisper":
        from mlx_whisper import transcribe as whisper_transcribe
        from endpoint import read_mono_16k
        # Pass PCM directly so the packaged fallback does not require ffmpeg.
        output = whisper_transcribe(read_mono_16k(path), path_or_hf_repo=model_path(model_id), language="en", verbose=None, condition_on_previous_text=False)
        return output["text"].strip()
    output = model.generate(path)
    return getattr(output, "text", str(output)).strip()

def embed(texts):
    from mlx_embeddings import generate
    model, tokenizer = load("embedding", "embedding")
    return generate(model, tokenizer, texts=texts[:16]).text_embeds.tolist()

# A reply meant for the ear, not the eye. The service worker strips the same marks for the replies
# it speaks in one piece; this is the streaming path, where the text never leaves the worker first.
SPEECH_MARKS = [
    (re.compile(r"```[\s\S]*?```"), " "),
    (re.compile(r"`([^`]+)`"), r"\1"),
    (re.compile(r"!?\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"(?m)^\s{0,3}#{1,6}\s+"), ""),
    (re.compile(r"(?m)^\s{0,3}>\s?"), ""),
    (re.compile(r"(?m)^\s{0,3}([-*+]|\d+\.)\s+"), ""),
    (re.compile(r"(\*\*|__)(.*?)\1"), r"\2"),
    (re.compile(r"~~(.*?)~~"), r"\1"),
]
# A decimal point, or a quote closing after one, is not the end of a thought.
SENTENCE = re.compile(r"[^.!?]*(?:\.(?!\d)|[!?])[\"')\]]*(?=\s|$)")

def for_speech(text):
    for pattern, replacement in SPEECH_MARKS:
        text = pattern.sub(replacement, text)
    return re.sub(r"\s+", " ", text).strip()

def take_sentence(text):
    match = SENTENCE.search(text)
    if not match:
        return None, text
    return text[:match.end()].strip(), text[match.end():]

def chat(messages, max_tokens, image=None, delta=None, cancelled=None, speak=None, audio=None):
    from mlx_vlm import stream_generate
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config
    model, processor = load("qwen", "reasoning")
    if image:
        if not Path(image).resolve().is_relative_to(TEMP):
            raise ValueError("Only the selected temporary observation may be used.")
    prompt = apply_chat_template(processor, load_config(model_path("qwen")), messages[-20:], num_images=1 if image else 0, enable_thinking=False)
    text = ""
    pending = ""

    def say(piece):
        # Synthesis happens here, between tokens, because the worker runs one job at a time: a
        # separate request for speech would wait behind the generation it is meant to keep up with.
        words = for_speech(piece)
        if not words:
            return
        samples, rate = synthesize(words, speak.get("voice", "bm_george"), speak.get("speed", 1), cancelled)
        audio(str(write_audio(samples, rate)), len(samples) / rate)

    for chunk in stream_generate(model, processor, prompt, image=[image] if image else None, max_tokens=min(max_tokens, 2000), temperature=0.4):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        text += chunk.text
        if delta:
            delta(chunk.text)
        if speak and audio:
            pending += chunk.text
            while True:
                sentence, rest = take_sentence(pending)
                if not sentence:
                    break
                pending = rest
                say(sentence)
    if speak and audio and pending.strip():
        say(pending)
    return text.strip()

def fixture_font(size):
    from PIL import ImageFont
    for candidate in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)

def grounding_fixture():
    """A plain dialog with three labelled buttons, drawn identically on every run."""
    from PIL import Image, ImageDraw
    width, height = 1280, 800
    targets = {"Cancel": (280, 600, 480, 664), "Save": (540, 600, 740, 664), "Delete": (800, 600, 1000, 664)}
    image = Image.new("RGB", (width, height), (238, 240, 244))
    draw = ImageDraw.Draw(image)
    draw.rectangle([200, 150, 1080, 720], fill=(252, 252, 253), outline=(198, 203, 212), width=2)
    draw.rectangle([200, 150, 1080, 198], fill=(232, 235, 240), outline=(198, 203, 212), width=2)
    draw.text((232, 160), "Project settings", font=fixture_font(30), fill=(30, 36, 46))
    body = fixture_font(26)
    draw.text((232, 250), "Changes apply the next time the project opens.", font=body, fill=(70, 78, 92))
    for label, (x0, y0, x1, y1) in targets.items():
        draw.rounded_rectangle([x0, y0, x1, y1], radius=10, fill=(255, 255, 255), outline=(140, 148, 162), width=2)
        box = draw.textbbox((0, 0), label, font=body)
        draw.text((x0 + (x1 - x0 - box[2]) / 2, y0 + (y1 - y0 - box[3]) / 2 - 3), label, font=body, fill=(24, 30, 40))
    path = TEMP / (str(uuid.uuid4()) + ".png")
    image.save(str(path))
    return path, targets

GROUND_PROMPT = """You are a GUI agent. You are given a screenshot and an instruction. Output only the action.

## Action Space
click(point='<point>x y</point>')

## User Instruction
{instruction}"""

def ground(image_path, instruction, cancelled=None):
    """Ask the vision model where a control is. It proposes a point; it never acts on one."""
    from PIL import Image
    from mlx_vlm import stream_generate
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config
    path = Path(image_path).resolve()
    if not path.is_relative_to(TEMP):
        raise ValueError("Only a bounded temporary capture may be grounded.")
    with Image.open(path) as image:
        width, height = image.size
    model, processor = load("ui-tars", "vision")
    prompt = apply_chat_template(
        processor,
        load_config(model_path("ui-tars")),
        [{"role": "user", "content": GROUND_PROMPT.format(instruction=instruction[:500])}],
        num_images=1,
    )
    text = ""
    for chunk in stream_generate(model, processor, prompt, image=[str(path)], max_tokens=192, temperature=0):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        text += chunk.text
    return {"text": text.strip(), "width": width, "height": height, "points": read_points(text)}

def read_points(text):
    """Every coordinate pair the model offered, in the order it offered them."""
    pairs = re.findall(r"[(<\[]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[)>\]]", text)
    return [[float(x), float(y)] for x, y in pairs]

def check(label, value, passed):
    return {"label": label, "value": str(value)[:400], "passed": bool(passed)}

def spoken_words(text):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())

def tally(results, key, expected):
    """How many takes agreed, so one lucky render cannot qualify a model."""
    matched = sum(1 for result in results if result[key] is expected)
    return f"{matched} of {len(results)}", matched == len(results)

def require(model_id, reason):
    if not manifest(model_id):
        item = catalog(model_id)
        raise ValueError(f"Install {item['name'] if item else model_id} first: {reason}")

def endpoint_fixtures(cancelled):
    """One rendered phrase becomes a finished turn, an unfinished turn, and silence."""
    import numpy as np
    samples, rate = synthesize(QUALIFY_TEXT, "bm_george", 1.0, cancelled)
    finished = np.concatenate([samples, np.zeros(int(rate * 1.5), dtype=np.float32)])
    unfinished = samples[: int(len(samples) * 0.55)]
    silence = np.zeros(rate * 3, dtype=np.float32)
    return [write_audio(value, rate) for value in (finished, unfinished, silence)]

def qualify(model_id, item, cancelled):
    """Run the observable behavior this role is relied on for, and report what was seen."""
    import numpy as np
    role = item["role"]
    stage = lambda message: event("model.progress", {"id": model_id, "stage": message})
    if role in ("asr", "vad", "turn"):
        require("kokoro", "it renders the fixed phrase these checks listen to.")
    if role == "turn":
        require("silero", "it decides whether the clip still contains speech.")
    if role == "tts":
        stage("Rendering the check phrase")
        samples, rate = synthesize(QUALIFY_TEXT, "bm_george", 1.0, cancelled)
        duration = len(samples) / rate
        peak = float(np.max(np.abs(samples)))
        energy = float(np.sqrt(np.mean(np.square(samples))))
        return [
            check("Sample rate", f"{rate} Hz", rate == 24000),
            check("Spoken duration", f"{duration:.2f} s", 0.8 <= duration <= 20),
            check("Peak amplitude", f"{peak:.3f}", 0.01 < peak <= 1.0),
            check("Speech energy", f"{energy:.4f} RMS", energy > 0.005),
            check("Finite samples", f"{len(samples)} samples", bool(np.isfinite(samples).all())),
        ]
    if role == "asr":
        stage("Rendering the check phrase")
        samples, rate = synthesize(QUALIFY_TEXT, "bm_george", 1.0, cancelled)
        duration = len(samples) / rate
        path = write_audio(samples, rate)
        try:
            stage(f"Loading {item['name']}")
            load(model_id, "asr")
            started = time.perf_counter()
            text = transcribe(model_id, str(path))
            elapsed = time.perf_counter() - started
        finally:
            path.unlink(missing_ok=True)
        return [
            check("Transcript", text, QUALIFY_KEY in spoken_words(text)),
            check("Recognition speed", f"{duration / elapsed:.1f}× realtime", elapsed < duration * 5),
        ]
    if role == "reasoning":
        stage(f"Loading {item['name']}")
        load("qwen", "reasoning")
        stage("Checking a determinate answer")
        answer = chat([
            {"role": "system", "content": "Answer with just the number."},
            {"role": "user", "content": "What is 2 + 2?"},
        ], 30, None, None, cancelled)
        stage("Checking the task action envelope")
        envelope = chat([
            {"role": "system", "content": 'Return one JSON object only. Available actions: {"action":"answer","text":"your concise response"}.'},
            {"role": "user", "content": "Say good evening in one short sentence."},
        ], 300, None, None, cancelled)
        try:
            plan = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", envelope.strip()))
        except ValueError:
            plan = None
        return [
            check("Determinate answer", answer, answer.strip().rstrip(".").strip() == "4"),
            check("Task action envelope", envelope, isinstance(plan, dict) and plan.get("action") == "answer" and isinstance(plan.get("text"), str) and bool(plan["text"].strip())),
        ]
    if role == "embedding":
        stage(f"Loading {item['name']}")
        load("embedding", "embedding")
        stage("Embedding the comparison set")
        vectors = embed(["A quiet companion", "A quiet assistant", "Diesel engine maintenance schedule"])
        widths = sorted({len(vector) for vector in vectors})
        values = np.asarray(vectors, dtype=np.float64) if len(widths) == 1 else None
        similar = distinct = 0.0
        if values is not None and values.size:
            units = values / np.clip(np.linalg.norm(values, axis=1, keepdims=True), 1e-12, None)
            similar, distinct = float(units[0] @ units[1]), float(units[0] @ units[2])
        return [
            check("Vectors returned", len(vectors), len(vectors) == 3),
            # The memory store accepts any consistent width up to 4096 finite dimensions.
            check("Dimensions", ", ".join(str(width) for width in widths), len(widths) == 1 and 0 < widths[0] <= 4096),
            check("Finite values", "all dimensions", values is not None and bool(np.isfinite(values).all())),
            check("Related text ranks higher", f"{similar:.3f} against {distinct:.3f}", similar > distinct),
        ]
    if role == "vision":
        stage("Drawing the grounding fixture")
        path, targets = grounding_fixture()
        centres = {name: ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) for name, box in targets.items()}
        checks = []
        try:
            stage(f"Loading {item['name']}")
            load("ui-tars", "vision")
            for label, box in targets.items():
                stage(f"Locating the {label} control")
                result = ground(str(path), f"Click the {label} button.", cancelled)
                point = result["points"][0] if result["points"] else None
                if not point:
                    checks.append(check(f"Located {label}", result["text"] or "no coordinate", False))
                    continue
                x, y = point
                inside_image = 0 <= x <= result["width"] and 0 <= y <= result["height"]
                nearest = min(centres, key=lambda name: (centres[name][0] - x) ** 2 + (centres[name][1] - y) ** 2)
                on_target = box[0] <= x <= box[2] and box[1] <= y <= box[3]
                # Picking the right control is the capability. The approval shows what it picked,
                # so a point a few points outside an edge is reported, not silently accepted.
                detail = f"({x:.0f}, {y:.0f}) chose {nearest}" + ("" if on_target else ", just outside its edge")
                checks.append(check(f"Located {label}", detail, inside_image and nearest == label))
        finally:
            path.unlink(missing_ok=True)
        return checks
    if role in ("vad", "turn"):
        from endpoint import predict, THRESHOLD
        turn = model_path("smart-turn") if role == "turn" else None
        silero = model_path("silero")
        takes = []
        for index in range(QUALIFY_TAKES):
            stage(f"Rendering speech and silence, take {index + 1} of {QUALIFY_TAKES}")
            paths = endpoint_fixtures(cancelled)
            try:
                stage(f"Running {item['name']}, take {index + 1} of {QUALIFY_TAKES}")
                takes.append([predict(str(path), silero, turn) for path in paths])
            finally:
                for path in paths:
                    path.unlink(missing_ok=True)
        spoken = [take[0] for take in takes]
        partial = [take[1] for take in takes]
        quiet = [take[2] for take in takes]
        if role == "vad":
            return [
                check("Speech recognized", *tally(spoken, "hasSpeech", True)),
                check("Silence rejected", *tally(quiet, "hasSpeech", False)),
                check("Unfinished speech still sounding", *tally(partial, "speechAtEnd", True)),
            ]
        probabilities = [result["probability"] for result in spoken]
        spread = ", ".join(f"{value:.3f}" for value in probabilities)
        return [
            check("Probability in range", spread, all(0.0 <= value <= 1.0 for value in probabilities)),
            check("Silence never finishes a turn", *tally(quiet, "complete", False)),
            check("Unfinished speech never finishes a turn", *tally(partial, "complete", False)),
            check(f"Every finished sentence reaches {THRESHOLD}", f"{spread} · lowest {min(probabilities):.3f}", all(result["complete"] is True for result in spoken)),
        ]
    raise ValueError("This role has no qualified Mac check yet.")

def record_qualification(model_id, qualified, checks, elapsed, detail):
    record = manifest(model_id)
    if not record:
        return None
    record["qualified"] = qualified
    record["qualifiedAt"] = time.time()
    record["qualification"] = {"protocol": 1, "detail": detail, "checks": checks, "elapsedSeconds": elapsed}
    target = MODELS / model_id
    temporary = target / "manifest.tmp"
    temporary.write_text(json.dumps(record)); temporary.replace(target / "manifest.json")
    return record

def execute(request):
    request_id = request["id"]
    method = request["method"]
    p = request.get("params", {})
    cancelled = lambda: request_id in CANCELLED
    try:
        if request_id in CANCELLED:
            raise ValueError("Cancelled.")
        if method == "ping":
            import mlx.core as mx
            result = {"version": 1, "mlx": True, "memory": mx.get_active_memory(), "peakMemory": mx.get_peak_memory(), "roles": sorted(RUNNABLE_ROLES)}
        elif method == "models.status":
            result = {item["id"]: manifest(item["id"]) for item in CATALOG}
        elif method == "model.install":
            model_id = p["id"]
            item = next(item for item in CATALOG if item["id"] == model_id)
            # Refused because the worker cannot run the role, not because of a label on it.
            if item["role"] not in RUNNABLE_ROLES:
                raise ValueError("This research profile has no Mac adapter in this worker yet.")
            os.environ.pop("HF_HUB_OFFLINE", None)
            from huggingface_hub import HfApi, snapshot_download
            from huggingface_hub import constants as hf_constants
            hf_constants.HF_HUB_OFFLINE = False
            try:
                info = HfApi(token=False).model_info(item["repository"])
                if not info.sha:
                    raise ValueError("The model revision could not be verified.")
                target = MODELS / model_id
                target.mkdir(exist_ok=True)
                event("model.progress", {"id": model_id, "stage": "Downloading pinned weights", "revision": info.sha})
                snapshot_download(item["repository"], revision=info.sha, local_dir=str(target / "weights"), token=False, allow_patterns=["*.json", "*.jinja", "*.safetensors", "*.txt", "*.model", "*.tiktoken", "*.onnx", "*.npy", "*.npz", "*.bin", "LICENSE*"], ignore_patterns=["pytorch_model*", "*.py", "*.pkl", "*.pickle"], max_workers=3)
                record = {"id": model_id, "repository": item["repository"], "revision": info.sha, "installedAt": time.time(), "qualified": False}
                temporary = target / "manifest.tmp"
                temporary.write_text(json.dumps(record)); temporary.replace(target / "manifest.json")
                result = record
            finally:
                os.environ["HF_HUB_OFFLINE"] = "1"
                hf_constants.HF_HUB_OFFLINE = True
        elif method == "model.remove":
            import shutil
            model_id = p["id"]
            if not any(item["id"] == model_id for item in CATALOG):
                raise ValueError("Unknown model.")
            for key in [k for k in RESIDENT if k[0] == model_id]:
                release(key)
            shutil.rmtree(MODELS / model_id, ignore_errors=True)
            result = True
        elif method == "models.warm":
            # The first exchange is the one that feels slowest, so the models a spoken turn needs
            # are loaded before anybody asks for them. Smallest first: they all have to fit at once.
            warmed = []
            for role in ("asr", "embedding", "reasoning", "tts"):
                ready = [item["id"] for item in CATALOG
                         if item["role"] == role and (manifest(item["id"]) or {}).get("qualified")]
                if not ready:
                    continue
                try:
                    load(min(ready, key=weights_bytes), role)
                    warmed.append(role)
                except Exception:
                    continue
            result = {"warmed": warmed}
        elif method == "asr":
            path = bounded_audio(p["path"])
            result = {"text": transcribe(p.get("model", "whisper"), path)}
        elif method == "endpoint":
            from endpoint import predict
            result = predict(bounded_audio(p["path"]), model_path("silero"), model_path("smart-turn"))
        elif method == "tts":
            samples, rate = synthesize(p["text"], p.get("voice", "bm_george"), p.get("speed", 1), cancelled)
            path = write_audio(samples, rate)
            result = {"path": str(path), "duration": len(samples) / rate, "sampleRate": rate}
        elif method == "chat":
            text = chat(
                p["messages"], p.get("maxTokens", 700), p.get("image"),
                lambda piece: event("chat.delta", {"requestId": request_id, "conversationId": p.get("conversationId"), "text": piece}),
                cancelled, p.get("speak"),
                lambda path, duration: event("chat.audio", {"requestId": request_id, "conversationId": p.get("conversationId"), "path": path, "duration": duration}),
            )
            result = {"text": text}
        elif method == "embed":
            result = {"vectors": embed(p["texts"]), "revision": manifest("embedding")["revision"]}
        elif method == "ground":
            result = ground(p["path"], p["instruction"], cancelled)
        elif method == "model.qualify":
            model_id = p["id"]
            record = manifest(model_id)
            if not record:
                raise ValueError("Install the model before running its checks.")
            item = catalog(model_id)
            if not item:
                raise ValueError("Unknown model.")
            started = time.perf_counter()
            try:
                checks = qualify(model_id, item, cancelled)
            except Exception as error:
                if request_id in CANCELLED:
                    raise
                # Behaviour that could not be observed is not a pass; say exactly what stopped it.
                checks = [check("Check could not run", error, False)]
            elapsed = round(time.perf_counter() - started, 3)
            qualified = all(entry["passed"] for entry in checks)
            failed = [entry for entry in checks if not entry["passed"]]
            detail = (
                f"{item['name']} passed {len(checks)} checks on this Mac in {elapsed:.1f} s."
                if qualified
                else f"{item['name']} is not qualified on this Mac: " + "; ".join(f"{entry['label']} — {entry['value']}" for entry in failed)
            )
            record_qualification(model_id, qualified, checks, elapsed, detail)
            result = {"id": model_id, "role": item["role"], "revision": record["revision"], "qualified": qualified, "checks": checks, "elapsedSeconds": elapsed, "detail": detail}
        else:
            raise ValueError("Unsupported model request.")
        send({"version": 1, "id": request_id, "result": result})
    except Exception as error:
        send({"version": 1, "id": request_id, "error": str(error)[:1600]})
    finally:
        CANCELLED.discard(request_id)
        PENDING.discard(request_id)

for line in sys.stdin:
    if len(line.encode()) > 1_048_576:
        break
    try:
        request = json.loads(line)
        if request.get("version") != 1:
            raise ValueError("Unsupported protocol version.")
        if request.get("method") == "cancel":
            cancelled_id = request.get("params", {}).get("requestId")
            if cancelled_id in PENDING:
                CANCELLED.add(cancelled_id)
        elif request.get("id"):
            if len(PENDING) >= 128:
                send({"version": 1, "id": request["id"], "error": "The model queue is full."})
            else:
                PENDING.add(request["id"])
                EXECUTOR.submit(execute, request)
    except Exception:
        continue
EXECUTOR.shutdown(wait=False, cancel_futures=True)
