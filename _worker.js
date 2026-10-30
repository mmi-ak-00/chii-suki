// ちぃちゃんの好きなところ：投稿の保存・読み込み・管理
// 必要な設定: D1データベースを「DB」という名前でつなぐ / シークレット ADMIN_KEY

const MAX_LEN = 60;
const LIST_LIMIT = 500;
const WAIT_SEC = 3;         // 連打・自動投稿よけ（同じ人が続けて投稿できるまでの秒数）
const PER_HOUR = 0;         // 1時間あたりの上限（0 = 上限なし）
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
  return json({ ver, posts: results, rules: await cloudRules(env) });
}

// ワードクラウドの手直し設定（管理ページで決める「出さない言葉」「まとめる言葉」）
let settingsReady = false;
async function ensureSettings(env) {
  if (settingsReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)").run();
  settingsReady = true;
}
async function cloudRules(env) {
  await ensureSettings(env);
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k='cloud_rules'").first();
  try { const r = JSON.parse(row?.v || "{}"); return { hide: r.hide || [], merge: r.merge || [] }; } catch { return { hide: [], merge: [] }; }
}
function cleanWord(s) { return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 30); }

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
  if (PER_HOUR > 0 && recent && recent.hour >= PER_HOUR) return json({ error: "たくさん投稿してくれてありがとう！ 少し時間をあけてね。" }, 429);

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

// ===== 企画③ 推しTikTokランキング =====
const TT_ACCOUNT = "chii_nyan02";                 // この人の動画だけ受け付ける
const TT_CATS = { vlog: "Vlog系", dance: "踊ってみた系", close: "寄り動画系" };
// 23歳のちぃちゃんの投稿だけ（日本時間 2025/11/02 0:00 〜 2026/11/01 23:59）
const TT_FROM = Date.UTC(2025, 10, 1, 15, 0, 0);  // 2025-11-02 00:00 JST
const TT_TO = Date.UTC(2026, 10, 1, 15, 0, 0);    // 2026-11-02 00:00 JST（この時刻より前まで）
// TikTokの動画IDには投稿した時刻が入っている（IDを右に32ビットずらすと秒になる）
function ttPostedAt(vid) { try { return Number(BigInt(vid) >> 32n) * 1000; } catch { return 0; } }
const TT_COMMENT_MAX = 60;
const TT_WAIT_SEC = 3;
const TT_HOSTS = /^(www\.|m\.|vt\.|vm\.)?tiktok\.com$/i;
let ttReady = false;
async function ensureTT(env) {
  if (ttReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tiktok (id INTEGER PRIMARY KEY AUTOINCREMENT, cat TEXT NOT NULL, vid TEXT NOT NULL, title TEXT, comment TEXT, at INTEGER NOT NULL, iph TEXT, hidden INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tiktok_cat ON tiktok (cat, vid)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tiktok_iph ON tiktok (iph, at)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tiktok_likes (cat TEXT NOT NULL, vid TEXT NOT NULL, iph TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (cat, vid, iph))"),
    env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('tt_ver', 0)"),
  ]);
  ttReady = true;
}
const ttVideoUrl = (vid) => `https://www.tiktok.com/@${TT_ACCOUNT}/video/${vid}`;

// TikTok公式の動画情報（oEmbed）を取る。ブラウザと同じような名乗りで頼む
const TT_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
async function ttOembed(vid) {
  const r = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(ttVideoUrl(vid)), {
    headers: { "User-Agent": TT_UA, "Accept": "application/json", "Accept-Language": "ja,en;q=0.8" },
  });
  let info = null, text = "";
  try { text = await r.text(); info = JSON.parse(text); } catch { info = null; }
  return { status: r.status, ok: r.ok, info, text: text.slice(0, 300) };
}

// 貼られたURLから動画IDを取り出し、ちぃちゃん本人の動画か確かめる
async function ttResolve(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { error: "TikTokのURLを貼ってね。" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "TikTokのURLを貼ってね。" };
  if (!TT_HOSTS.test(u.hostname)) return { error: "TikTokのURLを貼ってね。" };
  let final = u;
  // 短いURL（vt.tiktok.com など）は飛び先をたどる
  if (!/\/(?:video|v)\/\d+/.test(u.pathname)) {
    try {
      let cur = u.toString();
      for (let i = 0; i < 5; i++) {
        const r = await fetch(cur, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } });
        const loc = r.headers.get("Location");
        if (!loc) break;
        const next = new URL(loc, cur);
        if (!TT_HOSTS.test(next.hostname)) break;
        cur = next.toString();
        if (/\/(?:video|v)\/\d+/.test(next.pathname)) break;
      }
      final = new URL(cur);
    } catch { return { error: "URLを確認できませんでした。もう一度試してみてね。" }; }
  }
  const vm = final.pathname.match(/\/(?:video|v)\/(\d{8,25})/);
  if (!vm) return { error: "動画のURLを貼ってね（TikTokの「シェア」→「リンクをコピー」）。" };
  const vid = vm[1];
  const posted = ttPostedAt(vid);
  if (!(posted >= TT_FROM && posted < TT_TO)) return { error: "23歳のちぃちゃんの動画（2025.11.02〜2026.11.01に投稿されたもの）だけ送れます。" };
  const um = final.pathname.match(/\/@([\w.]+)/);
  if (um && um[1].toLowerCase() !== TT_ACCOUNT) return { error: `@${TT_ACCOUNT} の動画だけ投稿できます。` };
  // TikTok公式の情報（oEmbed）で、動画があること・投稿者を確かめる
  // TikTok公式の情報（oEmbed）で確かめる。ただしTikTokに「問い合わせが多すぎる」と断られたときは、
  // URLに @chii_nyan02 が入っていればそれで本人の動画とみなす（キャプションと画像は見る人のスマホが取りに行く）
  const urlSaysChii = !!um && um[1].toLowerCase() === TT_ACCOUNT;
  let o = null;
  try { o = await ttOembed(vid); } catch { o = null; }
  if (o && o.status === 404) return { error: "動画が見つかりませんでした。URLを確認してね。" };
  if (o && o.ok && o.info) {
    const info = o.info;
    const author = String(info.author_unique_id || "").toLowerCase()
      || String(info.author_url || "").split("@")[1]?.toLowerCase() || "";
    if (author && author !== TT_ACCOUNT) return { error: `@${TT_ACCOUNT} の動画だけ投稿できます。` };
    if (!author && !urlSaysChii) return { error: `@${TT_ACCOUNT} の動画か確認できませんでした。TikTokの「リンクをコピー」で出たURLをそのまま貼ってね。` };
    return { vid, title: String(info.title || "").slice(0, 200) };
  }
  if (urlSaysChii) return { vid, title: "" };
  return { error: "いまTikTokで動画を確認できませんでした。少し待ってからもう一度どうぞ。" };
}

// 推しTikTokで「同じ人」を見分ける印。回線（IPアドレス）はスマホだと変わりやすいので、
// ブラウザに1年間残る印（クッキー）で見分ける
async function ttWho(request, env) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)chii_uid=([0-9a-f]{32})/);
  const uid = m ? m[1] : [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { key: "u:" + (await sha(uid + (env.ADMIN_KEY || "salt"))).slice(0, 40), uid, isNew: !m };
}
function withUidCookie(res, who) {
  if (!who || !who.isNew || who.sent) return res;
  who.sent = true;
  const r = new Response(res.body, res);
  r.headers.append("Set-Cookie", `chii_uid=${who.uid}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; Secure; SameSite=Lax`);
  return r;
}

async function ttPost({ request, env, who }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "送れませんでした。" }, 400); }
  const cat = String(body?.cat ?? "");
  if (!TT_CATS[cat]) return json({ error: "お題を選んでね。" }, 400);
  const comment = String(body?.comment ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if ([...comment].length > TT_COMMENT_MAX) return json({ error: `ひとことは${TT_COMMENT_MAX}文字までで書いてね。` }, 400);
  if (comment) {
    const extra = (env.NG_WORDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const lower = comment.toLowerCase();
    if ([...DEFAULT_NG, ...extra].some((w) => lower.includes(w.toLowerCase()))) return json({ error: "その言葉は投稿できません。" }, 400);
  }
  const iph = who.key;
  const now = Date.now();
  await ensureTT(env);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM tiktok WHERE iph=? AND at > ?").bind(iph, now - TT_WAIT_SEC * 1000).first();
  if (recent && recent.n > 0) return json({ error: "ちょっと待ってからもう一度どうぞ。" }, 429);

  const v = await ttResolve(body?.url);
  if (v.error) return json({ error: v.error }, 400);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tiktok (cat, vid, title, comment, at, iph) VALUES (?, ?, ?, ?, ?, ?)").bind(cat, v.vid, v.title, comment, now, iph),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='tt_ver'"),
  ]);
  return json({ ok: true, vid: v.vid });
}

async function ttGet({ request, env, who }) {
  const url = new URL(request.url);
  await ensureTT(env);
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k='tt_ver'").first();
  const ver = row ? row.v : 0;
  if (Number(url.searchParams.get("v") ?? -1) === ver) return json({ ver, same: true });
  const me = who.key;
  const out = {};
  for (const cat of Object.keys(TT_CATS)) {
    const { results: vids } = await env.DB.prepare(
      "SELECT vid, MAX(title) AS title, MAX(at) AS last, COUNT(DISTINCT iph) AS pushers FROM tiktok WHERE cat=? AND hidden=0 GROUP BY vid"
    ).bind(cat).all();
    // 推し数 =「動画を送った人」と「いいねした人」を合わせた人数（同じ人は1人と数える）
    const { results: score } = await env.DB.prepare(
      "SELECT vid, COUNT(*) AS n FROM (SELECT vid, iph FROM tiktok WHERE cat=? AND hidden=0 UNION SELECT vid, iph FROM tiktok_likes WHERE cat=?) GROUP BY vid"
    ).bind(cat, cat).all();
    const { results: likes } = await env.DB.prepare(
      "SELECT vid, COUNT(*) AS n, MAX(iph=?) AS mine FROM tiktok_likes WHERE cat=? GROUP BY vid"
    ).bind(me, cat).all();
    const { results: cm } = await env.DB.prepare(
      "SELECT vid, comment, at FROM tiktok WHERE cat=? AND hidden=0 AND comment<>'' ORDER BY id DESC LIMIT 600"
    ).bind(cat).all();
    const sc = new Map(score.map((r) => [r.vid, r.n]));
    const lk = new Map(likes.map((r) => [r.vid, r]));
    const by = new Map();
    for (const c of cm) { if (!by.has(c.vid)) by.set(c.vid, []); by.get(c.vid).push({ text: c.comment, at: c.at }); }
    out[cat] = vids
      .map((r) => ({
        vid: r.vid, title: r.title || "", n: sc.get(r.vid) || r.pushers,
        likes: lk.get(r.vid)?.n || 0, liked: !!lk.get(r.vid)?.mine, last: r.last,
        comments: (by.get(r.vid) || []).slice(0, 20),
      }))
      .sort((a, b) => b.n - a.n || b.last - a.last)
      .slice(0, 30)
      .map(({ last, ...x }) => x);
  }
  return json({ ver, account: TT_ACCOUNT, cats: TT_CATS, ranking: out });
}

// いいね（押すと推しに1票。もう一度押すと取り消し）
async function ttLike({ request, env, who }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "送れませんでした。" }, 400); }
  const cat = String(body?.cat ?? ""), vid = String(body?.vid ?? "").replace(/\D/g, "");
  if (!TT_CATS[cat] || !vid) return json({ error: "いいねできませんでした。" }, 400);
  await ensureTT(env);
  const exists = await env.DB.prepare("SELECT 1 AS x FROM tiktok WHERE cat=? AND vid=? AND hidden=0 LIMIT 1").bind(cat, vid).first();
  if (!exists) return json({ error: "この動画はランキングにありません。" }, 404);
  const iph = who.key;
  const on = !!body?.on;
  await env.DB.batch([
    on
      ? env.DB.prepare("INSERT OR IGNORE INTO tiktok_likes (cat, vid, iph, at) VALUES (?, ?, ?, ?)").bind(cat, vid, iph, Date.now())
      : env.DB.prepare("DELETE FROM tiktok_likes WHERE cat=? AND vid=? AND iph=?").bind(cat, vid, iph),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='tt_ver'"),
  ]);
  return json({ ok: true, on });
}

// ランキングの動画にひとことを書き足す（書き足した人も「推した人」に数える）
async function ttComment({ request, env, who }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "送れませんでした。" }, 400); }
  const cat = String(body?.cat ?? ""), vid = String(body?.vid ?? "").replace(/\D/g, "");
  if (!TT_CATS[cat] || !vid) return json({ error: "送れませんでした。" }, 400);
  const comment = String(body?.comment ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!comment) return json({ error: "ひとことを書いてね。" }, 400);
  if ([...comment].length > TT_COMMENT_MAX) return json({ error: `ひとことは${TT_COMMENT_MAX}文字までで書いてね。` }, 400);
  const extra = (env.NG_WORDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const lower = comment.toLowerCase();
  if ([...DEFAULT_NG, ...extra].some((w) => lower.includes(w.toLowerCase()))) return json({ error: "その言葉は投稿できません。" }, 400);
  await ensureTT(env);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(title) AS title FROM tiktok WHERE cat=? AND vid=? AND hidden=0").bind(cat, vid).first();
  if (!row || !row.n) return json({ error: "この動画はランキングにありません。" }, 404);
  const iph = who.key;
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM tiktok WHERE iph=? AND at > ?").bind(iph, now - TT_WAIT_SEC * 1000).first();
  if (recent && recent.n > 0) return json({ error: "ちょっと待ってからもう一度どうぞ。" }, 429);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tiktok (cat, vid, title, comment, at, iph) VALUES (?, ?, ?, ?, ?, ?)").bind(cat, vid, row.title || "", comment, now, iph),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='tt_ver'"),
  ]);
  return json({ ok: true });
}

// サムネイル（TikTokの画像アドレスは時間がたつと使えなくなるので、そのつど取り直して6時間ためておく）
// うまく中継できないときは、画像のアドレスへ直接案内する（見る人のブラウザが読み込む）
async function ttThumb({ request, env, ctx }) {
  const url = new URL(request.url);
  const vid = (url.searchParams.get("vid") || "").replace(/\D/g, "");
  if (!vid) return new Response("", { status: 404 });
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL("/api/tiktok/thumb?vid=" + vid, url).toString());
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  try {
    const o = await ttOembed(vid);
    const thumb = o.info?.thumbnail_url;
    if (!thumb) return new Response("", { status: 404, headers: { "cache-control": "no-store" } });
    // ついでに、空だったキャプションを埋めておく
    if (o.info?.title) {
      try {
        await ensureTT(env);
        const u = await env.DB.prepare("UPDATE tiktok SET title=? WHERE vid=? AND (title IS NULL OR title='')").bind(String(o.info.title).slice(0, 200), vid).run();
        if ((u?.meta?.changes ?? u?.changes ?? 0) > 0) await env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='tt_ver'").run();
      } catch {}
    }
    try {
      const img = await fetch(thumb, { headers: { "User-Agent": TT_UA, "Referer": "https://www.tiktok.com/", "Accept": "image/avif,image/webp,image/*,*/*" } });
      const type = img.headers.get("content-type") || "";
      if (img.ok && type.startsWith("image/")) {
        const res = new Response(img.body, { headers: { "content-type": type, "cache-control": "public, max-age=21600" } });
        if (cache) ctx?.waitUntil?.(cache.put(key, res.clone()));
        return res;
      }
    } catch {}
    return new Response("", { status: 302, headers: { "Location": thumb, "cache-control": "no-store" } });
  } catch { return new Response("", { status: 404, headers: { "cache-control": "no-store" } }); }
}

// 管理ページ用：サムネイルが出ない原因を調べる
async function ttDiagnose(env, vid) {
  const out = { vid };
  try {
    const o = await ttOembed(vid);
    out.oembed_status = o.status;
    out.has_title = !!o.info?.title;
    out.has_thumbnail = !!o.info?.thumbnail_url;
    out.author = o.info?.author_unique_id || o.info?.author_name || "";
    if (!o.info) out.oembed_body = o.text;
    if (o.info?.title) {
      const u = await env.DB.prepare("UPDATE tiktok SET title=? WHERE vid=? AND (title IS NULL OR title='')").bind(String(o.info.title).slice(0, 200), vid).run();
      if ((u?.meta?.changes ?? u?.changes ?? 0) > 0) { await env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='tt_ver'").run(); out.title_fixed = true; }
    }
    if (o.info?.thumbnail_url) {
      out.thumbnail_host = new URL(o.info.thumbnail_url).host;
      try {
        const img = await fetch(o.info.thumbnail_url, { headers: { "User-Agent": TT_UA, "Referer": "https://www.tiktok.com/" } });
        out.image_status = img.status;
        out.image_type = img.headers.get("content-type") || "";
      } catch (e) { out.image_error = String(e).slice(0, 120); }
    }
  } catch (e) { out.error = String(e).slice(0, 120); }
  return out;
}

// ===== 企画④ 23歳のちぃ記録（写真の年表） =====
// 写真はD1データベースに文字（base64）で保存します。一覧用の小さい写真と、タップで開く大きい写真の2つ。
const PH_FROM = "2025-11-02", PH_TO = "2026-11-01";   // 23歳の期間
const PH_COMMENT_MAX = 60;
const PH_FULL_MAX = 1_300_000;   // 大きい写真の上限（バイト）
const PH_THUMB_MAX = 160_000;    // 小さい写真の上限（バイト）
const PH_LIMIT = 400;            // 保存できる写真の数（無料枠の容量に収めるため）
const PH_WAIT_SEC = 20;          // 同じ人が続けて投稿できるまでの秒数
const PH_PER_HOUR = 15;          // 同じ人が1時間に投稿できる数
let phReady = false;
async function ensurePH(env) {
  if (phReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, d TEXT NOT NULL, day_known INTEGER NOT NULL, comment TEXT, at INTEGER NOT NULL, iph TEXT, status TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS photo_blobs (id INTEGER PRIMARY KEY, thumb TEXT NOT NULL, thumb_type TEXT NOT NULL, full TEXT NOT NULL, full_type TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_photos_iph ON photos (iph, at)"),
    env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('ph_ver', 0)"),
  ]);
  phReady = true;
}
async function phApproval(env) {
  await ensureSettings(env);
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k='photo_approval'").first();
  return row ? row.v === "on" : false;   // 最初は「承認なしですぐ載る」（管理ページでオンにすると承認制）
}
function b64Bytes(b64) { try { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } catch { return null; } }
function imgType(u) {
  if (!u || u.length < 12) return "";
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "image/png";
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return "image/webp";
  return "";
}
function phDate(month, day) {
  // month: "2026-03" / day: "" or "15"
  const m = String(month || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  const dd = String(day || "").trim();
  if (!dd) {
    const ym = `${m[1]}-${m[2]}`;
    if (ym < PH_FROM.slice(0, 7) || ym > PH_TO.slice(0, 7)) return null;
    return { d: ym, known: 0 };
  }
  const n = +dd;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (!Number.isInteger(n) || n < 1 || n > last) return null;
  const iso = `${m[1]}-${m[2]}-${String(n).padStart(2, "0")}`;
  if (iso < PH_FROM || iso > PH_TO) return null;
  return { d: iso, known: 1 };
}

async function phPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "送れませんでした。写真が大きすぎるかもしれません。" }, 400); }
  const date = phDate(body?.month, body?.day);
  if (!date) return json({ error: "日付は 2025.11.02〜2026.11.01 の間で選んでね。" }, 400);
  const comment = String(body?.comment ?? "").replace(/\s+/g, " ").trim();
  if ([...comment].length > PH_COMMENT_MAX) return json({ error: `ひとことは${PH_COMMENT_MAX}文字までで書いてね。` }, 400);
  if (comment) {
    const extra = (env.NG_WORDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const lower = comment.toLowerCase();
    if ([...DEFAULT_NG, ...extra].some((w) => lower.includes(w.toLowerCase()))) return json({ error: "その言葉は投稿できません。" }, 400);
  }
  const full = b64Bytes(String(body?.full ?? "")), thumb = b64Bytes(String(body?.thumb ?? ""));
  const ft = imgType(full), tt = imgType(thumb);
  if (!ft || !tt) return json({ error: "写真を読み込めませんでした。別の写真で試してみてね。" }, 400);
  if (full.length > PH_FULL_MAX || thumb.length > PH_THUMB_MAX) return json({ error: "写真が大きすぎます。" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const iph = await sha(ip + (env.ADMIN_KEY || "salt"));
  const now = Date.now();
  await ensurePH(env);
  const recent = await env.DB.prepare("SELECT SUM(at > ?) AS short, COUNT(*) AS hour FROM photos WHERE iph=? AND at > ?")
    .bind(now - PH_WAIT_SEC * 1000, iph, now - 3600 * 1000).first();
  if (recent && recent.short > 0) return json({ error: "ちょっと待ってからもう一度どうぞ。" }, 429);
  if (recent && recent.hour >= PH_PER_HOUR) return json({ error: "たくさん送ってくれてありがとう！ 少し時間をあけてね。" }, 429);
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos").first();
  if (total && total.n >= PH_LIMIT) return json({ error: "写真がいっぱいになりました。たくさんありがとう！" }, 400);

  const status = (await phApproval(env)) ? "pending" : "shown";
  const ins = await env.DB.prepare("INSERT INTO photos (d, day_known, comment, at, iph, status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(date.d, date.known, comment, now, iph, status).first();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO photo_blobs (id, thumb, thumb_type, full, full_type) VALUES (?, ?, ?, ?, ?)")
      .bind(ins.id, String(body.thumb), tt, String(body.full), ft),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='ph_ver'"),
  ]);
  return json({ ok: true, status });
}


async function phList({ request, env }) {
  const url = new URL(request.url);
  await ensurePH(env);
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k='ph_ver'").first();
  const ver = row ? row.v : 0;
  if (Number(url.searchParams.get("v") ?? -1) === ver) return json({ ver, same: true });
  const { results } = await env.DB.prepare("SELECT id, d, day_known, comment FROM photos WHERE status='shown' ORDER BY d ASC, id ASC LIMIT 1000").all();
  return json({ ver, from: PH_FROM, to: PH_TO, approval: await phApproval(env), photos: results.map((r) => ({ id: r.id, d: r.d, dayKnown: !!r.day_known, comment: r.comment || "" })) });
}

async function phImage({ request, env }) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  const size = url.searchParams.get("s") === "full" ? "full" : "thumb";
  if (!id) return new Response("", { status: 404 });
  await ensurePH(env);
  const meta = await env.DB.prepare("SELECT status FROM photos WHERE id=?").bind(id).first();
  if (!meta) return new Response("", { status: 404 });
  const shown = meta.status === "shown";
  if (!shown && !(await isPreviewer(request, env))) return new Response("", { status: 404 });
  const b = await env.DB.prepare(`SELECT ${size} AS data, ${size}_type AS type FROM photo_blobs WHERE id=?`).bind(id).first();
  const bytes = b && b64Bytes(b.data);
  if (!bytes) return new Response("", { status: 404 });
  return new Response(bytes, { headers: { "content-type": b.type, "cache-control": shown ? "public, max-age=86400" : "private, no-store" } });
}

// ===== 企画⑥ わたしの選ぶちぃの好き顔（候補の写真から3つえらんで投票） =====
const KAO_PICK = 3;           // 1人がえらぶ数
const KAO_MAX = 60;           // 候補の写真の上限
let kaoReady = false;
async function ensureKao(env) {
  if (kaoReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kao_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, caption TEXT, at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, thumb TEXT NOT NULL, thumb_type TEXT NOT NULL, full TEXT NOT NULL, full_type TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kao_votes (who TEXT NOT NULL, photo_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (who, photo_id))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_kao_votes_photo ON kao_votes (photo_id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)"),
    env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('kao_ver', 0)"),
  ]);
  // 並び順の列（あとから足したので、まだ無いときだけ足す）
  try { await env.DB.prepare("ALTER TABLE kao_photos ADD COLUMN sort INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { /* もうある */ }
  kaoReady = true;
}
async function kaoMine(env, who) {
  const { results } = await env.DB.prepare("SELECT v.photo_id AS id FROM kao_votes v JOIN kao_photos p ON p.id=v.photo_id WHERE v.who=? AND p.hidden=0 ORDER BY v.at, v.photo_id").bind(who.key).all();
  return results.map((r) => r.id);
}
// 候補の一覧（票の数は出さない）
async function kaoGet({ env, who }) {
  await ensureKao(env);
  const { results } = await env.DB.prepare("SELECT id, caption FROM kao_photos WHERE hidden=0 ORDER BY sort, id").all();
  return json({ pick: KAO_PICK, photos: results.map((r) => ({ id: r.id, caption: r.caption || "" })), mine: await kaoMine(env, who) });
}
// 投票（3つ。選び直すと前の票と入れ替わる）
async function kaoVote({ request, env, who }) {
  let body; try { body = await request.json(); } catch { return json({ error: "送れませんでした。" }, 400); }
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length !== KAO_PICK) return json({ error: `${KAO_PICK}つえらんでね。` }, 400);
  await ensureKao(env);
  const ph = ids.map(() => "?").join(",");
  const ok = await env.DB.prepare(`SELECT COUNT(*) AS n FROM kao_photos WHERE hidden=0 AND id IN (${ph})`).bind(...ids).first();
  if (!ok || ok.n !== KAO_PICK) return json({ error: "えらんだ写真が見つかりませんでした。ページを読み直してね。" }, 400);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kao_votes WHERE who=?").bind(who.key),
    ...ids.map((id, i) => env.DB.prepare("INSERT INTO kao_votes (who, photo_id, at) VALUES (?, ?, ?)").bind(who.key, id, now + i)),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='kao_ver'"),
  ]);
  return json({ ok: true, mine: ids });
}
// 結果（投票した人と管理者だけ）
async function kaoResult({ request, env, who }) {
  await ensureKao(env);
  const mine = await kaoMine(env, who);
  if (!mine.length && !(await isPreviewer(request, env))) return json({ needVote: true, error: "投票すると結果が見られます。" }, 403);
  const url = new URL(request.url);
  const ver = (await env.DB.prepare("SELECT v FROM meta WHERE k='kao_ver'").first())?.v ?? 0;
  if (url.searchParams.get("v") === String(ver)) return json({ same: true });
  const { results } = await env.DB.prepare("SELECT p.id, p.caption, (SELECT COUNT(*) FROM kao_votes v WHERE v.photo_id=p.id) AS n FROM kao_photos p WHERE p.hidden=0 ORDER BY n DESC, p.sort, p.id").all();
  const voters = await env.DB.prepare("SELECT COUNT(DISTINCT v.who) AS n FROM kao_votes v JOIN kao_photos p ON p.id=v.photo_id WHERE p.hidden=0").first();
  return json({ ver, voters: voters?.n || 0, mine, photos: results.map((r) => ({ id: r.id, caption: r.caption || "", n: r.n })) });
}
async function kaoImage({ request, env }) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  const size = url.searchParams.get("s") === "full" ? "full" : "thumb";
  if (!id) return new Response("", { status: 404 });
  await ensureKao(env);
  const b = await env.DB.prepare(`SELECT hidden, ${size} AS data, ${size}_type AS type FROM kao_photos WHERE id=?`).bind(id).first();
  if (!b || (b.hidden && !(await isPreviewer(request, env)))) return new Response("", { status: 404 });
  const bytes = b64Bytes(b.data);
  if (!bytes) return new Response("", { status: 404 });
  return new Response(bytes, { headers: { "content-type": b.type, "cache-control": b.hidden ? "private, no-store" : "public, max-age=86400" } });
}

// ===== 企画⑤ ちぃちゃんの好きパフォーマンス（「わかる！」カード） =====
const WK_MAX = 40;          // カード1枚の文字数
const WK_WAIT_SEC = 10;     // 同じ人がカードを続けて出せるまでの秒数
const WK_PER_HOUR = 20;     // 同じ人が1時間に出せるカードの数
// 動画（スマホの中で10秒・小さくしてから届く）
const WK_VIDEO_MAX = 3_000_000;        // 1本の大きさの上限（バイト）
const WK_VIDEO_TOTAL = 150_000_000;    // 動画全部の大きさの上限（データベースの容量に収めるため）
const WK_VIDEO_PER_HOUR = 5;           // 同じ人が1時間に送れる動画の数
const WK_CHUNK = 900_000;              // データベースに分けて入れる1かけらの大きさ
function toBytes(x) {
  if (!x) return null;
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (Array.isArray(x)) return Uint8Array.from(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return null;
}
function videoType(u) {
  if (!u || u.length < 12) return "";
  if (u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) return "video/mp4";      // ....ftyp
  if (u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3) return "video/webm";      // EBML
  return "";
}
let wkReady = false;
async function ensureWK(env) {
  if (wkReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wk_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at INTEGER NOT NULL, iph TEXT, hidden INTEGER NOT NULL DEFAULT 0, seed INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wk_votes (card_id INTEGER NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (card_id, who))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_wk_iph ON wk_cards (iph, at)"),
    env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('wk_ver', 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wk_media (card_id INTEGER PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, dur REAL, thumb BLOB, thumb_type TEXT, chunks INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wk_chunks (card_id INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (card_id, idx))"),
  ]);
  wkReady = true;
}
function wkNG(env, text) {
  const extra = (env.NG_WORDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const lower = text.toLowerCase();
  return [...DEFAULT_NG, ...extra].some((w) => lower.includes(w.toLowerCase()));
}
async function wkGet({ request, env, who }) {
  const url = new URL(request.url);
  await ensureWK(env);
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k='wk_ver'").first();
  const ver = row ? row.v : 0;
  if (Number(url.searchParams.get("v") ?? -1) === ver) return json({ ver, same: true });
  const { results } = await env.DB.prepare(
    "SELECT c.id, c.text, c.at, (SELECT COUNT(*) FROM wk_votes v WHERE v.card_id=c.id) AS n, EXISTS(SELECT 1 FROM wk_votes v WHERE v.card_id=c.id AND v.who=?) AS mine, (c.iph=?) AS own, m.dur AS dur, (m.card_id IS NOT NULL) AS video FROM wk_cards c LEFT JOIN wk_media m ON m.card_id=c.id WHERE c.hidden=0 ORDER BY c.id DESC LIMIT 600"
  ).bind(who.key, who.key).all();
  return json({ ver, cards: results.map((r) => ({ id: r.id, text: r.text, at: r.at, n: r.n, mine: !!r.mine, own: !!r.own, video: !!r.video, dur: r.dur || 0 })) });
}
async function wkAdd({ request, env, who }) {
  let text = "", video = null, thumb = null, dur = 0;
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("multipart/form-data")) {
      const f = await request.formData();
      text = String(f.get("text") ?? "");
      const vf = f.get("video"), tf = f.get("thumb");
      if (vf && typeof vf !== "string") video = new Uint8Array(await vf.arrayBuffer());
      if (tf && typeof tf !== "string") thumb = new Uint8Array(await tf.arrayBuffer());
      dur = Number(f.get("dur")) || 0;
    } else {
      const body = await request.json();
      text = String(body?.text ?? "");
    }
  } catch { return json({ error: "送れませんでした。動画が大きすぎるかもしれません。" }, 400); }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return json({ error: "好きポイントを書いてね。" }, 400);
  if ([...text].length > WK_MAX) return json({ error: `${WK_MAX}文字までで書いてね。` }, 400);
  if (wkNG(env, text)) return json({ error: "その言葉は投稿できません。" }, 400);
  let vtype = "", ttype = "";
  if (video) {
    vtype = videoType(video);
    if (!vtype) return json({ error: "この動画は読み込めませんでした。別の動画で試してみてね。" }, 400);
    if (video.length > WK_VIDEO_MAX) return json({ error: "動画が大きすぎます。もう少し短くしてみてね。" }, 400);
    if (thumb) { ttype = imgType(thumb); if (!ttype || thumb.length > 200_000) thumb = null; }
  }
  await ensureWK(env);
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT SUM(at > ?) AS short, COUNT(*) AS hour FROM wk_cards WHERE iph=? AND at > ?")
    .bind(now - WK_WAIT_SEC * 1000, who.key, now - 3600 * 1000).first();
  if (recent && recent.short > 0) return json({ error: "ちょっと待ってからもう一度どうぞ。" }, 429);
  if (recent && recent.hour >= WK_PER_HOUR) return json({ error: "たくさんありがとう！ 少し時間をあけてね。" }, 429);
  if (video) {
    const vh = await env.DB.prepare("SELECT COUNT(*) AS n FROM wk_cards c JOIN wk_media m ON m.card_id=c.id WHERE c.iph=? AND c.at > ?").bind(who.key, now - 3600 * 1000).first();
    if (vh && vh.n >= WK_VIDEO_PER_HOUR) return json({ error: "動画はたくさん送れないので、少し時間をあけてね。" }, 429);
    const tot = await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS s FROM wk_media").first();
    if (tot && tot.s + video.length > WK_VIDEO_TOTAL) return json({ error: "動画がいっぱいになりました。文字だけのカードなら出せます。" }, 400);
  }
  // 動画なしで、同じ文のカードがもうあれば、新しく作らずに「わかる！」を押したことにする
  if (!video) {
    const same = await env.DB.prepare("SELECT id FROM wk_cards WHERE hidden=0 AND text=? LIMIT 1").bind(text).first();
    if (same) {
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO wk_votes (card_id, who, at) VALUES (?, ?, ?)").bind(same.id, who.key, now),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='wk_ver'"),
      ]);
      return json({ ok: true, id: same.id, merged: true });
    }
  }
  const ins = await env.DB.prepare("INSERT INTO wk_cards (text, at, iph) VALUES (?, ?, ?) RETURNING id").bind(text, now, who.key).first();
  const ops = [];
  if (video) {
    const n = Math.ceil(video.length / WK_CHUNK);
    for (let i = 0; i < n; i++) {
      ops.push(env.DB.prepare("INSERT INTO wk_chunks (card_id, idx, data) VALUES (?, ?, ?)").bind(ins.id, i, video.slice(i * WK_CHUNK, (i + 1) * WK_CHUNK)));
    }
    ops.push(env.DB.prepare("INSERT INTO wk_media (card_id, type, size, dur, thumb, thumb_type, chunks) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(ins.id, vtype, video.length, Math.min(12, Math.max(0, dur)), thumb, ttype || null, n));
  }
  // 自分で出したカードには、自分の「わかる！」を1つ付けておく
  ops.push(env.DB.prepare("INSERT OR IGNORE INTO wk_votes (card_id, who, at) VALUES (?, ?, ?)").bind(ins.id, who.key, now));
  ops.push(env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='wk_ver'"));
  try { await env.DB.batch(ops); }
  catch (e) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM wk_cards WHERE id=?").bind(ins.id),
      env.DB.prepare("DELETE FROM wk_chunks WHERE card_id=?").bind(ins.id),
      env.DB.prepare("DELETE FROM wk_media WHERE card_id=?").bind(ins.id),
    ]);
    return json({ error: "保存できませんでした。もう一度試してみてね。" }, 500);
  }
  return json({ ok: true, id: ins.id });
}

// 動画を返す（iPhoneは少しずつ読み込むので、部分読み込み（Range）に対応する）
async function wkVideo({ request, env }) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!id) return new Response("", { status: 404 });
  await ensureWK(env);
  const card = await env.DB.prepare("SELECT c.hidden, m.type, m.size, m.thumb, m.thumb_type FROM wk_cards c JOIN wk_media m ON m.card_id=c.id WHERE c.id=?").bind(id).first();
  if (!card) return new Response("", { status: 404 });
  const admin = await isPreviewer(request, env);
  if (card.hidden && !admin) return new Response("", { status: 404 });
  const cache = card.hidden ? "private, no-store" : "public, max-age=86400";
  if (url.searchParams.get("s") === "thumb") {
    const t = toBytes(card.thumb);
    if (!t) return new Response("", { status: 404 });
    return new Response(t, { headers: { "content-type": card.thumb_type || "image/jpeg", "cache-control": cache } });
  }
  const { results } = await env.DB.prepare("SELECT data FROM wk_chunks WHERE card_id=? ORDER BY idx").bind(id).all();
  const parts = results.map((r) => toBytes(r.data)).filter(Boolean);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const base = { "content-type": card.type, "accept-ranges": "bytes", "cache-control": cache };
  const m = (request.headers.get("Range") || "").match(/bytes=(\d*)-(\d*)/);
  if (m && total) {
    let s = m[1] === "" ? Math.max(0, total - Number(m[2] || 0)) : Number(m[1]);
    let e = m[1] !== "" && m[2] !== "" ? Number(m[2]) : total - 1;
    if (m[1] === "" ) e = total - 1;
    if (s >= total || s > e) return new Response("", { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
    e = Math.min(e, total - 1);
    return new Response(all.slice(s, e + 1), { status: 206, headers: { ...base, "content-range": `bytes ${s}-${e}/${total}`, "content-length": String(e - s + 1) } });
  }
  return new Response(all, { headers: { ...base, "content-length": String(total) } });
}

async function wkVote({ request, env, who }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "送れませんでした。" }, 400); }
  const id = Number(body?.id);
  if (!id) return json({ error: "送れませんでした。" }, 400);
  await ensureWK(env);
  const card = await env.DB.prepare("SELECT 1 AS x FROM wk_cards WHERE id=? AND hidden=0").bind(id).first();
  if (!card) return json({ error: "このカードは見つかりません。" }, 404);
  const on = !!body?.on;
  await env.DB.batch([
    on
      ? env.DB.prepare("INSERT OR IGNORE INTO wk_votes (card_id, who, at) VALUES (?, ?, ?)").bind(id, who.key, Date.now())
      : env.DB.prepare("DELETE FROM wk_votes WHERE card_id=? AND who=?").bind(id, who.key),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='wk_ver'"),
  ]);
  return json({ ok: true, on });
}

// ===== 投稿禁止 =====
// 「同じ人」の印は2つ：回線（IPアドレス）から作る印と、ブラウザに残す印（クッキー）。
// 投稿のたびに2つの組み合わせを覚えておき、禁止するときは、つながっている印をまとめて禁止する。
let banReady = false;
async function ensureBan(env) {
  if (banReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS bans (k TEXT PRIMARY KEY, at INTEGER NOT NULL, note TEXT, grp TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS seen (ip TEXT NOT NULL, ck TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (ip, ck))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_seen_ck ON seen (ck)"),
  ]);
  banReady = true;
}
async function ipKeyOf(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return await sha(ip + (env.ADMIN_KEY || "salt"));
}
// 投稿の前に呼ぶ：禁止されていれば true（もう片方の印も禁止に足す）
async function checkBan(request, env, who) {
  await ensureBan(env);
  const ipk = await ipKeyOf(request, env);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO seen (ip, ck, at) VALUES (?, ?, ?) ON CONFLICT(ip, ck) DO UPDATE SET at=excluded.at").bind(ipk, who.key, now).run();
  const hit = await env.DB.prepare("SELECT grp FROM bans WHERE k IN (?, ?) LIMIT 1").bind(ipk, who.key).first();
  if (!hit) return false;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO bans (k, at, note, grp) VALUES (?, ?, '（同じ人の別の印）', ?)").bind(ipk, now, hit.grp),
    env.DB.prepare("INSERT OR IGNORE INTO bans (k, at, note, grp) VALUES (?, ?, '（同じ人の別の印）', ?)").bind(who.key, now, hit.grp),
  ]);
  return true;
}
// 管理ページから：この投稿をした人を禁止して、その人の公開中の投稿をかくす
const BAN_SRC = {
  posts:   { sql: "SELECT iph AS k, text AS note FROM posts WHERE id=?", ensure: null },
  letters: { sql: "SELECT iph AS k, substr(message,1,40) AS note FROM letters WHERE id=?", ensure: (env) => ensureLetters(env) },
  tiktok:  { sql: "SELECT iph AS k, COALESCE(NULLIF(comment,''),'（TikTok）') AS note FROM tiktok WHERE id=?", ensure: (env) => ensureTT(env) },
  photos:  { sql: "SELECT iph AS k, COALESCE(NULLIF(comment,''),'（写真）') AS note FROM photos WHERE id=?", ensure: (env) => ensurePH(env) },
  wakaru:  { sql: "SELECT iph AS k, text AS note FROM wk_cards WHERE id=?", ensure: (env) => ensureWK(env) },
};
async function banItem(env, kind, id) {
  const src = BAN_SRC[kind];
  if (!src) return { error: "この投稿は見つかりません。" };
  await ensureBan(env); await ensureLetters(env); await ensureTT(env); await ensurePH(env); await ensureWK(env);
  const row = await env.DB.prepare(src.sql).bind(id).first();
  if (!row || !row.k || row.k === "admin") return { error: "この投稿の送り主は分かりませんでした。" };
  // つながっている印を集める（2段まで）
  const keys = new Set([row.k]);
  for (let round = 0; round < 2; round++) {
    const list = [...keys];
    const ph = list.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT ip, ck FROM seen WHERE ip IN (${ph}) OR ck IN (${ph})`).bind(...list, ...list).all();
    for (const r of results) { keys.add(r.ip); keys.add(r.ck); }
  }
  const now = Date.now(), grp = row.k.slice(0, 12) + now.toString(36);
  const note = String(row.note || "").slice(0, 40);
  const ks = [...keys];
  const ph = ks.map(() => "?").join(",");
  const ops = ks.map((k) => env.DB.prepare("INSERT OR IGNORE INTO bans (k, at, note, grp) VALUES (?, ?, ?, ?)").bind(k, now, note, grp));
  ops.push(
    env.DB.prepare(`UPDATE posts SET hidden=1 WHERE iph IN (${ph})`).bind(...ks),
    env.DB.prepare(`UPDATE tiktok SET hidden=1 WHERE iph IN (${ph})`).bind(...ks),
    env.DB.prepare(`DELETE FROM tiktok_likes WHERE iph IN (${ph})`).bind(...ks),
    env.DB.prepare(`UPDATE photos SET status='hidden' WHERE status<>'hidden' AND iph IN (${ph})`).bind(...ks),
    env.DB.prepare(`UPDATE wk_cards SET hidden=1 WHERE iph IN (${ph})`).bind(...ks),
    env.DB.prepare(`DELETE FROM wk_votes WHERE who IN (${ph})`).bind(...ks),
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k IN ('ver','tt_ver','ph_ver','wk_ver')"),
  );
  await env.DB.batch(ops);
  return { ok: true, keys: ks.length };
}

// ===== 生誕企画のリスト =====
// 並び順がそのまま「企画①②③…」の番号になります。
// open: true は最初から公開。false は管理ページで「公開する」を押すまで COMING SOON 表示。
// soon: COMING SOON のときに出す一言（例 "10/27公開予定"）。
// showAfter: ここに書いた企画が公開されるまで、カード自体を出さない（例 "kikaku2"）。
// page: このサイト内のページ名（例 "kikaku3" → kikaku3.html）。公開前はそのページも開けません。
const PROJECTS = [
  { id: "map", title: "聖ちぃ巡礼マップ", desc: "ちぃちゃんの足跡をめぐろう🐾", href: "https://seichii-map.pages.dev", external: true, open: true },
  { id: "kikaku2", title: "ちぃちゃんの好きなところ", desc: "ちぃちゃんの好きなところを教えて💘", href: "/kikaku2", page: "kikaku2", open: false, soon: "10/27公開予定" },
  { id: "kikaku3", title: "ちぃちゃんの推しTikTok", desc: "お気に入りのTikTokを教えて🎬", href: "/kikaku3", page: "kikaku3", open: false, soon: "10/28公開予定", showAfter: "kikaku2" },
  { id: "kikaku4", title: "23歳のちぃ記録", desc: "23歳のちぃちゃんの1年を振り返ろう🗓️", href: "/kikaku4", page: "kikaku4", open: false, soon: "10/29公開予定", showAfter: "kikaku3" },
  { id: "kikaku5", title: "ちぃちゃんの好きパフォーマンス", desc: "その好きポイント「わかる！」🙌", href: "/kikaku5", page: "kikaku5", open: false, soon: "10/30公開予定", showAfter: "kikaku4" },
  { id: "kikaku6", title: "わたしの選ぶちぃの好き顔", desc: "好きなちぃ顔に投票しよう🗳️", href: "/kikaku6", page: "kikaku6", pages: ["kikaku6-kekka"], open: false, soon: "10/31公開予定", showAfter: "kikaku5" },
  { id: "kikaku7", title: "（企画⑦・内容は準備中）", desc: "", href: "", open: false, soon: "11/1公開予定", showAfter: "kikaku6" },
];

let projectsReady = false;
async function projectStates(env) {
  if (!projectsReady) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS project_state (id TEXT PRIMARY KEY, open INTEGER NOT NULL)").run();
    projectsReady = true;
  }
  const { results } = await env.DB.prepare("SELECT id, open FROM project_state").all();
  const m = new Map(results.map((r) => [r.id, !!r.open]));
  const list = PROJECTS.map((p) => ({ ...p, open: m.has(p.id) ? m.get(p.id) : !!p.open }));
  const isOpen = (id) => !!list.find((x) => x.id === id)?.open;
  return list.map((p) => ({ ...p, visible: !p.showAfter || isOpen(p.showAfter) }));
}

async function projectsGet({ env }) {
  const list = await projectStates(env);
  return json({
    projects: list.filter((p) => p.visible).map((p) => p.open
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

// ===== 管理者だけの「公開前プレビュー」 =====
// 管理ページで合言葉を入れると、このブラウザにだけ印（クッキー）が付き、公開前の企画ページも開けます。
// ===== 限定公開（URLを知っている人だけ、公開前の企画ページを見られる） =====
async function shareGen(env, pid) {
  await ensureSettings(env);
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k=?").bind("share_gen_" + pid).first();
  return row ? Number(row.v) || 0 : 0;
}
async function shareToken(env, pid) {
  const gen = await shareGen(env, pid);
  if (gen < 0) return "";   // 限定公開を止めている
  return (await sha(`share:${pid}:${gen}:${env.ADMIN_KEY || "salt"}`)).slice(0, 20);
}
// 正しい合言葉なら、その合言葉を返す（クッキーに入れておくため）
async function shareCheck(request, env, pid, url) {
  const tok = await shareToken(env, pid);
  if (!tok) return null;
  const q = url.searchParams.get("pv") || "";
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)chii_sh_${pid}=([0-9a-f]+)`));
  if (q && same(q, tok)) return tok;
  if (m && same(m[1], tok)) return tok;
  return null;
}
// 限定URLで開いた人には、しばらくクッキーで覚えておく（ページ内の移動や再読み込みでも見られるように）
function withShare(res, sharing) {
  if (!sharing) return res;
  const r2 = new Response(res.body, res);
  r2.headers.set("Cache-Control", "private, no-store");
  r2.headers.append("Set-Cookie", `chii_sh_${sharing.pid}=${sharing.tok}; Path=/; Max-Age=${60 * 60 * 24 * 14}; HttpOnly; Secure; SameSite=Lax`);
  return r2;
}
async function previewToken(env) { return (await sha("preview:" + env.ADMIN_KEY)).slice(0, 40); }
async function isPreviewer(request, env) {
  if (!env.ADMIN_KEY) return false;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)chii_pv=([0-9a-f]+)/);
  return !!m && same(m[1], await previewToken(env));
}
async function withPreviewCookie(res, env) {
  const r = new Response(res.body, res);
  r.headers.append("Set-Cookie", `chii_pv=${await previewToken(env)}; Path=/; Max-Age=${60 * 60 * 24 * 14}; HttpOnly; Secure; SameSite=Lax`);
  return r;
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
    case "kao_list": {
      await ensureKao(env);
      const { results } = await env.DB.prepare("SELECT p.id, p.caption, p.hidden, p.at, (SELECT COUNT(*) FROM kao_votes v WHERE v.photo_id=p.id) AS n FROM kao_photos p ORDER BY p.sort, p.id").all();
      const voters = await env.DB.prepare("SELECT COUNT(DISTINCT v.who) AS n FROM kao_votes v JOIN kao_photos p ON p.id=v.photo_id WHERE p.hidden=0").first();
      return await withPreviewCookie(json({ items: results, voters: voters?.n || 0, max: KAO_MAX }), env);
    }
    case "kao_add": {
      await ensureKao(env);
      const full = b64Bytes(String(body.full ?? "")), thumb = b64Bytes(String(body.thumb ?? ""));
      const ft = full && imgType(full), tt = thumb && imgType(thumb);
      if (!ft || !tt) return json({ error: "写真を読み込めませんでした。" }, 400);
      if (full.length > 1_200_000 || thumb.length > 250_000) return json({ error: "写真が大きすぎます。" }, 400);
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM kao_photos").first();
      if (cnt && cnt.n >= KAO_MAX) return json({ error: `候補は${KAO_MAX}枚までです。` }, 400);
      const caption = String(body.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO kao_photos (caption, at, thumb, thumb_type, full, full_type, sort) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM kao_photos))").bind(caption, Date.now(), String(body.thumb), tt, String(body.full), ft),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='kao_ver'"),
      ]);
      return json({ ok: true });
    }
    case "kao_order": {
      // 管理ページで決めた並び順をそのまま保存する
      await ensureKao(env);
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return json({ error: "並び順が届きませんでした。" }, 400);
      await env.DB.batch([
        ...ids.map((pid, i) => env.DB.prepare("UPDATE kao_photos SET sort=? WHERE id=?").bind(i + 1, pid)),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='kao_ver'"),
      ]);
      return json({ ok: true });
    }
    case "kao_caption": {
      await ensureKao(env);
      const caption = String(body.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
      await env.DB.prepare("UPDATE kao_photos SET caption=? WHERE id=?").bind(caption, id).run();
      return json({ ok: true });
    }
    case "kao_hide": case "kao_show": {
      await ensureKao(env);
      await env.DB.batch([
        env.DB.prepare("UPDATE kao_photos SET hidden=? WHERE id=?").bind(body.action === "kao_hide" ? 1 : 0, id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='kao_ver'"),
      ]);
      return json({ ok: true });
    }
    case "kao_delete": {
      await ensureKao(env);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM kao_votes WHERE photo_id=?").bind(id),
        env.DB.prepare("DELETE FROM kao_photos WHERE id=?").bind(id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='kao_ver'"),
      ]);
      return json({ ok: true });
    }
    case "ban_item": {
      const r = await banItem(env, String(body.kind || ""), id);
      return r.error ? json(r, 400) : json(r);
    }
    case "ban_list": {
      await ensureBan(env);
      const { results } = await env.DB.prepare("SELECT grp, MIN(at) AS at, MAX(CASE WHEN note NOT LIKE '（同じ人の別の印）' THEN note END) AS note, COUNT(*) AS n FROM bans GROUP BY grp ORDER BY at DESC").all();
      return json({ bans: results });
    }
    case "unban": {
      await ensureBan(env);
      await env.DB.prepare("DELETE FROM bans WHERE grp=?").bind(String(body.grp || "")).run();
      return json({ ok: true });
    }
    case "list": {
      const { results } = await env.DB
        .prepare("SELECT id, text, at, hidden FROM posts ORDER BY id DESC LIMIT 1000").all();
      return await withPreviewCookie(json({ posts: results }), env);
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
      const out = [];
      for (const p of list) out.push({ id: p.id, title: p.title, desc: p.desc, open: p.open, href: p.href || "", page: p.page || "", visible: p.visible, showAfter: p.showAfter || "", share: p.page && !p.open ? await shareToken(env, p.id) : "" });
      return json({ projects: out });
    }
    case "share_reset": {
      // 限定公開URLを作り直す（前のURLは使えなくなる）／止める
      const pid = String(body.pid ?? "");
      if (!PROJECTS.some((p) => p.id === pid)) return json({ error: "その企画は見つかりません。" }, 400);
      const gen = await shareGen(env, pid);
      const next = body.stop ? -1 : Math.max(0, gen) + 1;
      await env.DB.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind("share_gen_" + pid, String(next)).run();
      return json({ ok: true, share: await shareToken(env, pid) });
    }
    case "set_project": {
      const pid = String(body.pid ?? "");
      if (!PROJECTS.some((p) => p.id === pid)) return json({ error: "その企画は見つかりません。" }, 400);
      await projectStates(env);
      await env.DB.prepare("INSERT INTO project_state (id, open) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET open=excluded.open")
        .bind(pid, body.open ? 1 : 0).run();
      return json({ ok: true });
    }
    case "counts": {
      // 管理ページのタブに出す件数
      await ensureLetters(env); await ensureTT(env); await ensurePH(env);
      const one = async (q) => (await env.DB.prepare(q).first())?.n || 0;
      const projects = await projectStates(env);
      return json({
        projects: projects.filter((p) => p.open).length, projectsTotal: projects.length,
        posts: await one("SELECT COUNT(*) AS n FROM posts"),
        letters: await one("SELECT COUNT(*) AS n FROM letters"),
        tiktok: await one("SELECT COUNT(*) AS n FROM tiktok"),
        photos: await one("SELECT COUNT(*) AS n FROM photos"),
        wakaru: await (async () => { await ensureWK(env); return one("SELECT COUNT(*) AS n FROM wk_cards"); })(),
        kao: await (async () => { await ensureKao(env); return one("SELECT COUNT(DISTINCT who) AS n FROM kao_votes"); })(),
        photosPending: await one("SELECT COUNT(*) AS n FROM photos WHERE status='pending'"),
        bans: await (async () => { await ensureBan(env); return one("SELECT COUNT(DISTINCT grp) AS n FROM bans"); })(),
      });
    }
    case "photo_list": {
      await ensurePH(env);
      const { results } = await env.DB.prepare("SELECT id, d, day_known, comment, at, status FROM photos ORDER BY id DESC LIMIT 1000").all();
      return await withPreviewCookie(json({ items: results, approval: await phApproval(env), limit: PH_LIMIT }), env);
    }
    case "photo_status": {
      await ensurePH(env);
      const st = ["shown", "hidden", "pending"].includes(body.status) ? body.status : "hidden";
      await env.DB.batch([
        env.DB.prepare("UPDATE photos SET status=? WHERE id=?").bind(st, id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='ph_ver'"),
      ]);
      return json({ ok: true });
    }
    case "photo_delete": {
      await ensurePH(env);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM photos WHERE id=?").bind(id),
        env.DB.prepare("DELETE FROM photo_blobs WHERE id=?").bind(id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='ph_ver'"),
      ]);
      return json({ ok: true });
    }
    case "photo_approval": {
      await ensureSettings(env);
      await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('photo_approval', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(body.on ? "on" : "off").run();
      return json({ ok: true, approval: !!body.on });
    }
    case "wk_list": {
      await ensureWK(env);
      const { results } = await env.DB.prepare("SELECT c.id, c.text, c.at, c.hidden, c.seed, (SELECT COUNT(*) FROM wk_votes v WHERE v.card_id=c.id) AS n, m.size AS vsize FROM wk_cards c LEFT JOIN wk_media m ON m.card_id=c.id ORDER BY c.id DESC LIMIT 1000").all();
      const tot = await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS s FROM wk_media").first();
      return await withPreviewCookie(json({ items: results, videoBytes: tot?.s || 0, videoLimit: WK_VIDEO_TOTAL }), env);
    }
    case "wk_add": {
      await ensureWK(env);
      const text = String(body.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) return json({ error: "カードの文を入れてね。" }, 400);
      if ([...text].length > WK_MAX) return json({ error: `${WK_MAX}文字までで書いてね。` }, 400);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO wk_cards (text, at, iph, seed) VALUES (?, ?, 'admin', 1)").bind(text, Date.now()),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='wk_ver'"),
      ]);
      return json({ ok: true });
    }
    case "wk_hide":
    case "wk_show":
      await ensureWK(env);
      await env.DB.batch([
        env.DB.prepare("UPDATE wk_cards SET hidden=? WHERE id=?").bind(body.action === "wk_hide" ? 1 : 0, id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='wk_ver'"),
      ]);
      return json({ ok: true });
    case "wk_delete":
      await ensureWK(env);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM wk_cards WHERE id=?").bind(id),
        env.DB.prepare("DELETE FROM wk_votes WHERE card_id=?").bind(id),
        env.DB.prepare("DELETE FROM wk_media WHERE card_id=?").bind(id),
        env.DB.prepare("DELETE FROM wk_chunks WHERE card_id=?").bind(id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='wk_ver'"),
      ]);
      return json({ ok: true });
    case "tiktok_list": {
      await ensureTT(env);
      const { results } = await env.DB.prepare("SELECT id, cat, vid, title, comment, at, hidden FROM tiktok ORDER BY id DESC LIMIT 1000").all();
      return json({ items: results, cats: TT_CATS, account: TT_ACCOUNT });
    }
    case "tiktok_hide":
    case "tiktok_show":
      await ensureTT(env);
      await env.DB.batch([
        env.DB.prepare("UPDATE tiktok SET hidden=? WHERE id=?").bind(body.action === "tiktok_hide" ? 1 : 0, id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='tt_ver'"),
      ]);
      return json({ ok: true });
    case "tiktok_check": {
      await ensureTT(env);
      const vid = String(body.vid ?? "").replace(/\D/g, "");
      if (!vid) return json({ error: "動画が指定されていません。" }, 400);
      return json({ result: await ttDiagnose(env, vid) });
    }
    case "tiktok_delete":
      await ensureTT(env);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM tiktok WHERE id=?").bind(id),
        env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='tt_ver'"),
      ]);
      return json({ ok: true });
    case "get_cloud_rules":
      return json({ rules: await cloudRules(env) });
    case "set_cloud_rules": {
      const hide = [...new Set((Array.isArray(body.hide) ? body.hide : []).map(cleanWord).filter(Boolean))].slice(0, 300);
      const seen = new Set();
      const merge = (Array.isArray(body.merge) ? body.merge : [])
        .map((p) => [cleanWord(p?.[0]), cleanWord(p?.[1])])
        .filter(([a, b]) => a && b && a !== b && !seen.has(a) && seen.add(a))
        .slice(0, 300);
      await ensureSettings(env);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO settings (k, v) VALUES ('cloud_rules', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify({ hide, merge })),
        bump,
      ]);
      return json({ ok: true, rules: { hide, merge } });
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
    let previewing = false, linkBot = false, sharing = null;
    // みんなが使う /api/（管理ページ以外）は、「同じ人」の印を用意して、投稿のときは禁止されていないか確かめる
    const isApi = url.pathname.startsWith("/api/") && url.pathname !== "/api/admin";
    const who = isApi ? await ttWho(request, env) : null;
    const c = { request, env, ctx, who };
    if (isApi && request.method === "POST") {
      try {
        if (await checkBan(request, env, who)) return withUidCookie(json({ error: "現在このサイトには投稿できません。" }, 403), who);
      } catch (e) { /* 確かめられないときは通す */ }
    }
    const out = await (async () => {
    try {
      if (url.pathname === "/api/posts") {
        if (request.method === "GET") return await postsGet(c);
        if (request.method === "POST") return await postsPost(c);
        return json({ error: "method not allowed" }, 405);
      }
      if (url.pathname === "/api/projects") return await projectsGet(c);
      if (url.pathname === "/api/photos") {
        if (request.method === "GET") return await phList(c);
        if (request.method === "POST") return await phPost(c);
        return json({ error: "method not allowed" }, 405);
      }
      if (url.pathname === "/api/photos/img") return await phImage(c);
      if (url.pathname === "/api/wakaru/video") return await wkVideo(c);
      if (url.pathname === "/api/wakaru" || url.pathname === "/api/wakaru/vote") {
        const cw = c;
        let res;
        if (url.pathname === "/api/wakaru") {
          if (request.method === "GET") res = await wkGet(cw);
          else if (request.method === "POST") res = await wkAdd(cw);
        } else if (request.method === "POST") res = await wkVote(cw);
        return withUidCookie(res || json({ error: "method not allowed" }, 405), who);
      }
      if (url.pathname === "/api/tiktok" || url.pathname === "/api/tiktok/like" || url.pathname === "/api/tiktok/comment") {
        const cw = c;
        let res;
        if (url.pathname === "/api/tiktok") {
          if (request.method === "GET") res = await ttGet(cw);
          else if (request.method === "POST") res = await ttPost(cw);
        } else if (request.method === "POST") {
          res = url.pathname === "/api/tiktok/like" ? await ttLike(cw) : await ttComment(cw);
        }
        return withUidCookie(res || json({ error: "method not allowed" }, 405), who);
      }
      if (url.pathname === "/api/tiktok/thumb") return await ttThumb(c);
      if (url.pathname === "/api/kao") return request.method === "POST" ? json({ error: "method not allowed" }, 405) : await kaoGet(c);
      if (url.pathname === "/api/kao/vote") return request.method === "POST" ? await kaoVote(c) : json({ error: "method not allowed" }, 405);
      if (url.pathname === "/api/kao/result") return await kaoResult(c);
      if (url.pathname === "/api/kao/img") return await kaoImage(c);
      // 公開前の企画ページはトップに戻す
      const pageName = url.pathname.replace(/^\/+|\.html$|\/+$/g, "");
      const ofPage = (x) => x.page === pageName || (x.pages || []).includes(pageName);
      if (PROJECTS.some(ofPage)) {
        const list = await projectStates(env);
        const p = list.find(ofPage);
        if (p && !p.open) {
          // Xなどのリンク読み取り役（ボット）には、公開前でもページの画像・タイトルだけは見せる
          const ua = request.headers.get("User-Agent") || "";
          const isLinkBot = /Twitterbot|facebookexternalhit|Discordbot|Slackbot|LinkedInBot|Line\/|Pinterest|TelegramBot|WhatsApp|Applebot|Embedly|redditbot/i.test(ua);
          if (isLinkBot) { linkBot = true; }
          else if (await isPreviewer(request, env)) previewing = true;
          else {
            const tok = await shareCheck(request, env, p.id, url);
            if (tok) sharing = { pid: p.id, tok };
            else return Response.redirect(new URL("/", url).toString(), 302);
          }
        }
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
    return null;
    })();
    if (out) return isApi ? withUidCookie(out, who) : out;
    const res = await env.ASSETS.fetch(request);
    // Xなどで画像が出るよう、共有用画像のアドレスを「https://〜/ogp.png」の形に直す
    const type = res.headers.get("content-type") || "";
    if (type.includes("text/html") && typeof HTMLRewriter !== "undefined") {
      const fix = { element(el) { el.setAttribute("content", new URL(el.getAttribute("content") || "/ogp.png", url).toString()); } };
      let rw = new HTMLRewriter();
      if (sharing && !previewing) {
        rw = rw.on("body", { element(el) {
          el.prepend('<div style="position:sticky;top:0;z-index:50;background:#3b2a33;color:#fff;font:700 13px/1.5 system-ui,sans-serif;text-align:center;padding:8px 12px">先行公開中（このページはまだ一般公開前です。URLを知っている人だけが見られます）</div>', { html: true });
        } });
      }
      if (previewing) {
        rw = rw.on("body", { element(el) {
          el.prepend('<div style="position:sticky;top:0;z-index:50;background:#3b2a33;color:#fff;font:700 13px/1.5 system-ui,sans-serif;text-align:center;padding:8px 12px">非公開プレビュー中（このページはまだ公開されていません。見えているのは管理者のあなただけです）</div>', { html: true });
        } });
      }
      return withShare(rw
        .on('meta[property="og:image"]', fix)
        .on('meta[name="twitter:image"]', fix)
        .transform(res), sharing);
    }
    return withShare(res, sharing);
  },
};
