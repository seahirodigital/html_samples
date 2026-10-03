const REPOSITORY = "seahirodigital/html_samples";
const BRANCH = "main";
const ROOT = "biyou_platform";
const PRODUCTION_ORIGIN = "https://htmlviewer-hcy.pages.dev";

const CORS_HEADERS = {
  "access-control-allow-origin": PRODUCTION_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function json(env, status, body) {
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "beauty-platform-html-viewer",
  };
}

function githubUrl(filename) {
  return `https://api.github.com/repos/${REPOSITORY}/contents/${encodeURIComponent(ROOT)}/${encodeURIComponent(filename)}`;
}

async function githubGet(filename, token) {
  const response = await fetch(githubUrl(filename), {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`GitHub取得失敗: ${response.status}`);
  }
  return response.json();
}

async function githubPut(filename, source, sha, token, message) {
  const response = await fetch(githubUrl(filename), {
    method: "PUT",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      message,
      content: toBase64(source),
      branch: BRANCH,
      sha,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || `GitHub保存失敗: ${response.status}`);
  }
  return body;
}

async function saveOne(filename, source, token) {
  if (!/^\d{2}_.+\.html$/.test(filename) && filename !== "00_図解ナビゲーション.html") {
    throw new Error("保存対象外のファイル名です");
  }
  const current = await githubGet(filename, token);
  const currentSource = fromBase64(current.content);
  if (currentSource === source) return { filename, changed: false, commit: null };
  const result = await githubPut(filename, source, current.sha, token, `図解HTMLを保存: ${filename}`);
  return { filename, changed: true, commit: result.commit?.sha || null };
}

async function listHtml(token) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/contents/${encodeURIComponent(ROOT)}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) throw new Error(`GitHub一覧取得失敗: ${response.status}`);
  const items = await response.json();
  return items.filter((item) => item.type === "file" && item.name.endsWith(".html") && item.name !== "index.html");
}

async function handleSave(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return json(env, 405, { ok: false, error: "POST only" });
  const origin = request.headers.get("origin");
  if (origin !== PRODUCTION_ORIGIN) return json(env, 403, { ok: false, error: "origin denied" });
  if (!env.GITHUB_TOKEN) return json(env, 500, { ok: false, error: "GITHUB_TOKEN未設定" });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(env, 400, { ok: false, error: "JSONが不正です" });
  }

  try {
    if (payload.operation === "replace") {
      if (typeof payload.from !== "string" || !payload.from) return json(env, 400, { ok: false, error: "検索語が空です" });
      const items = await listHtml(env.GITHUB_TOKEN);
      let count = 0;
      const commits = [];
      for (const item of items) {
        const current = await githubGet(item.name, env.GITHUB_TOKEN);
        const source = fromBase64(current.content);
        const replaced = source.split(payload.from).join(typeof payload.to === "string" ? payload.to : "");
        if (replaced !== source) {
          const result = await githubPut(item.name, replaced, current.sha, env.GITHUB_TOKEN, `図解HTMLを全ページ置換: ${payload.from}`);
          count += source.split(payload.from).length - 1;
          commits.push(result.commit?.sha || null);
        }
      }
      return json(env, 200, { ok: true, count, commits });
    }

    if (typeof payload.filename !== "string" || typeof payload.source !== "string") {
      return json(env, 400, { ok: false, error: "filename/sourceが必要です" });
    }
    const result = await saveOne(payload.filename, payload.source, env.GITHUB_TOKEN);
    return json(env, 200, { ok: true, ...result });
  } catch (error) {
    return json(env, 500, { ok: false, error: error instanceof Error ? error.message : "保存に失敗しました" });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/save") return handleSave(request, env);
    return env.ASSETS.fetch(request);
  },
};
