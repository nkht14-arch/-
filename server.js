import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { TEMPLATES, COMMON_SYSTEM_PROMPT, buildUserPrompt } from "./lib/templates.js";
import { generateOfflineDraft } from "./lib/offline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const MAX_TRANSCRIPT_CHARS = 400_000;

// ANTHROPIC_API_KEY（または `ant auth login` のプロファイル）を自動で読み込む
let client = null;
try {
  client = new Anthropic();
} catch {
  client = null;
}
const hasCredentials = () =>
  Boolean(client && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || process.env.CLAUDE_ONLINE === "1"));

export const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(here, "public")));
// Markdown 描画ライブラリはローカルから配信（院内ネットワーク等で CDN が使えない場合に備える）
app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(here, "node_modules/marked/lib/marked.umd.js")));
app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(here, "node_modules/dompurify/dist/purify.min.js")));

app.get("/api/config", (_req, res) => {
  res.json({
    online: hasCredentials(),
    model: MODEL,
    templates: Object.fromEntries(
      Object.entries(TEMPLATES).map(([k, t]) => [k, { label: t.label, description: t.description }]),
    ),
  });
});

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/minutes", async (req, res) => {
  const { transcript, template, meta, extraInstructions, mode } = req.body ?? {};
  if (typeof transcript !== "string" || !transcript.trim()) {
    return res.status(400).json({ error: "文字起こしテキストが空です。" });
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return res.status(413).json({ error: `文字起こしが長すぎます（${MAX_TRANSCRIPT_CHARS.toLocaleString()}文字まで）。分割してください。` });
  }
  if (template && !TEMPLATES[template]) {
    return res.status(400).json({ error: "不明なテンプレートです。" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  if (mode === "offline" || !hasCredentials()) {
    sse(res, "meta", { engine: "offline" });
    sse(res, "text", { text: generateOfflineDraft({ template, transcript, meta }) });
    sse(res, "done", { stop_reason: "offline" });
    return res.end();
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    sse(res, "meta", { engine: "claude", model: MODEL });
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // 安全分類器による拒否時はサーバー側で自動的に代替モデルへ切り替え
        output_config: { effort: "medium" },
        system: [{ type: "text", text: COMMON_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: buildUserPrompt({ template, transcript, meta, extraInstructions: extraInstructions ?? "" }),
          },
        ],
      },
      { signal: abort.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        sse(res, "text", { text: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      sse(res, "error", { message: "モデルがこの内容の処理を拒否しました。内容を確認してください。" });
    } else if (final.stop_reason === "max_tokens") {
      sse(res, "warning", { message: "出力が上限に達したため途中で終了しました。文字起こしを分割してください。" });
    }
    sse(res, "done", { stop_reason: final.stop_reason, usage: final.usage, model: final.model });
  } catch (err) {
    if (abort.signal.aborted) return;
    let message = "議事録の生成に失敗しました。";
    if (err instanceof Anthropic.AuthenticationError) message = "APIキーが無効です（401）。";
    else if (err instanceof Anthropic.RateLimitError) message = "APIの利用上限に達しました（429）。しばらく待って再実行してください。";
    else if (err instanceof Anthropic.BadRequestError) message = `リクエストが不正です：${err.message}`;
    else if (err instanceof Anthropic.APIStatusError) message = `APIエラー（${err.status}）：${err.message}`;
    else if (err instanceof Anthropic.APIConnectionError) message = "APIに接続できませんでした。ネットワークを確認してください。";
    console.error(err);
    sse(res, "error", { message });
  }
  res.end();
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`ケア議事録アプリ: http://localhost:${PORT}`);
    console.log(hasCredentials() ? `Claude (${MODEL}) で議事録を生成します。` : "APIキー未設定：オフライン下書きモードで動作します。");
  });
}
