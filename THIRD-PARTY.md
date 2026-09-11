# Third-party components

Jarvis includes free, open-source components. Their license files remain with the installed packages. Model weights are downloaded separately at recorded repository revisions; their own terms apply.

- [electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass): native macOS glass material, MIT.
- [Victor’s library collection](https://github.com/vhicktour/libraries): `thinking-orbs` supplies the sphere projection engine; `liquid-gooey` supplies restrained control transitions. Jarvis uses a custom particle sphere to honor the requested motion. No perimeter beam or ribbon is rendered.
- Electron, React, React Aria, Motion, Tailwind CSS, Lucide, Sora, Zod, Croner, and the Model Context Protocol SDK provide the application foundation.
- [MLX Audio](https://github.com/Blaizzy/mlx-audio), [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), MLX VLM, MLX Embeddings, ONNX Runtime, and their locked dependencies provide the local model runtime.
- [Silero VAD](https://github.com/snakers4/silero-vad) and [Smart Turn](https://github.com/pipecat-ai/smart-turn) document the endpoint input formats used in `workers/endpoint.py`.
- [openWakeWord](https://github.com/dscripka/openWakeWord) supplies the wake models used in `workers/wake.py`, Apache-2.0. Upstream publishes weights through GitHub releases rather than HuggingFace, and the installer downloads from HuggingFace only, so the catalogue points at a mirror — `harvestsu/openwakeword-onnx`, pinned by revision. Each of the three graphs was checked byte for byte against the upstream v0.5.1 release before the mirror was adopted: `melspectrogram.onnx` ba2b0e0f8b7b8753…, `embedding_model.onnx` 70d164290c1d095d…, `hey_jarvis_v0.1.onnx` 94a13cfe60075b13… (SHA-256, first 16). Re-check them if the pinned revision ever moves.
- [Codex App Server](https://developers.openai.com/codex/app-server) and the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) provide the optional specialist adapters.
- `better-sqlite3-multiple-ciphers` provides encrypted SQLite.

Exact JavaScript versions are in `pnpm-lock.yaml`. Python packages and hashes are in `workers/requirements.lock`. Installed model repository revisions and license labels are shown in Settings.
