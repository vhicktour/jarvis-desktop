"""Credential-free, serial MLX/ONNX worker. Only explicit install requests use the network."""
import concurrent.futures
import gc
import json
import os
from pathlib import Path
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

def execute(request):
    request_id = request["id"]
    method = request["method"]
    p = request.get("params", {})
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
            model_id = p.get("model", "parakeet")
            model = load(model_id, "asr")
            path = bounded_audio(p["path"])
            if model_id == "whisper":
                import soundfile as sf
                import numpy as np
                from scipy.signal import resample_poly
                from math import gcd
                from mlx_whisper import transcribe
                # Pass PCM directly so the packaged fallback does not require ffmpeg.
                audio, rate = sf.read(path, dtype="float32", always_2d=True)
                audio = audio.mean(axis=1)
                if rate != 16000:
                    divisor = gcd(rate, 16000)
                    audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
                output = transcribe(audio, path_or_hf_repo=model_path(model_id), language="en", verbose=None, condition_on_previous_text=False)
                result = {"text": output["text"].strip()}
            else:
                output = model.generate(path)
                result = {"text": getattr(output, "text", str(output)).strip()}
        elif method == "endpoint":
            from endpoint import predict
            result = predict(bounded_audio(p["path"]), model_path("silero"), model_path("smart-turn"))
        elif method == "tts":
            import numpy as np
            import soundfile as sf
            model = load("kokoro", "tts")
            voice = (Path(model_path("kokoro")) / "voices" / (p.get("voice", "bm_george") + ".safetensors")).resolve()
            if not voice.is_relative_to(Path(model_path("kokoro")) / "voices") or not voice.is_file():
                raise ValueError("This voice is not present in the installed Kokoro revision.")
            chunks = []
            rate = 24000
            for chunk in model.generate(text=p["text"][:12_000], voice=str(voice), lang_code="b", speed=p.get("speed", 1)):
                if request_id in CANCELLED:
                    raise ValueError("Cancelled.")
                chunks.append(np.asarray(chunk.audio, dtype=np.float32))
                rate = chunk.sample_rate
            if not chunks:
                raise ValueError("No speech was generated.")
            path = TEMP / (str(uuid.uuid4()) + ".wav")
            samples = np.concatenate(chunks)
            sf.write(str(path), samples, rate)
            result = {"path": str(path), "duration": len(samples) / rate, "sampleRate": rate}
        elif method == "chat":
            from mlx_vlm import stream_generate
            from mlx_vlm.prompt_utils import apply_chat_template
            from mlx_vlm.utils import load_config
            model, processor = load("qwen", "reasoning")
            messages = p["messages"][-20:]
            image = p.get("image")
            if image:
                image_path = Path(image).resolve()
                if not image_path.is_relative_to(TEMP):
                    raise ValueError("Only the selected temporary observation may be used.")
            prompt = apply_chat_template(processor, load_config(model_path("qwen")), messages, num_images=1 if image else 0, enable_thinking=False)
            text = ""
            for chunk in stream_generate(model, processor, prompt, image=[image] if image else None, max_tokens=min(p.get("maxTokens", 700), 2000), temperature=0.4):
                if request_id in CANCELLED:
                    raise ValueError("Cancelled.")
                delta = chunk.text
                text += delta
                event("chat.delta", {"requestId": request_id, "conversationId": p.get("conversationId"), "text": delta})
            result = {"text": text.strip()}
        elif method == "embed":
            from mlx_embeddings import generate
            model, tokenizer = load("embedding", "embedding")
            output = generate(model, tokenizer, texts=p["texts"][:16])
            result = {"vectors": output.text_embeds.tolist(), "revision": manifest("embedding")["revision"]}
        elif method == "model.qualify":
            model_id = p["id"]
            record = manifest(model_id)
            if not record:
                raise ValueError("Install the model before running its checks.")
            item = next(item for item in CATALOG if item["id"] == model_id)
            load(model_id, item["role"])
            result = {"loaded": True, "qualified": False, "detail": "Model load passed. Audio-route and task fixture qualification is still required."}
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
