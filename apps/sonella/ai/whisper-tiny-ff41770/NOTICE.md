# Whisper tiny for Sonella's local transcription

These files are OpenAI's Whisper tiny (multilingual) in the ONNX export by `onnx-community/whisper-tiny`
on Hugging Face, revision `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`, unchanged except that
`onnx/decoder_model_merged_quantized.onnx` (30,719,241 bytes) is split into
`decoder_model_merged_quantized.onnx.part0` and `.part1`, because Cloudflare serves at most 25 MiB per
static file. Sonella joins the parts in the browser and checks the joined file's SHA-256
(`25e807a9…`). `onnx/encoder_model_quantized.onnx` is stored here as `encoder_model_quantized.onnx`.

Licence: Whisper's code and model weights are released by OpenAI under the MIT License; see
`../whisper-LICENSE-MIT.txt` (from github.com/openai/whisper). The Hugging Face model card of
`openai/whisper-tiny` lists Apache-2.0.

The runtime beside this folder: `../transformers-4.3.2.min.js` is `@huggingface/transformers` 4.3.2
(`dist/transformers.min.js`, Apache-2.0, `../transformers-LICENSE-Apache-2.0.txt`);
`../ort-wasm-simd-threaded-1.31.0-dev.20260914.{mjs,wasm}` are `onnxruntime-web`
1.31.0-dev.20260914-8d85527a0 (`dist/ort-wasm-simd-threaded.{mjs,wasm}`, MIT,
`../onnxruntime-LICENSE-MIT.txt`). Pinned sizes and hashes are in `src/speech.js` (`SPEECH`).
