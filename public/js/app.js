import { DEFAULT_GLOSSARY, applyGlossary, parseGlossaryText } from "../shared/glossary.js";
import { maskPII, parseNames } from "../shared/masking.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = "") {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* 保存不可の環境では無視 */ }
  },
};

const state = {
  audioFile: null,
  config: null,
  minutes: "",
  abort: null,
};

// ---------- 共通 ----------
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
const fmtTime = (sec) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// ---------- 設定 ----------
async function loadConfig() {
  const sel = $("templateSelect");
  try {
    const res = await fetch("api/config");
    state.config = await res.json();
    const eng = $("engine");
    if (state.config.online) {
      eng.textContent = `AI生成：Claude（${state.config.model}）`;
      eng.className = "engine online";
    } else {
      eng.textContent = "オフライン下書きモード（APIキー未設定）";
      eng.className = "engine offline";
    }
    for (const [key, t] of Object.entries(state.config.templates)) {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = t.label;
      sel.appendChild(o);
    }
    sel.value = store.get("template", "service_conference");
    if (!sel.value) sel.selectedIndex = 0;
    updateTemplateDesc();
  } catch {
    $("engine").textContent = "サーバーに接続できません";
  }
}
function updateTemplateDesc() {
  const t = state.config?.templates?.[$("templateSelect").value];
  $("templateDesc").textContent = t?.description ?? "";
}
$("templateSelect").addEventListener("change", () => {
  store.set("template", $("templateSelect").value);
  updateTemplateDesc();
});

// ---------- STEP1: 音声入力 ----------
const dz = $("dropzone");
dz.addEventListener("click", () => $("fileInput").click());
dz.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fileInput").click(); }
});
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  const f = e.dataTransfer.files?.[0];
  if (f) setAudio(f);
});
$("fileInput").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) setAudio(f);
});

function setAudio(file) {
  state.audioFile = file;
  const p = $("player");
  p.src = URL.createObjectURL(file);
  p.hidden = false;
  $("transcribeBtn").disabled = false;
  dz.querySelector("strong").textContent = `選択中：${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB）`;
}

// 録音
let recorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = null;
$("recBtn").addEventListener("click", async () => {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    recorder = new MediaRecorder(stream);
    recChunks = [];
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      $("recBtn").textContent = "● その場で録音";
      $("recBtn").classList.remove("recording");
      const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      const ext = (recorder.mimeType || "").includes("mp4") ? "m4a" : "webm";
      setAudio(new File([blob], `録音_${new Date().toLocaleString("ja-JP").replace(/[/: ]/g, "")}.${ext}`, { type: blob.type }));
      toast("録音を停止しました。文字起こしを開始できます。");
    };
    recorder.start(1000);
    recStart = Date.now();
    $("recBtn").textContent = "■ 録音を停止";
    $("recBtn").classList.add("recording");
    recTimer = setInterval(() => ($("recTimer").textContent = `録音中 ${fmtTime((Date.now() - recStart) / 1000)}`), 500);
  } catch (err) {
    toast(`マイクを使用できません：${err.message}`);
  }
});

// 音声を 16kHz モノラルにデコード
async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0);
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / audio.numberOfChannels;
    }
    return out;
  } finally {
    ctx.close();
  }
}

let worker = null;
function setProgress(ratio, text) {
  $("progressWrap").hidden = false;
  $("progressBar").style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  $("progressText").textContent = text;
}
function segmentsToText(segments) {
  return segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join("\n");
}

$("transcribeBtn").addEventListener("click", async () => {
  if (!state.audioFile) return;
  const btn = $("transcribeBtn");
  btn.disabled = true;
  setProgress(0, "音声を読み込み中…");
  let audio;
  try {
    audio = await decodeAudio(state.audioFile);
  } catch (err) {
    toast(`音声ファイルを読み込めません：${err.message}`);
    btn.disabled = false;
    return;
  }
  const duration = audio.length / 16000;
  const samples = new Float32Array(audio); // 転送用にコピー
  const device = "gpu" in navigator ? "webgpu" : "wasm";
  worker ??= new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
  const started = Date.now();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "status") setProgress(0, m.message);
    else if (m.type === "download") setProgress(m.progress / 100, `モデルをダウンロード中… ${Math.round(m.progress)}%`);
    else if (m.type === "progress") {
      const elapsed = (Date.now() - started) / 1000;
      const eta = (elapsed / m.done) * (m.total - m.done);
      setProgress(m.done / m.total, `文字起こし中… ${m.done}/${m.total} 区間（残り約 ${fmtTime(eta)}）`);
      $("transcript").value = segmentsToText(m.segments);
      updateCount();
    } else if (m.type === "done") {
      $("transcript").value = segmentsToText(m.segments);
      updateCount();
      saveDraft();
      setProgress(1, `完了（音声 ${fmtTime(duration)}／処理 ${fmtTime((Date.now() - started) / 1000)}）`);
      btn.disabled = false;
      runGlossary(true);
    } else if (m.type === "error") {
      setProgress(0, `エラー：${m.message}`);
      toast("文字起こしに失敗しました。モデルを「標準」に変えて再試行してください。");
      btn.disabled = false;
    }
  };
  worker.postMessage(
    { type: "transcribe", audio: samples, model: $("modelSelect").value, device, language: "japanese" },
    [samples.buffer],
  );
});

// ---------- STEP2: 文字起こし編集・用語補正 ----------
const updateCount = () => ($("charCount").textContent = `${$("transcript").value.length.toLocaleString()} 文字`);
const saveDraft = () => store.set("transcript", $("transcript").value);
$("transcript").addEventListener("input", () => { updateCount(); saveDraft(); });
$("userGlossary").value = store.get("userGlossary");
$("userGlossary").addEventListener("input", () => store.set("userGlossary", $("userGlossary").value));

function runGlossary(silent = false) {
  const dict = [...parseGlossaryText($("userGlossary").value), ...DEFAULT_GLOSSARY];
  const { text, corrections } = applyGlossary($("transcript").value, dict);
  $("transcript").value = text;
  updateCount();
  saveDraft();
  const n = corrections.reduce((a, c) => a + c.count, 0);
  $("glossaryResult").textContent = n
    ? `${n}箇所を補正：${corrections.slice(0, 4).map((c) => `${c.from}→${c.to}`).join("、")}${corrections.length > 4 ? " ほか" : ""}`
    : silent ? "" : "補正対象はありませんでした";
}
$("glossaryBtn").addEventListener("click", () => runGlossary(false));

// ---------- STEP3/4: 議事録生成 ----------
const metaFields = { datetime: "mDatetime", place: "mPlace", subject: "mSubject", recorder: "mRecorder", attendees: "mAttendees" };
for (const id of [...Object.values(metaFields), "extra", "maskNames"]) {
  $(id).value = store.get(`f_${id}`);
  $(id).addEventListener("input", () => store.set(`f_${id}`, $(id).value));
}
if (!$("mDatetime").value) {
  const d = new Date();
  $("mDatetime").value = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}〜`;
}

function render(md) {
  const prev = $("preview");
  if (!md.trim()) {
    prev.className = "minutes empty";
    prev.textContent = "ここに議事録が表示されます。";
    return;
  }
  prev.className = "minutes";
  const html = DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: true }));
  prev.innerHTML = html.replace(/【要確認】/g, '<mark class="confirm">【要確認】</mark>');
  prev.querySelectorAll("h2").forEach((h) => h.textContent.includes("リスク") && h.classList.add("risk"));
}

function setMinutes(md) {
  state.minutes = md;
  $("editor").value = md;
  render(md);
  store.set("minutes", md);
}

$("generateBtn").addEventListener("click", generate);
$("stopBtn").addEventListener("click", () => state.abort?.abort());

async function generate() {
  let transcript = $("transcript").value.trim();
  if (!transcript) {
    toast("文字起こしテキストがありません。");
    return;
  }
  const meta = Object.fromEntries(Object.entries(metaFields).map(([k, id]) => [k, $(id).value]));
  let masked = 0;
  if ($("maskToggle").checked) {
    const names = parseNames($("maskNames").value);
    const r = maskPII(transcript, names);
    transcript = r.text;
    masked += r.count;
    for (const k of Object.keys(meta)) {
      const m = maskPII(meta[k], names);
      meta[k] = m.text;
      masked += m.count;
    }
  }

  state.abort = new AbortController();
  $("generateBtn").disabled = true;
  $("stopBtn").hidden = false;
  $("genStatus").textContent = masked ? `個人情報を${masked}箇所マスキングして送信中…` : "生成中…";
  let md = "";
  setMinutes("");
  document.getElementById("step-output").scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const res = await fetch("api/minutes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, template: $("templateSelect").value, meta, extraInstructions: $("extra").value }),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let lastRender = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = JSON.parse(/^data: (.+)$/m.exec(raw)?.[1] ?? "{}");
        if (ev === "text") {
          md += data.text;
          if (Date.now() - lastRender > 120) { render(md); lastRender = Date.now(); }
        } else if (ev === "meta") {
          $("genStatus").textContent = data.engine === "claude" ? "Claude が議事録を作成中…" : "オフライン下書きを作成中…";
        } else if (ev === "warning") toast(data.message);
        else if (ev === "error") throw new Error(data.message);
        else if (ev === "done") $("genStatus").textContent = "作成しました。内容を確認してください。";
      }
    }
    setMinutes(md);
  } catch (err) {
    if (err.name === "AbortError") {
      $("genStatus").textContent = "中止しました。";
      setMinutes(md);
    } else {
      $("genStatus").textContent = `エラー：${err.message}`;
      toast(err.message);
      if (md) setMinutes(md);
    }
  } finally {
    $("generateBtn").disabled = false;
    $("stopBtn").hidden = true;
    state.abort = null;
  }
}

// プレビュー／編集
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    const edit = tab.dataset.view === "edit";
    $("editor").hidden = !edit;
    $("preview").hidden = edit;
    if (!edit) setMinutes($("editor").value);
  }),
);
$("editor").addEventListener("input", () => store.set("minutes", $("editor").value));

// ---------- 出力 ----------
const currentMd = () => ($("editor").hidden ? state.minutes : $("editor").value);
function fileBase() {
  const label = state.config?.templates?.[$("templateSelect").value]?.label?.replace(/（.*?）/g, "") ?? "議事録";
  const d = new Date();
  return `${label}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentMd());
    toast("コピーしました");
  } catch {
    toast("コピーできませんでした");
  }
});
$("mdBtn").addEventListener("click", () => download(`${fileBase()}.md`, currentMd(), "text/markdown;charset=utf-8"));
$("docBtn").addEventListener("click", () => {
  const body = DOMPurify.sanitize(marked.parse(currentMd(), { gfm: true, breaks: true }));
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${fileBase()}</title>
<style>body{font-family:"游明朝","MS Mincho",serif;font-size:10.5pt;line-height:1.6}h1{font-size:16pt;border-bottom:1.5pt solid #0f7c74}h2{font-size:12pt;border-left:4pt solid #0f7c74;padding-left:6pt;margin-top:14pt}table{border-collapse:collapse;width:100%}th,td{border:0.75pt solid #888;padding:3pt 6pt;vertical-align:top}th{background:#e2f3f1}</style></head><body>${body}</body></html>`;
  download(`${fileBase()}.doc`, "﻿" + html, "application/msword");
});
$("printBtn").addEventListener("click", () => {
  if (!$("editor").hidden) setMinutes($("editor").value);
  document.querySelector('.tab[data-view="preview"]').click();
  window.print();
});

// ---------- 初期化 ----------
$("transcript").value = store.get("transcript");
updateCount();
setMinutes(store.get("minutes"));
loadConfig();
