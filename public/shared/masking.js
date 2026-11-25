// 個人情報のマスキング（外部APIへ送信する前にブラウザ内で適用）
const PATTERNS = [
  // 電話番号
  { re: /0\d{1,4}[-ー－‐]?\d{1,4}[-ー－‐]?\d{3,4}/g, label: "［電話番号］" },
  // メールアドレス
  { re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, label: "［メール］" },
  // 郵便番号
  { re: /〒?\d{3}[-ー－]\d{4}/g, label: "［郵便番号］" },
  // 被保険者番号・カルテ番号などの長い数字列（8桁以上）
  { re: /(?<![\d.])\d{8,}(?![\d.])/g, label: "［番号］" },
];

/**
 * @param {string} text
 * @param {string[]} names マスキングする氏名（フルネーム・姓・名など）
 * @returns {{ text: string, count: number }}
 */
export function maskPII(text, names = []) {
  let out = text;
  let count = 0;
  const uniq = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2 || /[一-鿿]/.test(n)))].sort(
    (a, b) => b.length - a.length,
  );
  uniq.forEach((name, i) => {
    const token = `［氏名${String.fromCharCode(65 + (i % 26))}］`;
    const parts = out.split(name);
    count += parts.length - 1;
    out = parts.join(token);
  });
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return label;
    });
  }
  return { text: out, count };
}

/** カンマ・読点・改行区切りの氏名リストを配列に */
export function parseNames(src = "") {
  return src
    .split(/[,，、\s]+/)
    .map((s) => s.replace(/(さん|様|氏|くん|ちゃん)$/, "").trim())
    .filter(Boolean);
}
