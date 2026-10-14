// Runs Whisper speech recognition off the main thread with word-level timestamps.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;

let asr = null;
let loadedKey = "";

async function pickDevice(allowGpu) {
  if (!allowGpu) return "wasm";
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return "webgpu";
  } catch {
    // Fall through to WebAssembly.
  }
  return "wasm";
}

// Xenova/* repos ship fp32 and 8-bit weights; onnx-community/* repos also ship 4-bit.
function dtypeFor(model, device) {
  if (device !== "webgpu") return "q8";
  return model.startsWith("Xenova/") ? "fp32" : { encoder_model: "fp32", decoder_model_merged: "q4" };
}

self.onmessage = async (event) => {
  const { type, audio, model, language, allowGpu } = event.data;
  if (type !== "transcribe") return;

  try {
    const device = await pickDevice(allowGpu);
    const key = `${model}|${device}`;
    if (!asr || loadedKey !== key) {
      self.postMessage({ type: "status", message: "Loading speech model…" });
      asr = await pipeline("automatic-speech-recognition", model, {
        device,
        dtype: dtypeFor(model, device),
        progress_callback: (p) => self.postMessage({ type: "progress", data: p }),
      });
      loadedKey = key;
    }

    self.postMessage({ type: "status", message: `Transcribing on ${device === "webgpu" ? "GPU" : "CPU"}…` });
    const output = await asr(audio, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(language ? { language, task: "transcribe" } : {}),
    });
    self.postMessage({ type: "result", chunks: output.chunks ?? [], text: output.text ?? "" });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message ?? err) });
  }
};
