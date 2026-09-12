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
# The reasoning model's prompt is prefilled once per exchange rather than once per turn: what every
# turn begins with — persona and history — is kept as an exact cache snapshot, and a turn pays only
# for its own words. Measured here: 2.0 s to the first token became 0.5 s. Snapshots are kept per
# prompt, so enough are held for the prepared prefix to survive the turn that follows it.
os.environ.setdefault("APC_CHECKPOINT_ENTRIES", "4")
PREFIX_CACHE = None
CATALOG = json.loads(Path(sys.argv[2]).read_text())
# One fixed phrase renders every cross-model check, so results stay comparable between runs.
QUALIFY_TEXT = "Good evening. I am Jarvis. Ready when you are."
QUALIFY_KEY = "ready when you are"
# The turn model is asked whether a thought has finished, so its check has to be a thought that
# plainly finishes: a question. The greeting above ends on a handoff, and the model — rightly — hears
# that as a turn still open, which had it scoring 0.26 to 0.64 against a bar of 0.65.
TURN_TEXT = "What's the weather going to be like tomorrow, and should I take an umbrella?"
# Synthesis is not bit-identical between renders, so endpointing is judged over several takes.
QUALIFY_TAKES = 3
# The turn model is judged over more, because a rendered voice sits near its decision boundary: the
# same question came back at 0.57, 0.80 and 0.65 on consecutive renders, and 0.92 to 0.97 on others,
# while real speech scored 0.84 to 0.94 and an unfinished thought 0.02 to 0.04.
TURN_TAKES = 5
# The bar the model's authors publish for a finished turn. Every render has to clear it.
TURN_FLOOR = 0.5
# A duplex model is asked something with one right answer, so hearing can be told from guessing.
DUPLEX_QUESTION = "What is the capital of France?"
DUPLEX_KEY = "paris"
# A role is not an adapter: other speech models need different processors and codecs.
RUNNABLE_MODELS = {"parakeet", "kokoro", "qwen", "embedding", "whisper", "silero", "smart-turn", "openwakeword", "keyword", "ui-tars", "lfm"}
RUNNABLE_ROLES = {item["role"] for item in CATALOG if item["id"] in RUNNABLE_MODELS}

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
    global PREFIX_CACHE
    RESIDENT.pop(key, None)
    RESIDENT_BYTES.pop(key, None)
    event("models.evicted", {"id": key[0], "role": key[1]})
    # A prompt cache belongs to the weights it was computed with.
    if key[1] == "reasoning":
        PREFIX_CACHE = None
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
    elif role == "duplex":
        # Speech to speech in one model: it hears the recording and answers with audio, so a turn
        # never passes through transcription, reasoning and synthesis as three separate loads.
        from mlx_audio.sts.utils import load as load_sts
        from mlx_audio.sts.models.lfm_audio import LFM2AudioProcessor
        model = (load_sts(path), LFM2AudioProcessor.from_pretrained(path))
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
    voices = (Path(model_path("kokoro")) / "voices").resolve()
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

# The codec runs at 12.5 Hz, so six codes is about half a second of speech: small enough to reach
# the speaker quickly, and the shortest piece worth handing over on its own. The decoder needs the
# codes before a piece to reconstruct its opening cleanly — decoded without them, every seam is a
# step three times larger than any the model itself produces, which is audible as a click.
DUPLEX_CHUNK = 6
DUPLEX_LEAD = 8

# In interleaved mode the model writes six text tokens, then twelve audio frames, and so on. Twelve
# frames is 0.96 s of speech, so a second of reply costs about nineteen tokens either way.
DUPLEX_TOKENS_PER_SECOND = 18.75

def duplex_reply(path, instructions=None, history=None, cancelled=None, audio=None, max_seconds=None):
    """Hear a recording and answer aloud, handing over each piece of the answer as it is made.

    `max_seconds` bounds the spoken reply. The model does not hold to a length it is asked for —
    "one or two sentences" came back as 25 seconds of talk — so the bound is a token budget.
    """
    import numpy as np, soundfile as sf
    import mlx.core as mx
    from mlx_audio.sts.models.lfm_audio import ChatState, LFMModality
    model, processor = load("lfm", "duplex")
    budget = max(60, int(float(max_seconds) * DUPLEX_TOKENS_PER_SECOND)) if max_seconds else 600
    heard, rate = sf.read(path, dtype="float32")
    if heard.ndim > 1:
        heard = heard.mean(axis=1)
    state = ChatState(processor)
    if instructions:
        state.new_turn("system"); state.add_text(instructions[:4000]); state.end_turn()
    for turn in (history or [])[-8:]:
        role = "assistant" if turn.get("role") == "assistant" else "user"
        state.new_turn(role); state.add_text(str(turn.get("text", ""))[:2000]); state.end_turn()
    state.new_turn("user"); state.add_audio(mx.array(heard), rate); state.end_turn()
    state.new_turn("assistant")

    codes, spoken_to = [], 0
    said = []

    def emit(upto):
        nonlocal spoken_to
        lead = max(0, spoken_to - DUPLEX_LEAD)
        wave = processor.decode_audio(mx.stack(codes[lead:upto], axis=-1)[None])
        samples = np.asarray(mx.reshape(wave, (-1,)), dtype=np.float32)
        per = len(samples) // (upto - lead)
        samples = samples[(spoken_to - lead) * per:]
        spoken_to = upto
        audio(str(write_audio(samples, model.sample_rate)), len(samples) / model.sample_rate)

    for token, modality in model.generate_from_chat_state(state, mode="interleaved", max_new_tokens=budget):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        if int(modality) == int(LFMModality.AUDIO_OUT):
            codes.append(mx.reshape(token, (-1,)))
            if audio and len(codes) - spoken_to >= DUPLEX_CHUNK:
                emit(len(codes))
        else:
            said.append(int(mx.reshape(token, (-1,))[0]))
    if audio and len(codes) > spoken_to:
        emit(len(codes))
    text = processor.decode_text(said) if said else ""
    return re.sub(r"<\|[^|]*\|>", "", text).strip(), len(codes) / 12.5

def write_audio(samples, rate):
    import soundfile as sf
    path = TEMP / (str(uuid.uuid4()) + ".wav")
    sf.write(str(path), samples, rate)
    return path

def transcribe(model_id, path, prompt=None):
    model = load(model_id, "asr")
    if model_id == "whisper":
        from mlx_whisper import transcribe as whisper_transcribe
        from endpoint import read_mono_16k
        # Pass PCM directly so the packaged fallback does not require ffmpeg.
        output = whisper_transcribe(read_mono_16k(path), path_or_hf_repo=model_path(model_id), language="en", verbose=None, condition_on_previous_text=False, initial_prompt=str(prompt)[:120] if prompt else None)
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

# The first piece of a reply leaves at the first clause rather than the first sentence: the ear
# notices the wait before the voice starts far more than a breath after a comma. A clause has to be
# long enough to be worth saying on its own.
CLAUSE = re.compile(r"[,;:]\s")
FIRST_PIECE_WORDS = 6

def take_first_piece(text):
    """The first sentence, or the first clause of substance, whichever finishes first."""
    sentence, rest = take_sentence(text)
    end = len(sentence) if sentence else None
    for match in CLAUSE.finditer(text):
        if end is not None and match.end() >= end:
            break
        head = text[:match.end()].strip()
        if len(head.split()) >= FIRST_PIECE_WORDS:
            return head, text[match.end():]
    return (sentence, rest) if sentence else (None, text)

def prefix_cache():
    global PREFIX_CACHE
    if PREFIX_CACHE is None:
        from mlx_vlm.apc import APCManager
        PREFIX_CACHE = APCManager()
    return PREFIX_CACHE

CONFIG = {}

def render(messages, image=False):
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config
    model, processor = load("qwen", "reasoning")
    if "qwen" not in CONFIG:
        CONFIG["qwen"] = load_config(model_path("qwen"))
    return model, processor, apply_chat_template(processor, CONFIG["qwen"], messages[-20:], num_images=1 if image else 0, enable_thinking=False)

def prepare(messages, cancelled=None):
    """Prefill what the coming turn will begin with, so the turn itself starts at its own words.

    The template renders the last assistant message differently when nothing follows it, so the
    prefix is cut out of a rendered turn rather than rendered on its own; otherwise its tokens are
    not a prefix of the turn's and the cache is never hit.
    """
    global PREFIX_CACHE
    from mlx_vlm import stream_generate
    from mlx_vlm.apc import APCManager
    began = time.perf_counter()
    model, processor, rendered = render(messages + [{"role": "user", "content": ""}])
    marker = rendered.rfind("<|im_start|>user")
    if marker <= 0:
        return {"prepared": False}
    # This MLX version only stores a hybrid-model checkpoint on a cache miss. Reusing the
    # old prefix here kept every later turn at the first 236 cached tokens, even as history
    # grew. Prepare a complete replacement and publish it only after it finishes; cancelling
    # preparation leaves the previous checkpoint usable by the foreground question.
    prepared_cache = APCManager()
    prompt_tokens = cached_tokens = 0
    for chunk in stream_generate(model, processor, rendered[:marker], max_tokens=1, temperature=0.0, apc_manager=prepared_cache):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        prompt_tokens = getattr(chunk, "prompt_tokens", 0)
        cached_tokens = getattr(chunk, "cached_tokens", 0)
    if cancelled and cancelled():
        raise ValueError("Cancelled.")
    PREFIX_CACHE = prepared_cache
    return {"prepared": True, "promptTokens": prompt_tokens, "cachedTokens": cached_tokens,
            "elapsedMs": round((time.perf_counter() - began) * 1000)}

def chat(messages, max_tokens, image=None, delta=None, cancelled=None, speak=None, audio=None, max_sentences=None, route_tasks=False, timing=None):
    from mlx_vlm import stream_generate
    if image:
        if not Path(image).resolve().is_relative_to(TEMP):
            raise ValueError("Only the selected temporary observation may be used.")
    began = time.perf_counter()
    first_token_ms = None
    synthesis_ms = 0.0
    prompt_tokens = cached_tokens = 0
    model, processor, prompt = render(messages, bool(image))
    text = ""
    pending = ""
    pieces = 0
    routing = None if route_tasks else False
    reported = 0

    def say(piece):
        # Synthesis happens here, between tokens, because the worker runs one job at a time: a
        # separate request for speech would wait behind the generation it is meant to keep up with.
        nonlocal pieces, synthesis_ms
        words = for_speech(piece)
        if not words:
            return
        started = time.perf_counter()
        samples, rate = synthesize(words, speak.get("voice", "bm_george"), speak.get("speed", 1), cancelled)
        synthesis_ms += (time.perf_counter() - started) * 1000
        pieces += 1
        audio(str(write_audio(samples, rate)), len(samples) / rate)

    for chunk in stream_generate(model, processor, prompt, image=[image] if image else None, max_tokens=min(max_tokens, 2000), temperature=0.4, apc_manager=None if image else prefix_cache()):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        if first_token_ms is None:
            first_token_ms = (time.perf_counter() - began) * 1000
            prompt_tokens = getattr(chunk, "prompt_tokens", 0)
            cached_tokens = getattr(chunk, "cached_tokens", 0)
        text += chunk.text
        if routing is None:
            prefix = text.lstrip()
            if "<task/>".startswith(prefix) or "<task>".startswith(prefix):
                if prefix not in ("<task/>", "<task>"):
                    continue
            routing = prefix.startswith("<task")
        if routing:
            return "<task/>"
        finished = False
        if max_sentences:
            # Wait for a following character, so a token ending with "3." is not mistaken for
            # a full stop before the next token supplies the decimal digits.
            sentences = [match for match in SENTENCE.finditer(text) if match.end() < len(text)]
            if len(sentences) >= max_sentences:
                text = text[:sentences[max_sentences - 1].end()]
                finished = True
        addition = text[reported:]
        reported = len(text)
        if delta:
            delta(addition)
        if speak and audio:
            pending += addition
            while True:
                piece, rest = (take_first_piece if pieces == 0 else take_sentence)(pending)
                if not piece:
                    break
                pending = rest
                say(piece)
        if finished:
            break
    if speak and audio and pending.strip():
        say(pending)
    if timing:
        timing({"firstTokenMs": round(first_token_ms or 0), "synthesisMs": round(synthesis_ms), "totalMs": round((time.perf_counter() - began) * 1000), "promptCharacters": len(prompt),
                "promptTokens": prompt_tokens, "cachedTokens": cached_tokens,
                "residentMB": {key[0]: round(value / 1_000_000) for key, value in RESIDENT_BYTES.items()}})
    return text.strip()

def warm_up(model_id, role):
    """The first generation after a load runs at a fraction of the speed — kernels are compiled on
    the way — and the first turn is exactly where that shows. Paid here, at launch, instead."""
    import numpy as np
    if role == "reasoning":
        chat([{"role": "user", "content": "Say ready."}], 3)
    elif role == "tts":
        synthesize("Ready.", "bm_george", 1.0)
    elif role == "embedding":
        embed(["ready"])
    elif role in ("asr", "duplex"):
        path = write_audio(np.zeros(8000, dtype=np.float32), 16000)
        try:
            if role == "asr":
                transcribe(model_id, str(path))
            else:
                duplex_reply(str(path), "Say ready.", None, None, None, max_seconds=2)
        finally:
            path.unlink(missing_ok=True)

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

def endpoint_fixtures(cancelled, text=QUALIFY_TEXT):
    """One rendered phrase becomes a finished turn, an unfinished turn, and silence."""
    import numpy as np
    samples, rate = synthesize(text, "bm_george", 1.0, cancelled)
    finished = np.concatenate([samples, np.zeros(int(rate * 1.5), dtype=np.float32)])
    unfinished = samples[: int(len(samples) * 0.55)]
    silence = np.zeros(rate * 3, dtype=np.float32)
    return [write_audio(value, rate) for value in (finished, unfinished, silence)]

def wake_fixtures(cancelled):
    """The name, a sentence that is not the name, and silence — one render each."""
    import numpy as np
    called, rate = synthesize("Hey Jarvis.", "bm_george", 1.0, cancelled)
    # The phrase model reads the end of the clip, so the name is left where it lands.
    called = np.concatenate([np.zeros(int(rate * 0.4), dtype=np.float32), called])
    other, _ = synthesize("Good evening. Ready when you are.", "bm_george", 1.0, cancelled)
    silence = np.zeros(rate * 2, dtype=np.float32)
    return [write_audio(value, rate) for value in (called, other, silence)]

def qualify(model_id, item, cancelled):
    """Run the observable behavior this role is relied on for, and report what was seen."""
    import numpy as np
    role = item["role"]
    stage = lambda message: event("model.progress", {"id": model_id, "stage": message})
    if role in ("asr", "vad", "turn", "wake", "duplex"):
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
    if role == "duplex":
        import soundfile as sf
        stage("Rendering the spoken question")
        samples, rate = synthesize(DUPLEX_QUESTION, "bm_george", 1.0, cancelled)
        asked = write_audio(samples, rate)
        stage(f"Loading {item['name']}")
        load(model_id, "duplex")
        def turn():
            clips = []
            try:
                started = time.perf_counter()
                said, spoken = duplex_reply(
                    str(asked), "You are Jarvis, a concise British assistant. Answer in one short sentence.",
                    None, cancelled, lambda path, duration: clips.append((path, duration)),
                )
                elapsed = time.perf_counter() - started
                heard = [np.asarray(sf.read(path, dtype="float32")[0]).reshape(-1) for path, _ in clips]
            finally:
                for path, _ in clips:
                    Path(path).unlink(missing_ok=True)
            answer = np.concatenate(heard) if heard else np.zeros(1, dtype="float32")
            return said, spoken, elapsed, len(clips), float(np.sqrt(np.mean(np.square(answer))))
        try:
            # The first generation after loading pays for kernel compilation and is not the speed a
            # conversation runs at; the application warms the model at launch for the same reason.
            stage("Warming the model with one turn")
            _, first_spoken, first_elapsed, _, _ = turn()
            stage("Holding one spoken turn")
            said, spoken, elapsed, pieces, energy = turn()
        finally:
            asked.unlink(missing_ok=True)
        first_pace = first_spoken / first_elapsed if first_elapsed > 0 else 0
        # Generation outpacing playback is what lets a reply start early and never run dry.
        pace = spoken / elapsed if elapsed > 0 else 0
        return [
            check("Answer it spoke", said, DUPLEX_KEY in spoken_words(said)),
            check("Length of the answer", f"{spoken:.2f} s", spoken >= 0.5),
            check("Speech energy", f"{energy:.4f} RMS", energy > 0.005),
            check("Delivered in pieces", f"{pieces} clips", pieces >= 2),
            check("Ahead of playback, warmed", f"{pace:.2f}× realtime (cold {first_pace:.2f}×)", pace >= 1.0),
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
    if model_id == "keyword":
        from wake_keywords import KeywordListener
        checks = []
        samples_to_check = [
            ("Jarvis", "Hey Jarvis.", True), ("Jarvis", "Jarvis.", True),
            ("Friday", "Hey Friday.", True), ("Friday", "Friday.", True),
            ("Friday", "Hey Jarvis.", False),
            ("Jarvis", "What is the capital of France?", False),
        ]
        for index, (name, text, expected) in enumerate(samples_to_check * 3):
            samples, rate = synthesize(text, "bm_george" if index < len(samples_to_check) * 2 else "af_heart", 1, cancelled=cancelled)
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(rate, 16000)
            samples = np.concatenate([np.zeros(6400), resample_poly(samples, 16000 // g, rate // g), np.zeros(16000)])
            listener = KeywordListener(model_path(model_id), name)
            detected = any([listener.accept(samples[i:i+512]) for i in range(0, len(samples), 512)])
            checks.append(check(f"Take {index // len(samples_to_check) + 1}, {name}: {text}", str(detected), detected == expected))
        quiet = KeywordListener(model_path(model_id)).accept(np.zeros(16000 * 3))
        checks.append(check("Silence rejected", str(quiet), not quiet))
        return checks
    if role == "wake":
        from wake import predict as wake_predict, THRESHOLD as WAKE_THRESHOLD
        weights = model_path(model_id)
        takes = []
        for index in range(QUALIFY_TAKES):
            stage(f"Rendering the name and what is not the name, take {index + 1} of {QUALIFY_TAKES}")
            paths = wake_fixtures(cancelled)
            try:
                stage(f"Running {item['name']}, take {index + 1} of {QUALIFY_TAKES}")
                takes.append([wake_predict(str(path), weights) for path in paths])
            finally:
                for path in paths:
                    path.unlink(missing_ok=True)
        called = [take[0] for take in takes]
        other = [take[1] for take in takes]
        quiet = [take[2] for take in takes]
        spread = ", ".join(f"{result['score']:.3f}" for result in called)
        return [
            check("Score in range", spread, all(0.0 <= result["score"] <= 1.0 for result in called)),
            check(f"The name reaches {WAKE_THRESHOLD}", f"{spread} · lowest {min(result['score'] for result in called):.3f}", all(result["awake"] is True for result in called)),
            check("Other speech never wakes", *tally(other, "awake", False)),
            check("Silence never wakes", *tally(quiet, "awake", False)),
        ]
    if role in ("vad", "turn"):
        from endpoint import predict, THRESHOLD
        turn = model_path("smart-turn") if role == "turn" else None
        silero = model_path("silero")
        takes = []
        rounds = TURN_TAKES if role == "turn" else QUALIFY_TAKES
        for index in range(rounds):
            stage(f"Rendering speech and silence, take {index + 1} of {rounds}")
            paths = endpoint_fixtures(cancelled, TURN_TEXT if role == "turn" else QUALIFY_TEXT)
            try:
                stage(f"Running {item['name']}, take {index + 1} of {rounds}")
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
        # What matters for safety has to hold on every render: silence and an unfinished thought
        # never end a turn. For the finished question, every render clears the authors' bar and
        # the typical render clears the stricter one this product ends a turn on; the one render
        # in several that lands under it costs a pause of a second and a half, not a cut-off.
        middle = sorted(probabilities)[len(probabilities) // 2]
        return [
            check("Probability in range", spread, all(0.0 <= value <= 1.0 for value in probabilities)),
            check("Silence never finishes a turn", *tally(quiet, "complete", False)),
            check("Unfinished speech never finishes a turn", *tally(partial, "complete", False)),
            check(f"Every finished question reaches {TURN_FLOOR}", f"{spread} · lowest {min(probabilities):.3f}", all(value >= TURN_FLOOR for value in probabilities)),
            check(f"A typical finished question reaches {THRESHOLD}", f"median {middle:.3f}", middle >= THRESHOLD),
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
    began = time.perf_counter()
    request_id = request["id"]
    method = request["method"]
    p = request.get("params", {})
    cancelled = lambda: request_id in CANCELLED
    try:
        if request_id in CANCELLED:
            raise ValueError("Cancelled.")
        if method == "ping":
            import mlx.core as mx
            result = {"version": 1, "mlx": True, "memory": mx.get_active_memory(), "peakMemory": mx.get_peak_memory(), "roles": sorted(RUNNABLE_ROLES), "models": sorted(RUNNABLE_MODELS)}
        elif method == "models.status":
            result = {item["id"]: manifest(item["id"]) for item in CATALOG}
        elif method == "model.install":
            model_id = p["id"]
            item = next(item for item in CATALOG if item["id"] == model_id)
            if model_id not in RUNNABLE_MODELS:
                raise ValueError("This research profile has no Mac adapter in this worker yet.")
            if model_id == "keyword":
                from wake_keywords import install
                target = MODELS / model_id
                event("model.progress", {"id": model_id, "stage": "Downloading verified keyword model"})
                revision = install(target / "weights")
                record = {"id": model_id, "repository": item["repository"], "revision": revision, "installedAt": time.time(), "qualified": False}
                (target / "manifest.json").write_text(json.dumps(record))
                send({"version": 1, "id": request_id, "result": record})
                return
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
        elif method == "duplex":
            said, seconds = duplex_reply(
                bounded_audio(p["path"]), p.get("instructions"), p.get("history"), cancelled,
                lambda clip, duration: event("duplex.audio", {"requestId": request_id, "conversationId": p.get("conversationId"), "path": clip, "duration": duration}),
                p.get("maxSeconds"),
            )
            result = {"text": said, "duration": seconds}
        elif method == "chat.prepare":
            result = prepare(p["messages"], cancelled)
        elif method == "models.warm":
            # The first exchange is the one that feels slowest, so the models a spoken turn needs
            # are loaded before anybody asks for them. Smallest first: they all have to fit at once.
            warmed = []
            for role in (p.get("roles") or ["asr", "embedding", "reasoning", "tts"]):
                if cancelled():
                    raise ValueError("Cancelled.")
                ready = [item["id"] for item in CATALOG
                         if item["role"] == role and (manifest(item["id"]) or {}).get("qualified")]
                if not ready:
                    continue
                try:
                    model_id = min(ready, key=weights_bytes)
                    load(model_id, role)
                    if cancelled():
                        raise ValueError("Cancelled.")
                    warm_up(model_id, role)
                    warmed.append(role)
                except Exception as error:
                    print(f"warm {role}: {error}", file=sys.stderr)
                    continue
            result = {"warmed": warmed}
        elif method == "asr":
            path = bounded_audio(p["path"])
            result = {"text": transcribe(p.get("model", "whisper"), path, p.get("prompt"))}
        elif method == "endpoint":
            from endpoint import predict
            result = predict(bounded_audio(p["path"]), model_path("silero"), model_path("smart-turn"))
        elif method == "wake":
            from wake import predict as wake_predict
            result = wake_predict(bounded_audio(p["path"]), model_path("openwakeword"))
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
                p.get("maxSentences"), p.get("routeTasks", False),
                lambda result: event("chat.timing", {"conversationId": p.get("conversationId"), "queueMs": round((began - request.get("_queuedAt", began)) * 1000), **result}),
            )
            result = {"text": "" if text == "<task/>" else text, "task": text == "<task/>"}
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
        # Some exceptions stringify to nothing at all; the name is better than silence.
        send({"version": 1, "id": request_id, "error": (str(error) or error.__class__.__name__)[:1600]})
    finally:
        CANCELLED.discard(request_id)
        PENDING.discard(request_id)

# The open microphone, heard frame by frame on its own thread. Frames and the questions asked about
# them never enter the executor, so a reply being written cannot make the listener late.
LISTENER = None

def listener():
    global LISTENER
    if LISTENER is None:
        from listen import Listener
        LISTENER = Listener(send, model_path)
    return LISTENER

for line in sys.stdin:
    if len(line.encode()) > 1_048_576:
        break
    try:
        request = json.loads(line)
        if request.get("version") != 1:
            raise ValueError("Unsupported protocol version.")
        method = request.get("method")
        params = request.get("params", {})
        if method == "cancel":
            cancelled_id = params.get("requestId")
            if cancelled_id in PENDING:
                CANCELLED.add(cancelled_id)
        elif method == "audio.frame":
            if LISTENER:
                LISTENER.push(params)
        elif method == "listen.configure":
            listener().push({"_configure": True, **params})
        elif method == "endpoint" and request.get("id") and "path" not in params:
            listener().push({"_ask": request["id"], **params})
        elif request.get("id"):
            if len(PENDING) >= 128:
                send({"version": 1, "id": request["id"], "error": "The model queue is full."})
            else:
                PENDING.add(request["id"])
                request["_queuedAt"] = time.perf_counter()
                EXECUTOR.submit(execute, request)
    except Exception:
        continue
EXECUTOR.shutdown(wait=False, cancel_futures=True)
