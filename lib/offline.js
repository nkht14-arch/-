// APIキーが無い場合のオフライン下書き生成（キーワード抽出によるルールベース）
import { TEMPLATES } from "./templates.js";

const RISK_KEYWORDS = [
  "転倒", "転落", "誤嚥", "むせ", "褥瘡", "発赤", "脱水", "低栄養", "体重減少", "食欲低下",
  "飲み忘れ", "服薬ミス", "誤薬", "急変", "発熱", "呼吸苦", "胸痛", "意識", "徘徊", "暴言", "暴力",
  "不穏", "せん妄", "虐待", "ネグレクト", "介護負担", "疲れ", "独居", "感染", "コロナ", "インフルエンザ",
];
const TODO_KEYWORDS = ["お願い", "確認", "調整", "連絡", "手配", "検討", "までに", "担当"];
const NEXT_KEYWORDS = ["次回", "来月", "再来月", "ヶ月後", "か月後", "週間後", "モニタリング"];

export function splitSentences(text) {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[。！？!?])|\n+/)
    .map((s) => s.replace(/^\s*(\[[^\]]*\]|［[^］]*］)?\s*/, "").trim())
    .filter((s) => s.length >= 4);
}

function pick(sentences, keywords, used, limit = 8) {
  const hits = [];
  for (const s of sentences) {
    if (hits.length >= limit) break;
    if (keywords.some((k) => s.includes(k))) {
      hits.push(s);
      used.add(s);
    }
  }
  return hits;
}

const bullet = (arr) => (arr.length ? arr.map((s) => `- ${s}`).join("\n") : "- （該当する発言を自動抽出できませんでした）【要確認】");

export function generateOfflineDraft({ template, transcript, meta = {} }) {
  const t = TEMPLATES[template] ?? TEMPLATES.case_conference;
  const sentences = splitSentences(transcript);
  const used = new Set();
  const v = (x) => (x && String(x).trim() ? String(x).trim() : "【要確認】");

  const parts = [];
  parts.push(`# ${t.label} 議事録（自動下書き）`);
  parts.push(
    "> ⚠ この下書きはAPIキー未設定のため、キーワード抽出のみで作成されています。内容を必ず確認・加筆してください。",
  );
  parts.push(
    [
      "| 項目 | 内容 |",
      "| --- | --- |",
      `| 開催日時 | ${v(meta.datetime)} |`,
      `| 場所 | ${v(meta.place)} |`,
      `| 対象者 | ${v(meta.subject)} |`,
      `| 出席者 | ${v(meta.attendees)} |`,
      `| 記録者 | ${v(meta.recorder)} |`,
    ].join("\n"),
  );
  for (const sec of t.sections) {
    parts.push(`## ${sec.title}\n${bullet(pick(sentences, sec.keywords, used))}`);
  }
  const risks = pick(sentences, RISK_KEYWORDS, used, 10);
  parts.push(`## ⚠ リスク・要注意事項\n${risks.length ? bullet(risks) : "- 特記なし（自動抽出）"}`);
  const todos = pick(sentences, TODO_KEYWORDS, used, 10);
  parts.push(
    `## 役割分担・ToDo\n| 担当（職種） | 内容 | 期限 |\n| --- | --- | --- |\n` +
      (todos.length ? todos.map((s) => `| 【要確認】 | ${s.replace(/\|/g, "｜")} | 未定 |`).join("\n") : "| 【要確認】 | （自動抽出なし） | 未定 |"),
  );
  const next = pick(sentences, NEXT_KEYWORDS, used, 3);
  parts.push(`## 次回予定\n${next.length ? bullet(next) : "- 【要確認】"}`);
  return parts.join("\n\n") + "\n";
}
