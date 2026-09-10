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
LOADED = None
LOADED_KEY = None
CATALOG = json.loads(Path(sys.argv[2]).read_text())
# One fixed phrase renders every cross-model check, so results stay comparable between runs.
QUALIFY_TEXT = "Good evening. I am Jarvis. Ready when you are."
QUALIFY_KEY = "ready when you are"
# Synthesis is not bit-identical between renders, so endpointing is judged over several takes.
QUALIFY_TAKES = 3

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

def load(model_id, role):
    global LOADED, LOADED_KEY
    key = (model_id, role)
    if LOADED_KEY == key:
        return LOADED
    LOADED = None
    LOADED_KEY = None
    # mlx-whisper caches its model separately; keep the one-heavy-model policy.
    if "mlx_whisper.transcribe" in sys.modules:
        holder = sys.modules["mlx_whisper.transcribe"].ModelHolder
        holder.model = None
        holder.model_path = None
    gc.collect()
    import mlx.core as mx
    mx.set_cache_limit(256 * 1024**2)
    mx.set_memory_limit(6 * 1024**3)
    mx.clear_cache()
    path = model_path(model_id)
    os.environ["HF_HUB_OFFLINE"] = "1"
    if role == "asr":
        if model_id == "whisper":
            from mlx_whisper.transcribe import ModelHolder
            LOADED = ModelHolder.get_model(path, mx.float16)
        else:
            from mlx_audio.stt.utils import load_model
            LOADED = load_model(path, model_type="parakeet")
    elif role == "tts":
        from mlx_audio.tts.utils import load_model
        LOADED = load_model(path, model_type="kokoro")
    elif role == "reasoning":
        from mlx_vlm import load as load_vlm
        LOADED = load_vlm(path, trust_remote_code=False)
    elif role == "embedding":
        from mlx_embeddings.utils import load as load_embeddings
        LOADED = load_embeddings(path)
    else:
        raise ValueError("This capability requires device qualification before activation.")
    LOADED_KEY = key
    return LOADED

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

def chat(messages, max_tokens, image=None, delta=None, cancelled=None):
    from mlx_vlm import stream_generate
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config
    model, processor = load("qwen", "reasoning")
    if image:
        if not Path(image).resolve().is_relative_to(TEMP):
            raise ValueError("Only the selected temporary observation may be used.")
    prompt = apply_chat_template(processor, load_config(model_path("qwen")), messages[-20:], num_images=1 if image else 0, enable_thinking=False)
    text = ""
    for chunk in stream_generate(model, processor, prompt, image=[image] if image else None, max_tokens=min(max_tokens, 2000), temperature=0.4):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        text += chunk.text
        if delta:
            delta(chunk.text)
    return text.strip()

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
            result = {"version": 1, "mlx": True, "memory": mx.get_active_memory(), "peakMemory": mx.get_peak_memory()}
        elif method == "models.status":
            result = {item["id"]: manifest(item["id"]) for item in CATALOG}
        elif method == "model.install":
            model_id = p["id"]
            item = next(item for item in CATALOG if item["id"] == model_id)
            if item["experimental"]:
                raise ValueError("This research profile has no qualified Mac adapter yet.")
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
            global LOADED, LOADED_KEY
            if LOADED_KEY and LOADED_KEY[0] == model_id:
                LOADED = None; LOADED_KEY = None; gc.collect()
            shutil.rmtree(MODELS / model_id, ignore_errors=True)
            result = True
        elif method == "asr":
            path = bounded_audio(p["path"])
            result = {"text": transcribe(p.get("model", "parakeet"), path)}
        elif method == "endpoint":
            from endpoint import predict
            result = predict(bounded_audio(p["path"]), model_path("silero"), model_path("smart-turn"))
        elif method == "tts":
            samples, rate = synthesize(p["text"], p.get("voice", "bm_george"), p.get("speed", 1), cancelled)
            path = write_audio(samples, rate)
            result = {"path": str(path), "duration": len(samples) / rate, "sampleRate": rate}
        elif method == "chat":
            text = chat(p["messages"], p.get("maxTokens", 700), p.get("image"), lambda piece: event("chat.delta", {"requestId": request_id, "conversationId": p.get("conversationId"), "text": piece}), cancelled)
            result = {"text": text}
        elif method == "embed":
            result = {"vectors": embed(p["texts"]), "revision": manifest("embedding")["revision"]}
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
