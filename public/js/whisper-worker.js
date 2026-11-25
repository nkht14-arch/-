// ブラウザ内で Whisper による文字起こしを行う Web Worker
// 音声データは外部に送信されません（モデルファイルのみ初回にダウンロードしキャッシュ）。
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";

env.allowLocalModels = false;

let transcriber = null;
let loadedKey = null;

async function getTranscriber(model, device) {
  const key = `${model}|${device}`;
  if (transcriber && loadedKey === key) return transcriber;
  const opts = {
    device,
    dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
    progress_callback: (p) => {
      if (p.status === "progress") {
        self.postMessage({ type: "download", file: p.file, progress: p.progress ?? 0 });
      }
    },
  };
  transcriber = await pipeline("automatic-speech-recognition", model, opts);
  loadedKey = key;
  return transcriber;
}

self.onmessage = async (e) => {
  const { type, audio, model, device, language } = e.data;
  if (type !== "transcribe") return;
  try {
    self.postMessage({ type: "status", message: "モデルを読み込み中…（初回のみ数分かかります）" });
    const asr = await getTranscriber(model, device);
    self.postMessage({ type: "status", message: "文字起こし中…" });

    // 長時間音声は 30 秒単位で分割し、進捗を通知しながら処理
    const SR = 16000;
    const CHUNK = 30 * SR;
    const total = Math.ceil(audio.length / CHUNK);
    const segments = [];
    for (let i = 0; i < total; i++) {
      const slice = audio.subarray(i * CHUNK, Math.min(audio.length, (i + 1) * CHUNK));
      const out = await asr(slice, {
        language,
        task: "transcribe",
        chunk_length_s: 30,
        return_timestamps: true,
      });
      const offset = (i * CHUNK) / SR;
      const chunks = out.chunks?.length ? out.chunks : [{ text: out.text, timestamp: [0, slice.length / SR] }];
      for (const c of chunks) {
        const text = (c.text ?? "").trim();
        if (!text) continue;
        const start = (c.timestamp?.[0] ?? 0) + offset;
        segments.push({ start, text });
      }
      self.postMessage({ type: "progress", done: i + 1, total, segments });
    }
    self.postMessage({ type: "done", segments });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message ?? err) });
  }
};
