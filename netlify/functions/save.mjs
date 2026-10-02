const OWNER_REPO = process.env.GITHUB_REPO || "seahirodigital/html_samples";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const ROOT = "biyou_platform";
const ALLOWED_ORIGIN = process.env.SAVE_ALLOWED_ORIGIN || "https://biyou-platform.netlify.app";
const ALLOWED = new Set([
  "00_図解ナビゲーション.html", "01_B2C具体ターゲット母数マトリクス.html", "02_B2C通院理由・年齢別.html",
  "03_情報源別ペイン.html", "04_顧客ペイン4分類.html", "05_ペインからUX要件.html",
  "06_競合ポジショニング象限.html", "07_実在競合・口コミ勝敗条件.html", "08_競合機能比較表.html",
  "09_B2Bターゲット優先順位.html", "10_B2Bセグメント統合.html", "11_B2Cコミュニケーションプラン.html",
  "12_B2Bコミュニケーションプラン.html", "13_段階的プロダクト拡張.html", "14_目標UXと実現資産.html",
  "15_送客起点統合ロードマップ.html", "16_累積型事業拡大チャート.html", "17_B2B_B2Cビジネスモデル.html",
]);

const json = (statusCode, body) => new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const apiUrl = (name) => `https://api.github.com/repos/${OWNER_REPO}/contents/${encodeURIComponent(ROOT)}/${encodeURIComponent(name)}`;
const headers = () => ({ Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" });
const github = async (url, init = {}) => { const response = await fetch(url, { ...init, headers: { ...headers(), ...(init.headers || {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.message || `github_${response.status}`); return body; };
const readFile = async (name) => { const body = await github(`${apiUrl(name)}?ref=${encodeURIComponent(BRANCH)}`); return { sha: body.sha, source: Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8") }; };
const writeFile = async (name, source, message, sha) => github(apiUrl(name), { method: "PUT", body: JSON.stringify({ message, content: Buffer.from(source, "utf8").toString("base64"), branch: BRANCH, sha }) });
const validSource = (source) => typeof source === "string" && source.length <= 2_000_000 && source.startsWith("<!doctype html>") && source.includes('<main class="slide"') && source.includes('viewBox="0 0 1920 1080"');
const originAllowed = (request) => request.headers.get("origin") === ALLOWED_ORIGIN;
const replaceVisible = (source, from, to) => source.replace(/(<(?:text|tspan)\b[^>]*>)([\s\S]*?)(<\/(?:text|tspan)>)/g, (whole, open, inner, close) => inner.includes(from) ? `${open}${inner.split(from).join(to)}${close}` : whole);

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": ALLOWED_ORIGIN, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store" } });
  if (req.method !== "POST" || !originAllowed(req)) return json(403, { ok: false, error: "origin_not_allowed" });
  if (!process.env.GITHUB_TOKEN) return json(503, { ok: false, error: "cloud_save_not_configured" });
  let payload;
  try { payload = await req.json(); } catch { return json(400, { ok: false, error: "invalid_json" }); }
  try {
    if (payload.operation === "replace") {
      const from = String(payload.from || "");
      const to = String(payload.to || "");
      if (!from) return json(400, { ok: false, error: "empty_from" });
      let count = 0;
      for (const name of ALLOWED) {
        const current = await readFile(name);
        const next = replaceVisible(current.source, from, to);
        if (next === current.source) continue;
        count += (current.source.match(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
        await writeFile(name, next, `図解HTMLを全ページ置換: ${name}`, current.sha);
      }
      return json(200, { ok: true, count });
    }
    const name = String(payload.filename || "");
    const source = String(payload.source || "");
    if (!ALLOWED.has(name) || name.includes("/") || !validSource(source)) return json(400, { ok: false, error: "invalid_html" });
    const current = await readFile(name);
    const result = await writeFile(name, source, `図解HTMLをクラウド保存: ${name}`, current.sha);
    return json(200, { ok: true, filename: name, commit: result.commit?.sha?.slice(0, 7) || "created" });
  } catch (error) {
    return json(409, { ok: false, error: "cloud_save_conflict", detail: String(error.message || error) });
  }
};
