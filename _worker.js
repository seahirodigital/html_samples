const REPOSITORY = "seahirodigital/html_samples";
const BRANCH = "main";
const DEFAULT_PROJECT = "biyou-platform";
const PRODUCTION_ORIGIN = "https://htmlviewer-hcy.pages.dev";
const TOC_STATE_FILE = "toc-state.json";

const CORS_HEADERS = {
  "access-control-allow-origin": PRODUCTION_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
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

function safeProject(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

function projectFromRequest(request, payload) {
  const fromPayload = safeProject(payload?.project);
  if (fromPayload) return fromPayload;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const firstPath = new URL(referer).pathname.split("/").filter(Boolean)[0];
      const fromReferer = safeProject(firstPath);
      if (fromReferer) return fromReferer;
    } catch {
      // 不正なRefererは既定プロジェクトへフォールバックする。
    }
  }
  return DEFAULT_PROJECT;
}

function githubUrl(project, filename, ref) {
  const base = `https://api.github.com/repos/${REPOSITORY}/contents/${encodeURIComponent(project)}/${encodeURIComponent(filename)}`;
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
}

async function githubGet(project, filename, token, ref) {
  const response = await fetch(githubUrl(project, filename, ref), {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`GitHub取得失敗: ${response.status}`);
  }
  return response.json();
}

async function githubPut(project, filename, source, sha, token, message) {
  const response = await fetch(githubUrl(project, filename), {
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

async function saveOne(project, filename, source, token) {
  if (typeof filename !== "string" || !/^[^/\\]+\.html$/.test(filename) || filename === "index.html") {
    throw new Error("保存対象外のファイル名です");
  }
  const current = await githubGet(project, filename, token);
  const currentSource = fromBase64(current.content);
  if (currentSource === source) return { filename, changed: false, commit: null };
  const result = await githubPut(project, filename, source, current.sha, token, `図解HTMLを保存: ${project}/${filename}`);
  return { filename, changed: true, commit: result.commit?.sha || null };
}

function validTocOrder(order) {
  return Array.isArray(order)
    && order.length > 1
    && order.length <= 100
    && new Set(order).size === order.length
    && order.every((filename) => typeof filename === "string" && /^[^/\\]+\.html$/.test(filename));
}

async function readTocState(project, token) {
  try {
    const current = await githubGet(project, TOC_STATE_FILE, token);
    const state = JSON.parse(fromBase64(current.content));
    return { current, state: validTocOrder(state?.order) ? state : null };
  } catch {
    return { current: null, state: null };
  }
}

async function saveTocOrder(project, order, token) {
  if (!validTocOrder(order)) throw new Error("目次順が不正です");
  // PCとスマホから近接して更新された場合も、GitHubの最新SHAを読み直して一度再試行する。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { current } = await readTocState(project, token);
    const updatedAt = new Date().toISOString();
    const source = JSON.stringify({ version: 1, order, updatedAt }, null, 2) + "\n";
    try {
      const result = await githubPut(project, TOC_STATE_FILE, source, current?.sha, token, `図解HTMLの目次順を同期: ${project}`);
      return { order, updatedAt, commit: result.commit?.sha || null };
    } catch (error) {
      if (attempt === 0) continue;
      throw error;
    }
  }
  throw new Error("目次順を保存できませんでした");
}

async function listHtml(project, token, ref = BRANCH) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/contents/${encodeURIComponent(project)}?ref=${encodeURIComponent(ref)}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) throw new Error(`GitHub一覧取得失敗: ${response.status}`);
  const items = await response.json();
  return items.filter((item) => item.type === "file" && item.name.endsWith(".html") && item.name !== "index.html");
}

async function githubGit(token, path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub更新失敗: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function replaceAll(project, from, to, token) {
  // 同時編集が起きても、最新コミットから読み直して一度だけ安全に再試行する。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ref = await githubGit(token, `/git/ref/heads/${encodeURIComponent(BRANCH)}`);
    const parentSha = ref.object.sha;
    const items = await listHtml(project, token, parentSha);
    const currentFiles = await Promise.all(items.map(async (item) => ({
      filename: item.name,
      current: await githubGet(project, item.name, token, parentSha),
    })));
    const changes = [];
    let count = 0;
    for (const { filename, current } of currentFiles) {
      const source = fromBase64(current.content);
      const replaced = source.split(from).join(to);
      if (replaced === source) continue;
      count += source.split(from).length - 1;
      changes.push({ path: `${project}/${filename}`, mode: "100644", type: "blob", content: replaced });
    }
    if (!changes.length) return { count: 0, files: 0, commit: null };

    const parent = await githubGit(token, `/git/commits/${encodeURIComponent(parentSha)}`);
    const tree = await githubGit(token, "/git/trees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: changes }),
    });
    const commit = await githubGit(token, "/git/commits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: `図解HTMLを全ページ置換: ${project}/${from}`,
        tree: tree.sha,
        parents: [parentSha],
      }),
    });
    try {
      await githubGit(token, `/git/refs/heads/${encodeURIComponent(BRANCH)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      return { count, files: changes.length, commit: commit.sha };
    } catch (error) {
      if (attempt === 0 && error?.status === 422) continue;
      throw error;
    }
  }
  throw new Error("同時編集が続いているため、全ページ置換を再試行してください");
}

async function serveLatestHtml(url, env) {
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length !== 2) return null;
  const [project, filename] = parts;
  if (!safeProject(project) || !/^[^/\\]+\.html$/.test(filename) || filename === "index.html" || !env.GITHUB_TOKEN) return null;
  try {
    const current = await githubGet(project, filename, env.GITHUB_TOKEN, BRANCH);
    return new Response(fromBase64(current.content), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    // GitHub到達不能時だけ、直近のCloudflare静的配信へ安全に戻す。
    return null;
  }
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
    const project = projectFromRequest(request, payload);
    if (payload.operation === "toc-order") {
      const result = await saveTocOrder(project, payload.order, env.GITHUB_TOKEN);
      return json(env, 200, { ok: true, project, ...result });
    }
    if (payload.operation === "replace") {
      if (typeof payload.from !== "string" || !payload.from) return json(env, 400, { ok: false, error: "検索語が空です" });
      const result = await replaceAll(project, payload.from, typeof payload.to === "string" ? payload.to : "", env.GITHUB_TOKEN);
      return json(env, 200, { ok: true, project, ...result });
    }

    if (typeof payload.filename !== "string" || typeof payload.source !== "string") {
      return json(env, 400, { ok: false, error: "filename/sourceが必要です" });
    }
    const result = await saveOne(project, payload.filename, payload.source, env.GITHUB_TOKEN);
    return json(env, 200, { ok: true, project, ...result });
  } catch (error) {
    return json(env, 500, { ok: false, error: error instanceof Error ? error.message : "保存に失敗しました" });
  }
}

async function handleTocState(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "GET") return json(env, 405, { ok: false, error: "GET only" });
  if (!env.GITHUB_TOKEN) return json(env, 500, { ok: false, error: "GITHUB_TOKEN未設定" });
  const url = new URL(request.url);
  const project = safeProject(url.searchParams.get("project")) || projectFromRequest(request, null);
  const { state } = await readTocState(project, env.GITHUB_TOKEN);
  return json(env, 200, { ok: true, project, order: state?.order || null, updatedAt: state?.updatedAt || null });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/save") return handleSave(request, env);
    if (url.pathname === "/api/toc-state") return handleTocState(request, env);
    if (url.pathname === "/" || url.pathname === "/biyou-platform" || url.pathname === "/biyou-platform/") {
      return Response.redirect(`${PRODUCTION_ORIGIN}/${DEFAULT_PROJECT}/00_%E5%9B%B3%E8%A7%A3%E3%83%8A%E3%83%93%E3%82%B2%E3%83%BC%E3%82%B7%E3%83%A7%E3%83%B3.html`, 302);
    }
    if (/^\/\d{2}_.+\.html$/.test(url.pathname)) {
      return Response.redirect(`${PRODUCTION_ORIGIN}/${DEFAULT_PROJECT}${url.pathname}`, 302);
    }
    const latestHtml = await serveLatestHtml(url, env);
    if (latestHtml) return latestHtml;
    return env.ASSETS.fetch(request);
  },
};
