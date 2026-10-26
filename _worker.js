// ちぃちゃんの好きなところ：投稿の保存・読み込み・管理
// 必要な設定: D1データベースを「DB」という名前でつなぐ / シークレット ADMIN_KEY

const MAX_LEN = 60;
const LIST_LIMIT = 500;
const WAIT_SEC = 15;        // 同じ人が続けて投稿できるまでの秒数
const PER_HOUR = 30;        // 同じ人が1時間に投稿できる数
const DEFAULT_NG = ["http", "https", "www.", ".com", ".jp", "死ね", "しね", "殺す", "ころす", "きもい", "キモい", "うざい", "ブス"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function postsGet({ request, env }) {
  const url = new URL(request.url);
  const v = Number(url.searchParams.get("v") ?? -1);
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k='ver'").first();
  const ver = row ? row.v : 0;
  // 変化がなければ中身を送らない（無料枠の節約）
  if (v === ver) return json({ ver, same: true });
  const { results } = await env.DB
    .prepare("SELECT id, text, at FROM posts WHERE hidden=0 ORDER BY id DESC LIMIT ?")
    .bind(LIST_LIMIT)
    .all();
  return json({ ver, posts: results });
}

async function postsPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "送れませんでした。" }, 400); }
  const text = String(body?.text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return json({ error: "好きなところを書いてね。" }, 400);
  if ([...text].length > MAX_LEN) return json({ error: `${MAX_LEN}文字までで書いてね。` }, 400);

  const extra = (env.NG_WORDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const lower = text.toLowerCase();
  if ([...DEFAULT_NG, ...extra].some((w) => lower.includes(w.toLowerCase())))
    return json({ error: "その言葉は投稿できません。" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const iph = await sha(ip + (env.ADMIN_KEY || "salt"));
  const now = Date.now();
  const recent = await env.DB
    .prepare("SELECT SUM(at > ?) AS short, COUNT(*) AS hour FROM posts WHERE iph=? AND at > ?")
    .bind(now - WAIT_SEC * 1000, iph, now - 3600 * 1000)
    .first();
  if (recent && recent.short > 0) return json({ error: "ちょっと待ってからもう一度どうぞ。" }, 429);
  if (recent && recent.hour >= PER_HOUR) return json({ error: "たくさん投稿してくれてありがとう！ 少し時間をあけてね。" }, 429);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO posts (text, at, iph) VALUES (?, ?, ?)").bind(text, now, iph),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='ver'"),
  ]);
  return json({ ok: true });
}

// ---- ちぃちゃんへのメッセージ（管理ページでだけ読める） ----
const LETTER_MAX = 1000;
const LETTER_WAIT_SEC = 60;
const LETTER_PER_HOUR = 5;
let lettersReady = false;
async function ensureLetters(env) {
  if (lettersReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS letters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, message TEXT NOT NULL, at INTEGER NOT NULL, iph TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_letters_iph ON letters (iph, at)"),
  ]);
  lettersReady = true;
}

async function lettersPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "送れませんでした。" }, 400); }
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
  const message = String(body?.message ?? "").replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!message) return json({ error: "メッセージを書いてね。" }, 400);
  if ([...message].length > LETTER_MAX) return json({ error: `${LETTER_MAX}文字までで書いてね。` }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const iph = await sha(ip + (env.ADMIN_KEY || "salt"));
  const now = Date.now();
  await ensureLetters(env);
  const recent = await env.DB
    .prepare("SELECT SUM(at > ?) AS short, COUNT(*) AS hour FROM letters WHERE iph=? AND at > ?")
    .bind(now - LETTER_WAIT_SEC * 1000, iph, now - 3600 * 1000)
    .first();
  if (recent && recent.short > 0) return json({ error: "さっき送ってくれたばかりなので、1分ほど待ってからどうぞ。" }, 429);
  if (recent && recent.hour >= LETTER_PER_HOUR) return json({ error: "たくさん送ってくれてありがとう！ 少し時間をあけてね。" }, 429);

  await env.DB.prepare("INSERT INTO letters (name, message, at, iph) VALUES (?, ?, ?, ?)").bind(name, message, now, iph).run();
  return json({ ok: true });
}

// ===== 生誕企画のリスト =====
// 並び順がそのまま「企画①②③…」の番号になります。
// open: true は最初から公開。false は管理ページで「公開する」を押すまで COMING SOON 表示。
// soon: COMING SOON のときに出す一言（例 "10/27公開予定"）。
// page: このサイト内のページ名（例 "kikaku3" → kikaku3.html）。公開前はそのページも開けません。
const PROJECTS = [
  { id: "map", title: "聖ちぃ巡礼マップ", desc: "ちぃちゃんの足跡をめぐろう🐾", href: "https://seichii-map.pages.dev", external: true, open: true },
  { id: "kikaku2", title: "ちぃちゃんの好きなところ", desc: "ちぃちゃんの好きなところを教えて💘", href: "/kikaku2", page: "kikaku2", open: false, soon: "10/27公開予定" },
];

let projectsReady = false;
async function projectStates(env) {
  if (!projectsReady) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS project_state (id TEXT PRIMARY KEY, open INTEGER NOT NULL)").run();
    projectsReady = true;
  }
  const { results } = await env.DB.prepare("SELECT id, open FROM project_state").all();
  const m = new Map(results.map((r) => [r.id, !!r.open]));
  return PROJECTS.map((p) => ({ ...p, open: m.has(p.id) ? m.get(p.id) : !!p.open }));
}

async function projectsGet({ env }) {
  const list = await projectStates(env);
  return json({
    projects: list.map((p) => p.open
      ? { open: true, title: p.title, desc: p.desc, href: p.href, external: !!p.external }
      : { open: false, soon: p.soon || "" }),
  });
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function adminPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  if (!env.ADMIN_KEY) return json({ error: "管理用の合言葉（ADMIN_KEY）がまだ設定されていません。" }, 500);
  if (!same(String(body?.key ?? ""), env.ADMIN_KEY)) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: "合言葉がちがいます。" }, 401);
  }
  const id = Number(body.id);
  const bump = env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='ver'");
  switch (body.action) {
    case "list": {
      const { results } = await env.DB
        .prepare("SELECT id, text, at, hidden FROM posts ORDER BY id DESC LIMIT 1000").all();
      return json({ posts: results });
    }
    case "hide":
    case "show":
      await env.DB.batch([
        env.DB.prepare("UPDATE posts SET hidden=? WHERE id=?").bind(body.action === "hide" ? 1 : 0, id),
        bump,
      ]);
      return json({ ok: true });
    case "letters": {
      await ensureLetters(env);
      const { results } = await env.DB
        .prepare("SELECT id, name, message, at FROM letters ORDER BY id ASC LIMIT 2000").all();
      return json({ letters: results });
    }
    case "delete_letter":
      await ensureLetters(env);
      await env.DB.prepare("DELETE FROM letters WHERE id=?").bind(id).run();
      return json({ ok: true });
    case "projects": {
      const list = await projectStates(env);
      return json({ projects: list.map((p) => ({ id: p.id, title: p.title, desc: p.desc, open: p.open })) });
    }
    case "set_project": {
      const pid = String(body.pid ?? "");
      if (!PROJECTS.some((p) => p.id === pid)) return json({ error: "その企画は見つかりません。" }, 400);
      await projectStates(env);
      await env.DB.prepare("INSERT INTO project_state (id, open) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET open=excluded.open")
        .bind(pid, body.open ? 1 : 0).run();
      return json({ ok: true });
    }
    case "delete":
      await env.DB.batch([env.DB.prepare("DELETE FROM posts WHERE id=?").bind(id), bump]);
      return json({ ok: true });
    default:
      return json({ error: "unknown action" }, 400);
  }
}

// サイト全体の入口：/api/ は上の処理へ、それ以外はページ（index.html など）を返す
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = { request, env, ctx };
    try {
      if (url.pathname === "/api/posts") {
        if (request.method === "GET") return await postsGet(c);
        if (request.method === "POST") return await postsPost(c);
        return json({ error: "method not allowed" }, 405);
      }
      if (url.pathname === "/api/projects") return await projectsGet(c);
      // 公開前の企画ページはトップに戻す
      const pageName = url.pathname.replace(/^\/+|\.html$|\/+$/g, "");
      if (PROJECTS.some((p) => p.page === pageName)) {
        const list = await projectStates(env);
        const p = list.find((x) => x.page === pageName);
        if (p && !p.open) return Response.redirect(new URL("/", url).toString(), 302);
      }
      if (url.pathname === "/api/letters") {
        if (request.method === "POST") return await lettersPost(c);
        return json({ error: "method not allowed" }, 405);
      }
      if (url.pathname === "/api/admin") {
        if (request.method === "POST") return await adminPost(c);
        return json({ error: "method not allowed" }, 405);
      }
    } catch (e) {
      return json({ error: "サーバーでエラーが起きました。設定（DB のつなぎ方）を確認してください。" }, 500);
    }
    const res = await env.ASSETS.fetch(request);
    // Xなどで画像が出るよう、共有用画像のアドレスを「https://〜/ogp.png」の形に直す
    const type = res.headers.get("content-type") || "";
    if (type.includes("text/html") && typeof HTMLRewriter !== "undefined") {
      const abs = new URL("/ogp.png", url).toString();
      const fix = { element(el) { el.setAttribute("content", abs); } };
      return new HTMLRewriter()
        .on('meta[property="og:image"]', fix)
        .on('meta[name="twitter:image"]', fix)
        .transform(res);
    }
    return res;
  },
};
