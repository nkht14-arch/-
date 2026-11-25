import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGlossary, parseGlossaryText } from "../public/shared/glossary.js";
import { maskPII, parseNames } from "../public/shared/masking.js";
import { generateOfflineDraft } from "../lib/offline.js";
import { buildUserPrompt, TEMPLATES } from "../lib/templates.js";
import { app } from "../server.js";

test("用語補正：誤変換を医療・介護用語に直す", () => {
  const { text, corrections } = applyGlossary("ようかいご2で、でいさーびすの日にじょくそうを確認。");
  assert.equal(text, "要介護2で、デイサービスの日に褥瘡を確認。");
  assert.equal(corrections.length, 3);
});

test("用語補正：置換後の表記を二重に置換しない", () => {
  const once = applyGlossary("床ずれがある").text;
  assert.equal(once, "褥瘡（床ずれ）がある");
  assert.equal(applyGlossary(once).text, once);
});

test("ユーザー辞書のパース", () => {
  assert.deepEqual(parseGlossaryText("# comment\nあむろじぴん,アムロジピン\n\na→b"), [
    ["あむろじぴん", "アムロジピン"],
    ["a", "b"],
  ]);
});

test("個人情報マスキング", () => {
  const names = parseNames("山田花子様、山田");
  const { text, count } = maskPII("山田花子さんの長女（090-1234-5678）。山田さんは元気。", names);
  assert.ok(!text.includes("山田"));
  assert.ok(!text.includes("090"));
  assert.equal(count, 3);
});

test("オフライン下書きがテンプレート見出しを含む", () => {
  const md = generateOfflineDraft({
    template: "service_conference",
    transcript: "[00:00] 本日は計画の見直しを検討します。\n[00:10] 最近、夜間に転倒がありました。\n[00:20] 福祉用具を追加することに決定しました。\n[00:30] 次回は3か月後に開催します。",
    meta: { place: "自宅" },
  });
  for (const s of TEMPLATES.service_conference.sections) assert.ok(md.includes(`## ${s.title}`));
  assert.match(md, /転倒/);
  assert.match(md, /3か月後/);
  assert.match(md, /\| 場所 \| 自宅 \|/);
});

test("プロンプトに文字起こしとテンプレートが入る", () => {
  const p = buildUserPrompt({ template: "soap", transcript: "血圧138/82", meta: {} });
  assert.match(p, /S：主観的情報/);
  assert.match(p, /<transcript>\n血圧138\/82\n<\/transcript>/);
});

test("API：オフラインモードでSSEを返す", async () => {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const cfg = await (await fetch(`http://localhost:${port}/api/config`)).json();
    assert.ok(cfg.templates.handover);
    const res = await fetch(`http://localhost:${port}/api/minutes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "夜間に発熱がありました。朝に検温をお願いします。", template: "handover", mode: "offline" }),
    });
    const body = await res.text();
    assert.match(body, /event: text/);
    assert.match(body, /event: done/);
    const bad = await fetch(`http://localhost:${port}/api/minutes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
