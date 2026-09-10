# Third-party components

Jarvis includes free, open-source components. Their license files remain with the installed packages. Model weights are downloaded separately at recorded repository revisions; their own terms apply.

- [electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass): native macOS glass material, MIT.
- [Victor’s library collection](https://github.com/vhicktour/libraries): `thinking-orbs` supplies the sphere projection engine; `liquid-gooey` supplies restrained control transitions. Jarvis uses a custom particle sphere to honor the requested motion. No perimeter beam or ribbon is rendered.
- Electron, React, React Aria, Motion, Tailwind CSS, Lucide, Sora, Zod, Croner, and the Model Context Protocol SDK provide the application foundation.
- [MLX Audio](https://github.com/Blaizzy/mlx-audio), [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), MLX VLM, MLX Embeddings, ONNX Runtime, and their locked dependencies provide the local model runtime.
- [Silero VAD](https://github.com/snakers4/silero-vad) and [Smart Turn](https://github.com/pipecat-ai/smart-turn) document the endpoint input formats used in `workers/endpoint.py`.
- [Codex App Server](https://developers.openai.com/codex/app-server) and the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) provide the optional specialist adapters.
- `better-sqlite3-multiple-ciphers` provides encrypted SQLite.

Exact JavaScript versions are in `pnpm-lock.yaml`. Python packages and hashes are in `workers/requirements.lock`. Installed model repository revisions and license labels are shown in Settings.
