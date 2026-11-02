/* X-like search parser/matcher. Works in browser (window.XSearch) and node (module.exports).
 * Syntax: words (AND), "exact phrase", OR, -term, from:handle, is:reply, is:retweet,
 * is:quote, has:links, has:media, has:images, has:videos, since:YYYY-MM-DD, until:YYYY-MM-DD (UTC, until is exclusive),
 * parentheses for grouping, e.g. (apple OR pear) from:someone -is:reply
 */
(function (root) {
  "use strict";

  function tokenize(q) {
    var toks = [], i = 0, n = q.length;
    while (i < n) {
      var c = q[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "(" || c === ")") { toks.push({ t: c }); i++; continue; }
      var neg = false;
      if (c === "-" && i + 1 < n && !/[\s)]/.test(q[i + 1])) { neg = true; i++; c = q[i]; }
      if (c === "(" && neg) { toks.push({ t: "(", neg: true }); i++; continue; }
      if (c === '"' || c === "\u201c" || c === "\u201d") {
        var j = i + 1;
        while (j < n && q[j] !== '"' && q[j] !== "\u201d" && q[j] !== "\u201c") j++;
        toks.push({ t: "term", neg: neg, kind: "phrase", value: q.slice(i + 1, j) });
        i = j + 1; continue;
      }
      var k = i;
      while (k < n && !/[\s()]/.test(q[k])) k++;
      var w = q.slice(i, k); i = k;
      if (!neg && w === "OR") { toks.push({ t: "OR" }); continue; }
      if (!neg && w === "AND") continue;
      var m = /^(from|is|has|since|until|lang|to):(.+)$/i.exec(w);
      if (m) toks.push({ t: "term", neg: neg, kind: m[1].toLowerCase(), value: m[2] });
      else toks.push({ t: "term", neg: neg, kind: "word", value: w });
    }
    return toks;
  }

  // Grammar: expr := and (OR and)* ; and := unary+ ; unary := term | '(' expr ')'
  // Like X, OR binds tighter than the implicit AND: "a b OR c" == a AND (b OR c).
  function parse(q) {
    var toks = tokenize(q || ""), pos = 0;
    function peek() { return toks[pos]; }
    function unary() {
      var t = toks[pos++];
      if (!t) return null;
      if (t.t === "(") {
        var e = andExpr();
        if (peek() && peek().t === ")") pos++;
        return t.neg ? { op: "not", a: e } : e;
      }
      if (t.t === "term") { var node = { op: "term", kind: t.kind, value: t.value }; return t.neg ? { op: "not", a: node } : node; }
      return null; // stray ')' or 'OR'
    }
    function orExpr() {
      var parts = [unary()];
      while (peek() && peek().t === "OR") { pos++; parts.push(unary()); }
      parts = parts.filter(Boolean);
      return parts.length === 1 ? parts[0] : { op: "or", parts: parts };
    }
    function andExpr() {
      var parts = [];
      while (pos < toks.length && peek().t !== ")") {
        if (peek().t === "OR") { pos++; continue; }
        var e = orExpr(); if (e) parts.push(e);
      }
      return parts.length === 1 ? parts[0] : { op: "and", parts: parts };
    }
    var ast = andExpr();
    while (pos < toks.length) { pos++; var more = andExpr(); if (more && (more.parts ? more.parts.length : 1)) ast = { op: "and", parts: [ast, more] }; }
    return ast;
  }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function norm(s) { return (s || "").toLowerCase().replace(/\s+/g, " "); }
  function haystack(p) {
    var parts = [p.text, p.name, "@" + p.username];
    if (p.article_title) parts.push(p.article_title);
    [p.ref, p.ref && p.ref.quote].forEach(function (r) { // quoted / reposted original (+ the post it quotes)
      if (r) parts.push(r.text || "", r.name || "", r.username ? "@" + r.username : "", r.article_title || "");
    });
    if (p.reply_to && p.reply_to.username) parts.push("@" + p.reply_to.username);
    return norm(parts.join(" \n "));
  }

  function matchTerm(node, p, hay) {
    var v = node.value, lv = v.toLowerCase();
    switch (node.kind) {
      case "word": {
        if (!lv) return true;
        var re = new RegExp("(^|[^\\p{L}\\p{N}_])" + esc(lv) + "(?=$|[^\\p{L}\\p{N}_])", "u");
        return re.test(hay) || (/[^\p{L}\p{N}_]/u.test(lv) && hay.indexOf(lv) >= 0);
      }
      case "phrase": return hay.indexOf(norm(v)) >= 0;
      case "from": return (p.username || "").toLowerCase() === lv.replace(/^@/, "");
      case "to": return !!(p.reply_to && (p.reply_to.username || "").toLowerCase() === lv.replace(/^@/, ""));
      case "lang": return (p.lang || "").toLowerCase() === lv;
      case "is":
        if (lv === "reply") return p.kind === "reply" || !!p.reply_to;
        if (lv === "retweet" || lv === "repost") return p.kind === "repost";
        if (lv === "quote") return p.kind === "quote";
        return false;
      case "has":
        if (lv === "links") return (p.urls && p.urls.length > 0) || /https?:\/\//.test(p.text || "");
        var md = p.media || [];  // the post's own media (a repost: the original's)
        if (lv === "media") return md.length > 0;
        if (lv === "images") return md.some(function (m) { return m.type === "photo"; });
        if (lv === "videos") return md.some(function (m) { return m.type === "video" || m.type === "animated_gif"; });
        return false;
      case "since": return (p.created_at || "") >= v;
      case "until": return (p.created_at || "") < v;
    }
    return false;
  }

  function evalNode(node, p, hay) {
    if (!node) return true;
    switch (node.op) {
      case "term": return matchTerm(node, p, hay);
      case "not": return !evalNode(node.a, p, hay);
      case "and": for (var i = 0; i < node.parts.length; i++) if (!evalNode(node.parts[i], p, hay)) return false; return true;
      case "or": for (var j = 0; j < node.parts.length; j++) if (evalNode(node.parts[j], p, hay)) return true; return false;
    }
    return true;
  }

  function compile(q) {
    var ast = parse(q);
    return function (p) { return evalNode(ast, p, haystack(p)); };
  }

  function idCmp(a, b) { // numeric compare of snowflake id strings, newest first
    if (a.id.length !== b.id.length) return b.id.length - a.id.length;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }
  function search(posts, q) { // always newest first
    var f = compile(q), out = posts.filter(f);
    out.sort(idCmp);
    return out;
  }


  // Long-post preview. Returns null when the text is short enough to show whole; otherwise a preview cut at
  // <= PREVIEW_CHARS characters on a word boundary (never inside a URL) and/or after PREVIEW_LINES lines, ending in "…".
  var PREVIEW_CHARS = 280, PREVIEW_LINES = 6, COLLAPSE_CHARS = 300; // collapse only when it hides a real amount
  function preview(text, opt) {
    opt = opt || {};
    var maxC = opt.chars || PREVIEW_CHARS, maxL = opt.lines || PREVIEW_LINES, minC = opt.collapseAt || COLLAPSE_CHARS;
    text = String(text == null ? "" : text);
    var full = text.replace(/\s+$/, ""), lines = full.split("\n");
    if (full.length <= minC && lines.length <= maxL) return null;
    var cut = lines.length > maxL ? lines.slice(0, maxL).join("\n").length : full.length;
    if (cut > maxC) {
      cut = maxC;
      var re = /https?:\/\/[^\s<>"']+/g, m;           // same URL pattern as the page's linkify
      while ((m = re.exec(full))) {
        if (m.index < cut && cut < m.index + m[0].length) { cut = m.index; break; } // don't cut inside a link
        if (m.index >= cut) break;
      }
      var head = full.slice(0, cut), sp = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"), head.lastIndexOf("\t"));
      if (cut < full.length && !/\s/.test(full.charAt(cut)) && sp > cut * 0.6) cut = sp; // word boundary (if one is near)
      var c = full.charCodeAt(cut - 1); if (c >= 0xD800 && c <= 0xDBFF) cut--;                // don't split a surrogate pair
    }
    var out = full.slice(0, cut).replace(/[\s,;:\-–—]+$/, "");
    if (out.length >= full.length) return null;
    return out.replace(/(\.+|…)$/, "") + "…"; // "end." + "…" reads as "end…"
  }

  // Label for a post's hidden media, e.g. "photo", "2 photos", "video (0:42)", "GIF", "2 photos, video (1:05)".
  function clock(ms) {
    var t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function mediaLabel(media) {
    var photos = 0, gifs = 0, vids = [];
    (media || []).forEach(function (m) {
      if (m.type === "photo") photos++; else if (m.type === "animated_gif") gifs++; else if (m.type === "video") vids.push(m);
    });
    var parts = [];
    if (photos) parts.push(photos === 1 ? "photo" : photos + " photos");
    if (vids.length === 1) parts.push("video" + (vids[0].duration_ms ? " (" + clock(vids[0].duration_ms) + ")" : ""));
    else if (vids.length) parts.push(vids.length + " videos");
    if (gifs) parts.push(gifs === 1 ? "GIF" : gifs + " GIFs");
    return parts.join(", ");
  }
  // Only X's media servers, https, no credentials/port: what the page may ever load (checked again at tap time).
  var MEDIA_HOSTS = { photo: "pbs.twimg.com", poster: "pbs.twimg.com", video: "video.twimg.com" };
  function mediaURL(u, kind) {
    var h = MEDIA_HOSTS[kind];
    if (!h || typeof u !== "string" || /\s/.test(u)) return null;
    var m = /^https:\/\/([^\/?#@:]+)(?:[\/?#]|$)/.exec(u);
    return m && m[1] === h ? u : null;
  }

  var api = { tokenize: tokenize, parse: parse, compile: compile, search: search, idCmp: idCmp, preview: preview, mediaLabel: mediaLabel, mediaURL: mediaURL, clock: clock };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XSearch = api;
})(this);
