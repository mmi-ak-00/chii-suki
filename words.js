// ちぃちゃんの好きなところ：投稿から言葉を取り出して、ワードクラウド用に数える
// 企画②のページと管理ページの両方で使います。
// rules = { hide: ["出さない言葉", ...], merge: [["まとめる前", "まとめた後"], ...] }
(function () {
  // それだけでは意味のない言葉（ワードクラウドに出さない）
  const STOP = new Set([
    "ちぃ", "ちゃん", "ちぃちゃん", "ちいちゃん", "ところ", "とこ", "好き", "すき", "大好き", "だいすき",
    "こと", "もの", "感じ", "とか", "など", "です", "ます", "ある", "いる", "する", "なる", "いい", "よい", "良い",
    "とても", "すごく", "すごい", "めっちゃ", "本当", "ほんと", "ほんとう",
    "あと", "その", "この", "あの", "それ", "これ", "みたい", "よう", "くれる", "てる", "ている",
    "誰", "だれ", "何", "なに", "なん", "人", "方", "時", "事", "物", "所", "中", "今", "私", "僕", "俺",
    "自分", "みんな", "皆", "いつも", "とき", "ため", "感", "的", "さ", "家", "力", "性", "心",
    "ちゃう", "でも", "にでも", "だよ", "だけ", "ほど", "まで", "から", "ので", "けど",
  ]);
  // 前の言葉にくっつけて1語にする後ろの文字（努力＋家→努力家、記憶＋力→記憶力）
  const SUFFIX = new Set(["家", "力", "性", "的", "感", "さ", "心", "者", "派", "味", "系", "愛", "ぶり", "っぷり", "らしさ", "顔", "声"]);
  // 1文字でもそれだけで意味がある言葉
  const ONE_OK = new Set(["声", "目", "顔", "歌", "髪", "猫", "瞳", "肌", "手", "指", "脚", "足", "口", "耳", "鼻", "眉", "頬", "腕", "姿", "涙", "字", "絵", "服", "笑", "愛", "芯", "華", "品", "音", "舞"]);

  const seg = (typeof Intl !== "undefined" && Intl.Segmenter) ? new Intl.Segmenter("ja", { granularity: "word" }) : null;
  const norm = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[ー〜~]+$/, "").trim();
  const isParticle = (w) => /^[぀-ゟ]{1,2}$/.test(w);
  const isKanjiOrKana = (w) => /[一-鿿゠-ヿ]$/.test(w);

  function cleanRules(rules) {
    const hide = new Set((rules && rules.hide || []).map(norm).filter(Boolean));
    const merge = new Map();
    for (const pair of (rules && rules.merge || [])) {
      const a = norm(pair[0] || ""), b = norm(pair[1] || "");
      if (a && b && a !== b) merge.set(a, b);
    }
    return { hide, merge };
  }
  function mapWord(w, R) {
    let x = w, guard = 0;
    while (R.merge.has(x) && guard++ < 5) x = R.merge.get(x);
    return x;
  }

  function splitWords(t) {
    if (!seg) return t.split(/[\s、。！？!?,.・]+/).filter(Boolean);
    const toks = [];
    for (const s of seg.segment(t)) toks.push({ w: s.segment, like: s.isWordLike });
    const out = [];
    const kind = (c) => /[\u4e00-\u9fff々]/.test(c) ? "k" : /[\u3040-\u309f]/.test(c) ? "h" : /[\u30a0-\u30ff]/.test(c) ? "t" : "x";
    let run = null;   // 1文字ずつに分けられた言葉を、つなぎ直している途中のもの
    for (let i = 0; i < toks.length; i++) {
      const { w, like } = toks[i];
      if (!like) { out.push(null); run = null; continue; } // 区切り
      // 知らない言葉は1文字ずつに分けられてしまうので、同じ種類の文字が続くときはつなぎ直す（ほ・わ・ほ・わ→ほわほわ、女・豹→女豹）
      if ([...w].length === 1 && run && run.kind === kind(w) && run.kind !== "x") {
        out[out.length - 1] += w; continue;
      }
      if ([...w].length === 1) {
        const prevTok = i > 0 ? toks[i - 1] : null;
        const nextTok = toks[i + 1];
        // 次も同じ種類の1文字なら、つなぎ直しを始める
        if (nextTok && nextTok.like && [...nextTok.w].length === 1 && kind(nextTok.w) === kind(w) && kind(w) !== "x") {
          out.push(w); run = { kind: kind(w) }; continue;
        }
      }
      // くり返し言葉の切れ目を直す（ほわほ＋わし → ほわほわ＋し）
      if (run && run.kind === kind(w[0])) {
        const cur = out[out.length - 1], cand = cur + w[0], n = [...cand].length;
        if (n % 2 === 0 && n >= 4) {
          const half = [...cand].slice(0, n / 2).join("");
          if (half + half === cand) {
            out[out.length - 1] = cand; run = null;
            const rest = [...w].slice(1).join("");
            if (rest) out.push(rest);
            continue;
          }
        }
      }
      run = null;
      const prev = out.length ? out[out.length - 1] : null;
      // くっつく文字は前の言葉につなげる
      if (prev && SUFFIX.has(w) && !isParticle(prev) && (isKanjiOrKana(prev) || (/[\u4e00-\u9fff]/.test(prev) && ["系", "的", "性", "感", "派"].includes(w)))) { out[out.length - 1] = prev + w; continue; }
      // 同じ言葉のくり返しは1語に（キレ＋キレ→キレキレ）
      if (prev && prev === w && w.length <= 3) { out[out.length - 1] = prev + w; continue; }
      out.push(w);
    }
    return out.filter(Boolean);
  }

  function wordsOf(text, R) {
    const t = norm(text);
    const out = new Set();
    for (const p of splitWords(t)) {
      const w = norm(p);
      if (!w || STOP.has(w) || isParticle(w)) continue;
      if ([...w].length === 1 && !ONE_OK.has(w)) continue;
      out.add(w);
    }
    // 短い投稿は投稿全体もひとつの言葉として数える
    let whole = t;
    // 語尾を取る（2回くり返して「優しいところだよ」→「優しい」のような重なりにも対応）
    for (let i = 0; i < 2; i++) {
      whole = whole.replace(/[!?。、.,\s]+$/, "")
        .replace(/(だよね|だよ|だね|ですよ|ですね|です|だ|よ|ね)+$/, "")   // 全部だよ→全部
        .replace(/(の)?(が|も)(いい|良い|よい|ある|あって)$/, "")       // 記憶力がいい→記憶力、思いやりがある→思いやり
        .replace(/(が|の)?(好き|すき|大好き)(なところ|なとこ|です|！|!)*$/, "")
        .replace(/(な|の)?(ところ|とこ)$/, "").trim();
    }
    // （「全部だよ」「誰にでも優しい」のように、切り分けると意味が変わる言葉も残すため）
    if (whole && [...whole].length <= 10 && !STOP.has(whole) && !out.has(whole) && out.size >= 1) out.add(whole);
    if (out.size === 0 && whole && !STOP.has(whole)) out.add(whole);
    // 管理ページの設定（まとめる・出さない）
    const res = new Set();
    for (const w of out) { const m = mapWord(w, R); if (!R.hide.has(m)) res.add(m); }
    return [...res];
  }

  function count(posts, rules) {
    const R = cleanRules(rules);
    const freq = new Map();
    for (const p of posts) for (const w of wordsOf(p.text, R)) freq.set(w, (freq.get(w) || 0) + 1);
    // 片方がもう片方を含む似た言葉（例:「笑顔」と「笑顔がかわいい」）は短い方にも数を足す
    const keys = [...freq.keys()];
    const score = new Map(freq);
    for (const a of keys) for (const b of keys) if (a !== b && [...a].length >= 2 && b.includes(a)) score.set(a, score.get(a) + freq.get(b) * 0.5);
    const items = [...score.entries()].sort((x, y) => y[1] - x[1]).slice(0, 80);
    return { items, freq };
  }

  const api = { wordsOf: (text, rules) => wordsOf(text, cleanRules(rules)), count, norm };
  if (typeof window !== "undefined") window.ChiiWords = api;
  if (typeof module !== "undefined") module.exports = api;
})();
