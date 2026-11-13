/* X Text: text-only static reader. Loads data/site.json + data/*.json, hash-routed views. */
(function (root) {
  "use strict";
  var S = (typeof module !== "undefined" && module.exports) ? require("./search.js") : root.XSearch;
  var P = (typeof module !== "undefined" && module.exports) ? require("./parent.js") : root.XParent;
  var state = { config: { saved_searches: [] }, following: [], posts: [], saved: {}, updated: null, limit: 50, byId: {},
    parents: { posts: [], missing: [] }, shown: {}, loading: {}, notes: {}, index: null, loadedShards: {},
    archiveComplete: true, postCount: 0, parentScan: {}, feedView: "all" };
  var sess = { text: null, bound: false };  // text of the last loaded data/posts.json (for refresh polling)
  var $ = function (id) { return document.getElementById(id); };
  var PAGE = 50;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // x.com, twitter.com, t.co, and any subdomain. Compared against the parsed hostname.
  var X_HOSTS = ["x.com", "twitter.com", "t.co"];
  function xHost(host) {
    host = String(host || "").toLowerCase().replace(/\.+$/g, "");
    for (var i = 0; i < X_HOSTS.length; i++) {
      var name = X_HOSTS[i];
      if (host === name || host.slice(-(name.length + 1)) === "." + name) return true;
    }
    return false;
  }
  function hostOf(raw) {
    try { return new URL(raw).hostname.toLowerCase().replace(/\.+$/g, ""); }
    catch (e) { return ""; }
  }
  // http(s) only, no credentials, and never a link to X.
  function safeHref(raw) {
    if (typeof raw !== "string" || raw.length > 4096 || !/^https?:\/\/[^\s<>"']+$/.test(raw)) return "";
    var u;
    try { u = new URL(raw); } catch (e) { return ""; }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || xHost(u.hostname)) return "";
    return raw;
  }
  function eachUrlEntity(src, fn) {
    if (!src || typeof src !== "object") return;
    function take(list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) fn(list[i]);
    }
    var ent = src.entities;
    if (ent && typeof ent === "object" && !Array.isArray(ent)) {
      take(ent.urls);
      if (ent.description && typeof ent.description === "object") take(ent.description.urls);
      if (ent.url && typeof ent.url === "object") take(ent.url.urls);
    }
    take(src.urls);
  }
  // Pair a short URL in the text with a stored { url, expanded_url } entity, when one exists.
  function entityFor(raw, src) {
    var found = null;
    eachUrlEntity(src, function (e) {
      if (found || !e || typeof e !== "object" || e.url !== raw) return;
      found = e;
    });
    return found;
  }
  function isMediaPath(pathname) {
    return /\/photo(?:\/|$)/.test(pathname) || /\/video(?:\/|$)/.test(pathname);
  }
  function looksLikeMediaUrl(raw) {
    var host = hostOf(raw);
    if (!host) return false;
    if (host === "pic.twitter.com" || host === "pic.x.com") return true;
    var path = "";
    try { path = new URL(raw).pathname || ""; } catch (e) { return false; }
    return xHost(host) && isMediaPath(path);
  }
  // Photo/video card links are omitted when the post already has media behind Show photo / Show video.
  // A media URL with no attached media stays in the text, unlinked.
  function isMediaLink(raw, expanded, ent, src) {
    if (ent && (ent.media_key || ent.type === "photo" || ent.type === "video" || ent.type === "animated_gif")) return true;
    if (!(looksLikeMediaUrl(raw) || (expanded && looksLikeMediaUrl(expanded)))) return false;
    return !!(src && Array.isArray(src.media) && src.media.length);
  }
  // drop: omit a media short link. href: safe external destination. otherwise keep the original characters.
  function linkAction(url, src) {
    var ent = entityFor(url, src);
    var expanded = ent && typeof ent.expanded_url === "string" ? ent.expanded_url : "";
    if (isMediaLink(url, expanded, ent, src)) return { drop: true };
    if (expanded && !safeHref(expanded)) return {};
    var href = safeHref(expanded || url);
    if (!href) return {};
    return { href: href, label: href.replace(/^https?:\/\//, "") };
  }
  // Escape, then link http(s) URLs. Destinations on X stay text; a stored expanded URL is used instead of a short link.
  function linkify(text, src) {
    text = String(text == null ? "" : text);
    var out = "", re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
    while ((m = re.exec(text))) {
      var url = m[0].replace(/[.,;:!?)\]]+$/, "");
      var gap = text.slice(last, m.index);
      var action = linkAction(url, src);
      if (action.drop) gap = gap.replace(/\s+$/, "");
      out += esc(gap);
      if (action.href) out += '<a href="' + esc(action.href) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(action.label) + "</a>";
      else if (!action.drop) out += esc(url);
      last = m.index + url.length;
      re.lastIndex = last;
    }
    return out + esc(text.slice(last));
  }

  var fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  var fmtY = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso), now = new Date();
    if (isNaN(d.getTime())) return "";
    return (d.getFullYear() === now.getFullYear() ? fmt : fmtY).format(d);
  }
  function ago(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function num(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n || 0); }
  function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "search"; }
  function userLink(u) { return '<a href="#/u/' + encodeURIComponent(u) + '">@' + esc(u) + "</a>"; }
  function known(u) { return state.following.some(function (f) { return f.username.toLowerCase() === (u || "").toLowerCase(); }); }
  // Followed accounts stay inside the reader. Everyone else is plain text.
  function handleHtml(u) {
    if (!u) return "";
    return known(u) ? userLink(u) : '<span class="handle">@' + esc(u) + "</span>";
  }
  function who(u) { return u ? handleHtml(u) : "a post"; }
  // Account page heading. followed handles stay on #/u/; a bio uses the same link rules as post text.
  function userHeader(user, handle, count, following) {
    var saved = state.following;
    if (following) state.following = following;
    try {
      var u = user && typeof user === "object" ? user : null;
      var name = u && u.name ? esc(u.name) + " " : "";
      var desc = u && u.description ? '<br><span>' + linkify(u.description, u) + "</span>" : "";
      return name + handleHtml(handle) + " · " + count + " saved posts" + desc;
    } finally {
      if (following) state.following = saved;
    }
  }
  function timeHtml(iso) {
    if (!iso) return "";
    return '<span>·</span><span title="' + esc(iso) + '">' + esc(when(iso)) + "</span>";
  }
  // First post with a given id wins (archive order: main feed, then saved searches).
  function indexPosts(posts) {
    var byId = {};
    (posts || []).forEach(function (p) {
      if (!p || typeof p !== "object" || typeof p.id !== "string" || !/^[0-9]{1,25}$/.test(p.id) || byId[p.id]) return;
      byId[p.id] = p;
    });
    return byId;
  }
  function combinedArchive(posts, saved) {
    var seen = {}, out = [], lists = [posts || []];
    Object.keys(saved || {}).forEach(function (k) { lists.push((saved[k] && saved[k].posts) || []); });
    lists.forEach(function (list) {
      (list || []).forEach(function (p) {
        if (!p || typeof p !== "object" || p.id == null || seen[p.id]) return;
        seen[p.id] = 1; out.push(p);
      });
    });
    return out;
  }
  function replyTarget(p) {
    var r = p && p.reply_to;
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    var id = typeof r.id === "string" && /^[0-9]{1,25}$/.test(r.id) ? r.id : "";
    var username = typeof r.username === "string" ? r.username : "";
    if (!id && !username) return null;
    return { id: id, username: username };
  }
  // Parent post only: a different archived post. Does not walk that parent's reply_to.
  function parentOf(p, byId) {
    var t = replyTarget(p);
    if (!t || !t.id || !byId) return null;
    if (p && p.id === t.id) return null;
    var parent = byId[t.id];
    if (!parent || parent === p || parent.id !== t.id) return null;
    return parent;
  }
  // Author of a quoted or reposted original: name and @username. Followed accounts link in-site.
  function refMeta(r) {
    var u = r.username || "";
    return '<div class="meta"><span class="name">' + esc(r.name || u || "Unknown account") + "</span>" +
      (u ? handleHtml(u) : "") + timeHtml(r.created_at) + "</div>";
  }
  function articleLine(t) { return t ? '<div class="article">Article: ' + esc(t) + "</div>" : ""; }
  // The original shown inline: author, full text, and the post it quotes (one level), never a link to it.
  // depth caps a cyclic or very deep quote chain: this post, plus the one post it quotes.
  function refBlock(r, text, label, media, depth, linkSrc) {
    if (!r || typeof r !== "object") return "";
    depth = depth || 0;
    if (depth >= 2) return "";
    var nested = "";
    var q = r.quote;
    if (depth < 1 && q && typeof q === "object" && q !== r) {
      var same = r.id != null && q.id != null && String(r.id) === String(q.id);
      if (!same) nested = refBlock(q, typeof q.text === "string" ? q.text : "", "❝ Quoting", undefined, depth + 1, q);
    }
    var body = typeof text === "string" && text ? textBlock(text, linkSrc || r) : '<div class="text missing">Text not available.</div>';
    return '<div class="quote">' + (label ? '<div class="marker">' + label + "</div>" : "") + refMeta(r) +
      articleLine(r.article_title) + body +
      mediaBlock(media === undefined ? r.media : media, r.username) + nested + "</div>";
  }

  // Hidden media: only a label button is rendered. The original URL stays in this JS map (never in the DOM).
  // On tap, mediaURL() turns an allowed path into the relay URL and that is what the <img>/<video> requests.
  // Video and GIF choose a variant first; the address written into the page is still the relay URL.
  var mediaStore = {}, mid = 0;
  function mediaBlock(media, username) {
    if (!Array.isArray(media)) media = [];
    var label = S.mediaLabel(media);
    if (!label) return "";
    var id = "m" + (++mid);
    mediaStore[id] = { media: media, username: username || "" };
    return '<button type="button" class="expand media-btn" aria-expanded="false" aria-controls="' + id + '" data-label="' +
      esc(label) + '">Show ' + esc(label) + '</button><div class="media" id="' + id + '" hidden></div>';
  }
  function gt0(n) {
    return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
  }
  function canFullscreen(obj) {
    return !!(obj && (typeof obj.requestFullscreen === "function" || typeof obj.webkitEnterFullscreen === "function"));
  }
  // The <video> has controls. Size for the screen when the browser can fullscreen it.
  function fullscreenCapable() {
    var el = null, proto = null;
    if (typeof document !== "undefined" && document && typeof document.createElement === "function") {
      try { el = document.createElement("video"); } catch (e) { el = null; }
    }
    if (typeof HTMLVideoElement !== "undefined" && HTMLVideoElement) proto = HTMLVideoElement.prototype;
    return canFullscreen(el) || canFullscreen(proto);
  }
  function deviceRatio() {
    var w = typeof window !== "undefined" ? window : null;
    return gt0(w && w.devicePixelRatio) || 1;
  }
  function screenCss() {
    var s = typeof screen !== "undefined" && screen ? screen : null;
    if ((!s || !gt0(s.width) || !gt0(s.height)) && typeof window !== "undefined" && window && window.screen) s = window.screen;
    var w = s && gt0(s.width), h = s && gt0(s.height);
    return w && h ? { w: w, h: h } : null;
  }
  // .media is hidden until the tap, so its width is often 0. The card around it is the next visible box.
  function containerCss(box) {
    var el = box, guard = 0, w;
    while (el && guard++ < 16) {
      w = gt0(el.clientWidth);
      if (w) return w;
      el = el.parentElement;
    }
    return 0;
  }
  function usableVideos(m) {
    var list = m && Array.isArray(m.variants) ? m.variants : [], out = [], i, v, w, h;
    for (i = 0; i < list.length; i++) {
      v = list[i];
      if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.url !== "string") continue;
      if (!S.mediaURL(v.url, "video")) continue;
      w = gt0(v.w);
      h = gt0(v.h);
      if (!w || !h) continue;
      out.push({ url: v.url, w: w, h: h, br: typeof v.br === "number" && isFinite(v.br) ? v.br : 0 });
    }
    return out;
  }
  // Needed width is the device pixels of the clip fitted to the screen in the better orientation.
  // A 16:9 video on 1125x2436 is limited by the 1125 short side, so it needs ~2000, not 2436.
  function neededWidth(big, box, m) {
    var dpr = deviceRatio(), needed = 0, scr, Sw, Sh, fit, css;
    if (fullscreenCapable() && big) {
      scr = screenCss();
      if (scr) {
        Sw = scr.w * dpr;
        Sh = scr.h * dpr;
        fit = Math.max(Math.min(Sw / big.w, Sh / big.h), Math.min(Sh / big.w, Sw / big.h));
        if (fit > 0 && isFinite(fit)) needed = big.w * fit;
      }
    }
    if (!(needed > 0)) {
      css = containerCss(box);
      if (!css && m) css = gt0(m.width);
      needed = css * dpr;
    }
    return needed;
  }
  function pickVideoURL(m, box) {
    var fallback = m && typeof m.url === "string" ? m.url : "";
    var usable = usableVideos(m), big, i, v, target, best;
    if (!usable.length) return fallback;
    big = usable[0];
    for (i = 1; i < usable.length; i++) {
      v = usable[i];
      if (v.w > big.w || (v.w === big.w && v.br > big.br)) big = v;
    }
    target = neededWidth(big, box, m) * 0.95;
    best = null;
    for (i = 0; i < usable.length; i++) {
      v = usable[i];
      if (v.w < target) continue;
      if (!best || v.w < best.w || (v.w === best.w && v.br > best.br)) best = v;
    }
    return (best || big).url;
  }
  function mediaEl(m, i, n, username, box) {
    var who = username ? " by @" + username : "", fig = document.createElement("div");
    fig.className = "media-item";
    if (m.type === "photo") {
      var src = S.mediaURL(m.url, "photo");
      if (!src) return null;
      var img = document.createElement("img");
      img.loading = "lazy"; img.decoding = "async";
      img.referrerPolicy = "no-referrer"; img.setAttribute("referrerpolicy", "no-referrer");
      img.alt = m.alt || ("Photo" + (n > 1 ? " " + (i + 1) + " of " + n : "") + who + " (no description)");
      if (m.width && m.height) { img.width = m.width; img.height = m.height; }
      img.src = src;
      fig.appendChild(img);
    } else {
      var chosen = pickVideoURL(m, box);
      var vsrc = S.mediaURL(chosen, "video");
      if (!vsrc) return null;
      var gif = m.type === "animated_gif", v = document.createElement("video");
      v.controls = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "none"; v.autoplay = false;
      if (gif) { v.loop = true; v.muted = true; v.setAttribute("muted", ""); }
      v.setAttribute("aria-label", m.alt || ((gif ? "GIF" : "Video") + who + (m.duration_ms ? ", " + S.clock(m.duration_ms) : "")));
      if (m.width && m.height) { v.width = m.width; v.height = m.height; }
      var poster = S.mediaURL(m.poster, "poster");
      if (poster) v.poster = poster;
      v.src = vsrc;
      fig.appendChild(v);
    }
    if (m.alt) { var cap = document.createElement("div"); cap.className = "alt"; cap.textContent = m.alt; fig.appendChild(cap); }
    return fig;
  }
  function toggleMedia(btn) {
    var box = $(btn.getAttribute("aria-controls")), open = btn.getAttribute("aria-expanded") !== "true", st = mediaStore[box.id];
    if (open) {
      var list = (st && st.media) || [];
      list.forEach(function (m, i) { var el = mediaEl(m, i, list.length, st.username, box); if (el) box.appendChild(el); });
    } else {
      box.querySelectorAll("video").forEach(function (v) { v.pause(); v.removeAttribute("src"); v.load(); });
      box.textContent = "";  // removed again: hidden means not loaded
    }
    box.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = (open ? "Hide " : "Show ") + btn.getAttribute("data-label");
    if (!open) { var r = btn.getBoundingClientRect(); if (r.top < 0 || r.bottom > window.innerHeight) btn.scrollIntoView({ block: "center" }); }
  }

  // Post text; long text shows a preview + "Show full post" toggle (full text stays in the page, expands inline).
  var tid = 0;
  function textBlock(text, src) {
    var pv = S.preview(text);
    if (!pv) return '<div class="text">' + linkify(text, src) + "</div>";
    var id = "t" + (++tid);
    return '<div class="text" id="' + id + '"><span class="pv">' + linkify(pv, src) + '</span><span class="full" hidden>' + linkify(text, src) +
      '</span></div><button type="button" class="expand" aria-expanded="false" aria-controls="' + id + '">Show full post</button>';
  }
  function toggleText(btn) {
    var box = $(btn.getAttribute("aria-controls")), open = btn.getAttribute("aria-expanded") !== "true";
    box.querySelector(".pv").hidden = open;
    box.querySelector(".full").hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Show less" : "Show full post";
    if (!open) { var r = btn.getBoundingClientRect(); if (r.top < 0 || r.bottom > window.innerHeight) btn.scrollIntoView({ block: "center" }); }
  }

  // Feed body for one post. forParent uses the same quote/repost embedding and does not look up another reply parent.
  function postContent(p, forParent) {
    if (p.kind === "repost") {
      var ref = p.ref && typeof p.ref === "object" && !Array.isArray(p.ref) ? p.ref : {};
      var r = Object.assign({}, ref, { article_title: p.article_title });
      return refBlock(r, p.text, "", p.media, 0, p);
    }
    var textHtml = typeof p.text === "string" && p.text ? textBlock(p.text, p)
      : (forParent ? '<div class="text missing">Text not available.</div>' : textBlock(p.text, p));
    var html = articleLine(p.article_title) + textHtml + mediaBlock(p.media, p.username);
    if (p.kind === "quote" && p.ref && typeof p.ref === "object" && !Array.isArray(p.ref) && p.ref !== p) html += refBlock(p.ref, p.ref.text, "❝ Quoting", undefined, 0, p.ref);
    return html;
  }
  function parentHead(p) {
    var name = esc(p.name || p.username || "Unknown account");
    var handle = typeof p.username === "string" && p.username ? handleHtml(p.username) : "";
    return '<div class="meta"><span class="name">' + name + "</span>" + handle + timeHtml(p.created_at) + "</div>";
  }
  // One parent card. Quote/repost context is the embedded ref only — not another archive lookup.
  function parentPreview(parent) {
    var note = "";
    if (parent.kind === "repost") note = '<div class="marker">⟲ ' + esc(parent.name || parent.username || "Someone") + " reposted</div>";
    else if (parent.reply_to && typeof parent.reply_to === "object" && !Array.isArray(parent.reply_to) && parent.reply_to.username) {
      note = '<div class="marker">↩ Replying to ' + who(parent.reply_to.username) + "</div>";
    }
    return '<div class="quote parent">' + note + parentHead(parent) + postContent(parent, true) + "</div>";
  }
  function showParentButton(replyId, parentId, retry) {
    return '<button type="button" class="show-parent" data-reply="' + esc(replyId) + '" data-parent="' + esc(parentId) + '"' +
      (retry ? ' data-retry="1"' : "") + ">" + (retry ? "Try again" : "Show parent") + "</button>";
  }
  // Closed until the reader clicks. A click reveals archive/cache data in place, or asks for that one parent.
  function parentSlot(p) {
    var raw = p.reply_to;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return '<div class="quote parent missing"><div class="text missing">Original post isn\'t in this archive.</div></div>';
    }
    var t = replyTarget(p);
    var c = P.classify(p, state.archive || allPosts(), state.parents, Date.now());
    if (c.kind === "unlinked" || c.kind === "none") {
      return '<div class="quote parent missing"><div class="text missing">Original post isn\'t in this archive.</div></div>';
    }
    var id = String(p.id);
    if (state.shown[id] && c.kind === "ready") return parentPreview(c.post);
    if (state.shown[id] && c.kind === "unavailable") {
      var again = c.retry ? showParentButton(p.id, t.id, true) : "";
      return '<div class="quote parent missing"><div class="text missing">This post isn\'t available.</div>' + again + "</div>";
    }
    if (state.loading[id]) return '<div class="parent-slot"><div class="text missing">Loading parent…</div></div>';
    if (state.notes[id]) return '<div class="parent-slot"><div class="text missing">' + esc(state.notes[id]) + "</div>" + showParentButton(p.id, t.id, false) + "</div>";
    return '<div class="parent-slot">' + showParentButton(p.id, t.id, false) + "</div>";
  }

  function renderPost(p) {
    if (!p || typeof p !== "object") return "";
    var marker = "", m = p.metrics || {};
    if (p.kind === "repost") marker = '<div class="marker">⟲ ' + esc(p.name || p.username) + " reposted</div>";
    else if (p.reply_to) marker = '<div class="marker">↩ Replying to ' + who(p.reply_to && p.reply_to.username) + "</div>";
    var head = '<div class="meta"><span class="name">' + esc(p.name) + "</span>" + handleHtml(p.username) + timeHtml(p.created_at) + "</div>";
    var context = (p.kind !== "repost" && p.reply_to) ? parentSlot(p) : "";
    return '<li class="post">' + marker + context + head + postContent(p) +
      '<div class="foot"><span>' + num(m.replies) + " replies</span><span>" + num(m.reposts) + " reposts</span><span>" +
      num(m.likes) + " likes</span></div></li>";
  }

  function allPosts() { return combinedArchive(state.posts, state.saved); }

  // All shows every row. Posts matches X: original posts, quotes, and self-replies
  // (a reply whose reply_to.username matches the author, ignoring case). Replies to
  // other people and reposts stay on All.
  var VIEW_KEY = "xtext.view";
  var POSTS_EMPTY = "No posts here. Switch to All to see replies and reposts.";
  var viewMemory = { view: "all" };
  function normalizeView(v) {
    v = String(v == null ? "" : v).replace(/^\s+|\s+$/g, "").toLowerCase();
    return v === "posts" ? "posts" : "all";
  }
  function selfReply(p) {
    if (!p || p.kind !== "reply") return false;
    var rt = p.reply_to;
    if (!rt || typeof rt !== "object" || Array.isArray(rt) || typeof rt.username !== "string") return false;
    if (typeof p.username !== "string" || !p.username || !rt.username) return false;
    return rt.username.toLowerCase() === p.username.toLowerCase();
  }
  function showInPosts(p) {
    if (!p || typeof p !== "object") return false;
    if (p.kind === "post" || p.kind === "quote") return true;
    return selfReply(p);
  }
  function applyView(list, view) {
    var rows = list || [], out = [], i;
    if (normalizeView(view) !== "posts") return rows;
    for (i = 0; i < rows.length; i++) if (showInPosts(rows[i])) out.push(rows[i]);
    return out;
  }
  function postsViewEmpty(view, rawCount, shownCount) {
    return normalizeView(view) === "posts" && !shownCount && rawCount > 0;
  }
  function readView(storage, memory) {
    memory = memory || viewMemory;
    if (memory.held) return memory.view === "posts" ? "posts" : "all";
    try {
      if (!storage || typeof storage.getItem !== "function") return memory.view === "posts" ? "posts" : "all";
      var raw = storage.getItem(VIEW_KEY);
      if (raw == null || raw === "") return memory.view === "posts" ? "posts" : "all";
      memory.view = normalizeView(raw);
      return memory.view;
    } catch (e) {
      memory.held = true;
      return memory.view === "posts" ? "posts" : "all";
    }
  }
  function writeView(storage, view, memory) {
    memory = memory || viewMemory;
    memory.view = normalizeView(view);
    try {
      if (!storage || typeof storage.setItem !== "function") memory.held = true;
      else storage.setItem(VIEW_KEY, memory.view);
    } catch (e) {
      memory.held = true;
    }
    return memory.view;
  }
  function safeStorage() {
    try {
      if (typeof localStorage === "undefined") return null;
      return localStorage;
    } catch (e) {
      viewMemory.held = true;
      return null;
    }
  }
  function currentView() { return state.feedView === "posts" ? "posts" : "all"; }
  function menuItems() {
    var menu = $("viewMenu");
    if (!menu || !menu.querySelectorAll) return [];
    return Array.prototype.slice.call(menu.querySelectorAll("[data-view]"));
  }
  function syncViewControl() {
    var btn = $("viewBtn"), label = $("viewLabel"), empty = $("empty");
    if (!btn || !label) return;
    var text = currentView() === "posts" ? "Posts" : "All";
    label.textContent = text;
    btn.setAttribute("aria-label", "Showing " + text);
    var items = menuItems(), i;
    for (i = 0; i < items.length; i++) {
      items[i].setAttribute("aria-checked", items[i].getAttribute("data-view") === currentView() ? "true" : "false");
    }
    if (empty) empty.textContent = POSTS_EMPTY;
  }
  function closeViewMenu(focusBtn) {
    var menu = $("viewMenu"), btn = $("viewBtn");
    if (!menu || !btn) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (focusBtn) btn.focus();
  }
  function openViewMenu(which) {
    var menu = $("viewMenu"), btn = $("viewBtn");
    if (!menu || !btn) return;
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    var items = menuItems(), i, pick;
    if (!items.length) return;
    pick = which === "last" ? items[items.length - 1] : items[0];
    if (which !== "first" && which !== "last") {
      for (i = 0; i < items.length; i++) if (items[i].getAttribute("aria-checked") === "true") pick = items[i];
    }
    pick.focus();
  }
  function chooseView(view) {
    var next = normalizeView(view);
    var same = next === currentView();
    state.feedView = writeView(safeStorage(), next);
    syncViewControl();
    closeViewMenu(true);
    if (same) return;
    render(true);
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  function bindView() {
    var btn = $("viewBtn"), menu = $("viewMenu");
    if (!btn || !menu || btn.getAttribute("data-bound")) return;
    btn.setAttribute("data-bound", "1");
    btn.addEventListener("click", function () {
      if (menu.hidden) openViewMenu();
      else closeViewMenu(false);
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openViewMenu(e.key === "ArrowUp" ? "last" : "first");
      } else if (e.key === "Escape" && !menu.hidden) {
        e.preventDefault();
        closeViewMenu(false);
      }
    });
    menu.addEventListener("click", function (e) {
      var item = e.target && e.target.closest && e.target.closest("[data-view]");
      if (!item || !menu.contains(item)) return;
      chooseView(item.getAttribute("data-view"));
    });
    menu.addEventListener("keydown", function (e) {
      var items = menuItems(), i;
      if (!items.length) return;
      i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i <= 0 ? items.length : i) - 1].focus(); }
      else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); closeViewMenu(true); }
      else if (e.key === "Tab") closeViewMenu(false);
      else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        var item = e.target && e.target.closest && e.target.closest("[data-view]");
        if (item) chooseView(item.getAttribute("data-view"));
      }
    });
    document.addEventListener("click", function (e) {
      if (menu.hidden) return;
      var box = $("viewSwitch");
      if (box && box.contains(e.target)) return;
      closeViewMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) closeViewMenu(true);
    });
    syncViewControl();
  }

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, ""), qi = h.indexOf("?"), params = {};
    if (qi >= 0) { new URLSearchParams(h.slice(qi + 1)).forEach(function (v, k) { params[k] = v; }); h = h.slice(0, qi); }
    var parts = h.split("/").filter(Boolean).map(decodeURIComponent);
    return { view: parts[0] || "home", arg: parts[1] || "", q: params.q || "" };  // other params (e.g. old sort=top) ignored
  }
  function go(view, arg, q) {
    var h = "#/" + (view === "home" ? "" : view + (arg ? "/" + encodeURIComponent(arg) : ""));
    var sp = new URLSearchParams();
    if (q) sp.set("q", q);
    var s = sp.toString();
    location.hash = h + (s ? "?" + s : "");
  }

  function renderNav(r) {
    var tabs = '<a href="#/" class="' + (r.view === "home" ? "on" : "") + '">Following</a>';
    (state.config.saved_searches || []).forEach(function (s) {
      var slug = s.slug || slugify(s.name);
      tabs += '<a href="#/saved/' + encodeURIComponent(slug) + '" class="' + (r.view === "saved" && r.arg === slug ? "on" : "") + '">' + esc(s.name || slug) + "</a>";
    });
    if (r.view === "search") tabs += '<a class="on" href="' + esc(location.hash) + '">Search</a>';
    $("tabs").innerHTML = tabs;
    $("accounts").innerHTML = state.following.map(function (u) {
      var on = r.view === "u" && r.arg.toLowerCase() === u.username.toLowerCase();
      return '<a href="#/u/' + encodeURIComponent(u.username) + '" class="' + (on ? "on" : "") + '" title="' + esc(u.name) + '">@' + esc(u.username) + "</a>";
    }).join("");
  }

  function render(resetLimit) {
    var r = parseHash(), raw = [], label = "";
    var mode = currentView();
    var u = null, sv = null, cfg = null;
    if (resetLimit) state.limit = PAGE;
    renderNav(r);
    syncViewControl();
    if (document.activeElement !== $("q")) $("q").value = r.view === "search" ? r.q : "";
    if (r.view === "u") {
      u = state.following.filter(function (f) { return f.username.toLowerCase() === r.arg.toLowerCase(); })[0];
      raw = S.search(allPosts(), "from:" + r.arg + (r.q ? " " + r.q : ""));
    } else if (r.view === "search") {
      raw = S.search(allPosts(), r.q);
    } else if (r.view === "saved") {
      sv = state.saved[r.arg];
      raw = sv ? S.search(sv.posts || [], "") : [];
      cfg = (state.config.saved_searches || []).filter(function (s) { return (s.slug || slugify(s.name)) === r.arg; })[0] || {};
    } else {
      raw = S.search(state.posts, "");
    }
    // Filter before the count and the page, so Show more never lands on a hole of hidden replies or reposts.
    var list = applyView(raw, mode);
    if (r.view === "u") label = userHeader(u, r.arg, list.length);
    else if (r.view === "search") label = list.length + " result" + (list.length === 1 ? "" : "s") + " in " + allPosts().length + " saved posts";
    else if (r.view === "saved") label = "Saved search: <code>" + esc(cfg.query || (sv && sv.query) || r.arg) + "</code> · " + list.length + " posts" +
      (sv && sv.updated_at ? " · updated " + esc(when(sv.updated_at)) : " · not fetched yet");
    state.archive = allPosts(); // full archive, not the filtered or paged slice; parent cache stays out of it
    state.byId = indexPosts(state.archive);
    mediaStore = {};  // a re-render drops revealed media; every label starts hidden again
    mid = 0; tid = 0;
    if ((r.view === "search" || r.view === "u") && pendingShards().length) ensureShards();
    if ((r.view === "search" || r.view === "u") && !state.archiveComplete) label += " · loading older posts";
    var showEmpty = postsViewEmpty(mode, raw.length, list.length);
    var empty = $("empty");
    if (empty) empty.hidden = !showEmpty;
    $("status").innerHTML = label || (list.length || showEmpty ? "" : "No posts.");
    $("feed").innerHTML = list.slice(0, state.limit).map(renderPost).join("");
    var older = r.view === "home" ? pendingShards() : [];
    var paging = list.length > state.limit;
    $("more").hidden = !paging && !older.length;
    $("more").dataset.shard = !paging && older.length ? older[0].id : "";
    $("more").textContent = paging ? "Show more (" + (list.length - state.limit) + ")" : "Show older posts";
  }

  function bind() {
    $("searchForm").addEventListener("submit", function (e) {
      e.preventDefault();
      closeViewMenu(false);
      var q = $("q").value.trim();
      $("q").blur();
      if (q) go("search", "", q); else go("home", "", "");
    });
    $("more").addEventListener("click", function () {
      var id = $("more").dataset.shard;
      if (id) {
        var entry = shardById(state.index, id);
        $("more").disabled = true;
        loadOneShard(entry).then(function () { $("more").disabled = false; render(false); }, function () { $("more").disabled = false; });
        return;
      }
      state.limit += PAGE; render(false);
    });
    $("feed").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button");
      if (!b) return;
      if (b.classList.contains("show-parent")) { onShowParent(b); return; }
      if (b.classList.contains("expand")) (b.classList.contains("media-btn") ? toggleMedia : toggleText)(b);
    });
    window.addEventListener("hashchange", function () { closeViewMenu(false); render(true); window.scrollTo(0, 0); });
  }

  var fmtFull = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  // status line: "Last updated <local time> (<relative>) · N posts from M accounts" or "Never refreshed"
  function statusLine() {
    var m = state.meta || {};
    if (!m.updated_at && !state.posts.length) return "Never refreshed";
    var accounts = m.accounts != null ? m.accounts : Object.keys(state.posts.reduce(function (o, p) { o[p.username] = 1; return o; }, {})).length;
    var count = state.postCount || state.posts.length;
    return "Last updated " + (m.updated_at ? fmtFull.format(new Date(m.updated_at)) + " (" + ago(m.updated_at) + ")" : "unknown") +
      " · " + plural(count, "post") + " from " + plural(accounts, "account");
  }
  function showUpdated() {
    if (poll) return;  // "Refreshing…" stays while polling
    $("updated").textContent = statusLine();
    $("updated").title = (state.meta && state.meta.updated_at) || "";
  }

  // ------------------------------------------------------------------ data
  // Home reads the newest shard. Search and account pages pull older shards as needed.
  // The relay copy is tried first so a refresh shows up before GitHub Pages republishes.
  var DATA_RELAY = "https://x-text-relay.johnlichtenberg.workers.dev";
  var SHARD_FILE = /^(?:shards|parents)\/[0-9]{4}-[0-9]{2}(?:-p[1-9][0-9]{0,2})?\.json$/;
  var DATA_FILE = /^(?:index|site|following|posts|parents|gate)\.json$|^saved-searches\/[a-z0-9-]{1,80}\.json$/;
  function shardList(index) {
    var s = index && index.shards;
    if (!Array.isArray(s)) return [];
    return s.filter(function (x) { return x && typeof x.id === "string" && SHARD_FILE.test(x.file || ""); });
  }
  function homeShardIds(index) {
    var s = shardList(index);
    return s.length ? [s[0].id] : [];
  }
  function shardById(index, id) {
    var s = shardList(index);
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
    return null;
  }
  function pendingShards() {
    return shardList(state.index).filter(function (s) { return !state.loadedShards[s.id]; });
  }
  function relayOrigin() {
    var u = relayUrl();
    return u && /\/refresh$/.test(u) ? u.replace(/\/refresh$/, "") : DATA_RELAY;
  }
  function dataPathOk(rel) {
    var path = String(rel || "").replace(/^data\//, "");
    return DATA_FILE.test(path) || SHARD_FILE.test(path);
  }
  // ISO timestamps sort in time order. A newer last_run wins, then updated_at, then the index version.
  function indexStamp(text) {
    try {
      var doc = JSON.parse(text);
      var run = doc.last_run && typeof doc.last_run.at === "string" ? doc.last_run.at : "";
      return run + "\n" + (doc.updated_at || "") + "\n" + (doc.version || "");
    } catch (e) { return ""; }
  }
  function pickIndex(relayText, pagesText) {
    if (relayText && pagesText) return indexStamp(relayText) >= indexStamp(pagesText) ? relayText : pagesText;
    return relayText || pagesText || "";
  }
  // A relay-only tick must not replace a copy already applied from Pages with an older KV value.
  function keepNewer(candidate, previousText) {
    if (!candidate) return previousText || "";
    if (!previousText) return candidate;
    return indexStamp(candidate) < indexStamp(previousText) ? previousText : candidate;
  }
  function getText(url) {
    return fetch(url + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.text();
    });
  }
  function getJSON(url) { return getText(url).then(JSON.parse); }
  function relayData(rel) {
    if (!dataPathOk(rel)) return Promise.reject(new Error("path"));
    return fetch(relayOrigin() + "/d/" + String(rel).replace(/^data\//, ""), {
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
    }).then(function (r) {
      if (!r.ok) throw new Error("relay " + r.status);
      return r.text();
    });
  }
  function getFresh(rel) { return relayData(rel).catch(function () { return getText(rel); }); }
  // Relay every check (If-None-Match, 304 is empty). Pages at includePages, so a poll can spare GitHub.
  function readWatched(rel, includePages, previousText) {
    if (!sess.etags) sess.etags = {};
    if (!sess.relayText) sess.relayText = {};
    var headers = {};
    if (sess.etags[rel]) headers["If-None-Match"] = sess.etags[rel];
    var relay = dataPathOk(rel) ? fetch(relayOrigin() + "/d/" + String(rel).replace(/^data\//, ""), {
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", headers: headers
    }).then(function (r) {
      var etag = r.headers.get("etag") || sess.etags[rel] || "";
      if (r.status === 304) return { text: sess.relayText[rel] || previousText || "", etag: etag, hit: true };
      if (!r.ok) throw new Error("relay " + r.status);
      return r.text().then(function (text) { sess.relayText[rel] = text; return { text: text, etag: etag, hit: true }; });
    }).catch(function () { return null; }) : Promise.resolve(null);
    var pages = includePages ? getText(rel).catch(function () { return ""; }) : Promise.resolve("");
    return Promise.all([relay, pages]).then(function (both) {
      var fromRelay = both[0];
      var chosen = keepNewer(pickIndex(fromRelay && fromRelay.text, both[1]), previousText);
      if (fromRelay && fromRelay.hit && chosen && chosen === fromRelay.text) sess.etags[rel] = fromRelay.etag || sess.etags[rel];
      return chosen;
    });
  }
  // KV can lag for up to 60s at another edge. Take whichever index is newer, relay or Pages.
  function readIndexText(includePages) {
    return readWatched("data/index.json", includePages !== false, sess.watch || "");
  }
  function getFreshJSON(rel) { return getFresh(rel).then(JSON.parse); }
  function addPosts(list) {
    var seen = {};
    state.posts.forEach(function (p) { if (p && p.id) seen[p.id] = 1; });
    (list || []).forEach(function (p) {
      if (p && p.id && !seen[p.id]) { seen[p.id] = 1; state.posts.push(p); }
    });
    state.posts.sort(S.idCmp);
  }
  function loadShardPosts(entry) {
    return getFreshJSON("data/" + entry.file).then(function (doc) { return (doc && doc.posts) || []; });
  }
  function loadOneShard(entry) {
    if (!entry || state.loadedShards[entry.id]) return Promise.resolve();
    return loadShardPosts(entry).then(function (posts) {
      addPosts(posts);
      state.loadedShards[entry.id] = 1;
      state.archiveComplete = !pendingShards().length;
      state.archive = allPosts();
      state.byId = indexPosts(state.archive);
    });
  }
  var restJob = null;
  function ensureShards() {
    if (state.archiveComplete) return Promise.resolve();
    if (restJob) return restJob;
    var pending = pendingShards();
    if (!pending.length) { state.archiveComplete = true; return Promise.resolve(); }
    restJob = pending.reduce(function (chain, entry) {
      return chain.then(function () { return loadOneShard(entry).then(function () { render(false); }); });
    }, Promise.resolve()).then(function () {
      restJob = null;
      state.archiveComplete = true;
    }, function () { restJob = null; });
    return restJob;
  }
  function loadSaved(site) {
    return Promise.all((site.saved_searches || []).map(function (s) {
      var slug = s.slug || slugify(s.name);
      return getFreshJSON("data/saved-searches/" + encodeURIComponent(slug) + ".json")
        .then(function (d) { return [slug, d]; }, function () { return [slug, { posts: [] }]; });
    })).then(function (rows) {
      var saved = {};
      rows.forEach(function (pair) { saved[pair[0]] = pair[1]; });
      return saved;
    });
  }
  function loadParentBodies(doc, index) {
    if (doc && Array.isArray(doc.posts) && !doc.sharded) return Promise.resolve(doc);
    var shards = (index && index.parent_shards) || [];
    var files = shards.filter(function (s) { return s && SHARD_FILE.test(s.file || ""); });
    if (!files.length) return Promise.resolve(doc && Array.isArray(doc.posts) ? doc : { posts: [], missing: (doc && doc.missing) || [] });
    return Promise.all(files.map(function (s) {
      return getFreshJSON("data/" + s.file).then(function (d) { return d.posts || []; }, function () { return []; });
    })).then(function (lists) {
      var posts = [];
      lists.forEach(function (list) { posts = posts.concat(list); });
      return { updated_at: (index && index.updated_at) || (doc && doc.updated_at), posts: posts, missing: (doc && doc.missing) || [] };
    });
  }
  function loadLegacy(site, following, saved, parents) {
    return getFresh("data/posts.json").catch(function () { return null; }).then(function (text) {
      sess.watchRel = "data/posts.json";
      sess.watch = sess.text = text;
      applyData(site, following, text ? JSON.parse(text) : {}, saved, parents, null);
    });
  }
  // load everything. The relay is preferred; Pages is the fallback.
  function loadAll() {
    return getFreshJSON("data/site.json").catch(function () { return {}; }).then(function (site) {
      state.config = { site_title: site.site_title, saved_searches: site.saved_searches || [], refresh_url: site.refresh_url || "" };
      return Promise.all([
        getFreshJSON("data/following.json").catch(function () { return {}; }),
        readIndexText(),
        getFreshJSON("data/parents.json").catch(function () { return { posts: [], missing: [] }; }),
        loadSaved(site)
      ]).then(function (res) {
        var index = null;
        try { index = res[1] ? JSON.parse(res[1]) : null; } catch (e) { index = null; }
        if (!index || !Array.isArray(index.shards) || !shardList(index).length) return loadLegacy(site, res[0], res[3], res[2]);
        var home = shardList(index).filter(function (s) { return homeShardIds(index).indexOf(s.id) >= 0; });
        return Promise.all(home.map(loadShardPosts)).then(function (lists) {
          var flat = [];
          lists.forEach(function (list) { flat = flat.concat(list); });
          return loadParentBodies(res[2], index).then(function (parents) {
            sess.watchRel = "data/index.json";
            sess.watch = sess.text = res[1];
            applyData(site, res[0], {
              posts: flat, updated_at: index.updated_at, accounts: index.accounts, last_run: index.last_run, count: index.post_count
            }, res[3], parents, index);
          });
        }, function () { return loadLegacy(site, res[0], res[3], res[2]); });
      });
    });
  }

  function applyData(site, following, posts, saved, parents, index) {
    state.config = { site_title: site.site_title, saved_searches: site.saved_searches || [], refresh_url: site.refresh_url || "" };
    state.following = (following.users || []).slice().sort(function (a, c) { return (c.followers || 0) - (a.followers || 0); });
    state.posts = posts.posts || [];
    state.saved = saved;
    state.parents = P.doc(parents); // context cache only; never merged into the feed or following list
    state.index = index || null;
    state.loadedShards = {};
    if (index) homeShardIds(index).forEach(function (id) { state.loadedShards[id] = 1; });
    state.archiveComplete = !index || !pendingShards().length;
    state.postCount = (index && index.post_count) || state.posts.length;
    state.updated = posts.updated_at;
    state.meta = { updated_at: posts.updated_at || null, accounts: posts.accounts, last_run: posts.last_run || null };
    document.title = $("title").textContent = state.config.site_title || "X Text";
    if (!sess.bound) { bind(); sess.bound = true; setInterval(showUpdated, 60000); }
    showUpdated(); render(true);
  }

  // ------------------------------------------------------------------ refresh (via the relay)
  // The Refresh button POSTs to a small Cloudflare Worker relay (relay/ in the private working copy),
  // which holds the Grok Bot webhook URL and key; the page sends no key. URL from data/site.json
  // refresh_url, else RELAY_URL, e.g. "https://x-text-relay.<subdomain>.workers.dev/refresh".
  var RELAY_URL = "", poll = null;
  function relayUrl() {
    var u = (state.config && state.config.refresh_url) || RELAY_URL;
    return /^https:\/\/[^\s<>"']+$/.test(u) ? u : "";
  }
  function statusClass(err) { return "rstatus" + (err ? " err" : ""); }
  function rstatus(msg, err) { $("refreshStatus").textContent = msg; $("refreshStatus").className = statusClass(err); }

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } $("refreshBtn").disabled = false; showUpdated(); }

  // outcome of the run that wrote last_run (status written by merge.py on every manual run)
  function runMessage(run, before_n) {
    if (!run) return "Updated · " + plural(Math.max(0, state.posts.length - before_n), "new post");
    if (run.status === "skipped") return "Skipped: refreshed under 10 min ago";
    if (run.status === "no_new") return "No new posts";
    return plural(run.new_posts != null ? run.new_posts : Math.max(0, state.posts.length - before_n), "new post");
  }

  // Both polls stop after 3 min. The lookup can still be running, so the status keeps waiting
  // in the same neutral style. stopPoll re-enables Refresh; a later tap or a reload starts over.
  var POLL_LIMIT_MS = 180000;
  function pollExpired(started, now) { return now - started > POLL_LIMIT_MS; }
  function refreshTimeoutStatus() {
    return {
      message: "Still refreshing… a big catch-up can take a few minutes. Reload the page in a minute to see new posts.",
      error: false
    };
  }
  function parentTimeoutNote() {
    return "Still loading this parent… a slow lookup can take a few minutes. Reload the page in a minute to see it.";
  }

  function startPoll() {
    var started = Date.now(), before = sess.watch, seen = sess.watch, before_n = state.postCount || state.posts.length,
      before_run = JSON.stringify((state.meta && state.meta.last_run) || null), inflight = false, lastPages = 0;
    if (poll) clearInterval(poll);
    $("refreshBtn").disabled = true;
    poll = setInterval(tick, 1000);
    $("updated").textContent = "Refreshing…";
    function tick() {
      if (pollExpired(started, Date.now())) {
        var waiting = refreshTimeoutStatus();
        stopPoll();
        rstatus(waiting.message, waiting.error);
        return;
      }
      if (inflight) return;
      inflight = true;
      var now = Date.now(), wantPages = !lastPages || now - lastPages >= 5000;
      if (wantPages) lastPages = now;
      var rel = sess.watchRel === "data/posts.json" ? "data/posts.json" : "data/index.json";
      readWatched(rel, wantPages, seen).then(function (text) {
        inflight = false;
        if (!poll || !text) return;
        if (indexStamp(text) < indexStamp(seen || "")) return;
        seen = text;
        if (text === before) return;
        var doc;
        try { doc = JSON.parse(text); } catch (e) { return; }
        if (JSON.stringify(doc.last_run || null) === before_run && doc.updated_at === (state.meta && state.meta.updated_at)) return;
        clearInterval(poll); poll = null;
        return loadAll().then(function () { stopPoll(); rstatus(runMessage(doc.last_run, before_n)); });
      }, function () { inflight = false; });
    }
  }

  function sendRefresh() {
    var url = relayUrl();
    if (!url) { rstatus("Refresh isn't set up yet"); return; }
    $("refreshBtn").disabled = true;
    rstatus("Sending refresh…");
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refresh", source: "x-text" }),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
      if (r.ok) { rstatus("Refreshing…"); startPoll(); }
      else { stopPoll(); rstatus("Refresh failed: HTTP " + r.status + (r.status === 429 ? " (just requested; try again in a few minutes)" : r.status === 502 || r.status === 504 ? " (the Grok Bot webhook did not accept it)" : ""), true); }
    }, function () {
      stopPoll();
      rstatus(navigator.onLine ? "Refresh failed: could not reach the refresh relay." : "Refresh failed: you are offline.", true);
    });
  }

  // ------------------------------------------------------------------ parents (click only)
  // Show parent reveals a post already in the archive or data/parents.json with no relay call.
  // Only an uncached parent is queued, and several clicks in the same moment share one request.
  var parentQueue = [], parentTimer = null, parentFlight = false, parentPoll = null;

  function onShowParent(btn) {
    var replyId = btn.getAttribute("data-reply"), parentId = btn.getAttribute("data-parent");
    var retry = btn.getAttribute("data-retry") === "1";
    if (!P.isId(replyId) || !P.isId(parentId)) return;
    var post = (state.byId || {})[replyId];
    if (!post) return;
    var decision = P.parentClick(post, state.archive || allPosts(), state.parents, Date.now(), retry);
    if (decision.effect === "reveal" || decision.effect === "unavailable") {
      state.shown[replyId] = 1;
      delete state.loading[replyId];
      delete state.notes[replyId];
      render(false);
      return;
    }
    if (decision.effect === "enqueue" && !state.archiveComplete && !state.parentScan[replyId]) {
      state.parentScan[replyId] = 1;
      state.loading[replyId] = 1;
      render(false);
      ensureShards().then(function () {
        delete state.loading[replyId];
        var againPost = (state.byId || {})[replyId];
        if (!againPost) { render(false); return; }
        var again = P.parentClick(againPost, state.archive || allPosts(), state.parents, Date.now(), retry);
        if (again.effect === "reveal" || again.effect === "unavailable") {
          state.shown[replyId] = 1;
          delete state.loading[replyId];
          render(false);
          return;
        }
        if (again.effect !== "enqueue") { render(false); return; }
        state.loading[replyId] = 1;
        parentQueue = P.pushPair(parentQueue, again.pair);
        render(false);
        if (!parentTimer && !parentFlight) parentTimer = setTimeout(flushParents, 300);
      });
      return;
    }
    if (decision.effect !== "enqueue") return;
    delete state.notes[replyId];
    state.loading[replyId] = 1;
    parentQueue = P.pushPair(parentQueue, decision.pair);
    render(false);
    if (!parentTimer && !parentFlight) parentTimer = setTimeout(flushParents, 300);
  }

  function parentMessage(status, body) {
    if (status === 404 || status === 500 || status === 503) return "Parent fetch isn't set up yet.";
    if (status === 429) return "Parent fetch is limited. Try again" + (body && body.retry_after ? " in " + body.retry_after + " s" : " later") + ".";
    if (status === 403 || status === 400 || status === 413) return "That parent can't be requested.";
    if (status === 502 || status === 504) return "Parent fetch didn't start. Try again later.";
    return "Couldn't load this parent.";
  }

  function settlePair(pair, note) {
    delete state.loading[pair.reply_id];
    if (note) state.notes[pair.reply_id] = note;
    else state.shown[pair.reply_id] = 1;
  }

  function reloadParents(includePages) {
    return readWatched("data/parents.json", includePages !== false, sess.parentsText || "").then(function (text) {
      if (!text || text === sess.parentsText) return false;
      sess.parentsText = text;
      state.parents = P.doc(JSON.parse(text));
      return true;
    }, function () { return false; });
  }

  function stopParentPoll() { if (parentPoll) { clearInterval(parentPoll); parentPoll = null; } }

  function startParentPoll(pairs) {
    var started = Date.now(), inflight = false, lastPages = 0;
    stopParentPoll();
    parentPoll = setInterval(function () {
      if (pollExpired(started, Date.now())) {
        stopParentPoll();
        var note = parentTimeoutNote();
        pairs.forEach(function (pair) {
          if (!state.loading[pair.reply_id]) return;
          delete state.loading[pair.reply_id];
          state.notes[pair.reply_id] = note;
        });
        render(false);
        return;
      }
      if (inflight) return;
      inflight = true;
      var now = Date.now(), wantPages = !lastPages || now - lastPages >= 5000;
      if (wantPages) lastPages = now;
      reloadParents(wantPages).then(function () {
        inflight = false;
        if (!parentPoll) return;
        var waiting = false, settled = false;
        pairs.forEach(function (pair) {
          if (!state.loading[pair.reply_id]) return;
          var post = (state.byId || {})[pair.reply_id];
          var c = post ? P.classify(post, state.archive || [], state.parents, Date.now()) : { kind: "fetch" };
          if (c.kind === "ready" || c.kind === "unavailable") { settlePair(pair, ""); settled = true; }
          else waiting = true;
        });
        if (!waiting) stopParentPoll();
        if (settled || !waiting) render(false);
      }, function () { inflight = false; });
    }, 1000);
  }

  function afterParentFlight() {
    parentFlight = false;
    if (parentQueue.length && !parentTimer) parentTimer = setTimeout(flushParents, 300);
  }

  function flushParents() {
    parentTimer = null;
    if (parentFlight || !parentQueue.length) return;
    var taken = P.takeBatch(parentQueue);
    parentQueue = taken.rest;
    var batch = taken.batch;
    if (!batch.length) return;
    var url = P.parentURL(relayUrl());
    if (!url) {
      batch.forEach(function (pair) { settlePair(pair, "Parent fetch isn't set up yet."); });
      render(false);
      afterParentFlight();
      return;
    }
    parentFlight = true;
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(P.requestBody(batch)),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body }; });
    }).then(function (res) {
      var st = res.body && res.body.status;
      var effect = P.relayEffect(res.status, st);
      if (effect === "poll" || effect === "reload") {
        return reloadParents().then(function () {
          var waiting = [];
          batch.forEach(function (pair) {
            var post = (state.byId || {})[pair.reply_id];
            var c = post ? P.classify(post, state.archive || [], state.parents, Date.now()) : { kind: "fetch" };
            if (c.kind === "ready" || c.kind === "unavailable") settlePair(pair, "");
            else waiting.push(pair); // published file not updated yet, or the wake is still in flight
          });
          if (waiting.length) startParentPoll(waiting);
          render(false);
        });
      }
      var msg = parentMessage(res.status, res.body);
      batch.forEach(function (pair) { settlePair(pair, msg); });
      render(false);
    }, function () {
      var msg = navigator.onLine ? "Couldn't reach the parent relay." : "You are offline.";
      batch.forEach(function (pair) { settlePair(pair, msg); });
      render(false);
    }).then(afterParentFlight, afterParentFlight);
  }

  // ------------------------------------------------------------------ start
  function boot() {
    state.feedView = readView(safeStorage());
    bindView();
    $("refreshBtn").addEventListener("click", sendRefresh);
    loadAll().catch(function (e) {
      $("updated").textContent = "Never refreshed";
      $("status").textContent = "Could not load data: " + e.message;
    });
  }

  // Visible rows against a full archive. Parents outside the filter or page still resolve.
  function renderList(list, archive, following, opts) {
    opts = opts || {};
    var saved = { following: state.following, byId: state.byId, archive: state.archive, parents: state.parents,
      shown: state.shown, loading: state.loading, notes: state.notes, mediaStore: mediaStore, mid: mid, tid: tid };
    state.following = following || [];
    state.archive = archive || [];
    state.byId = indexPosts(state.archive);
    state.parents = P.doc(opts.parents);
    state.shown = {};
    (opts.shown || []).forEach(function (id) { if (P.isId(id)) state.shown[id] = 1; });
    state.loading = {};
    (opts.loading || []).forEach(function (id) { if (P.isId(id)) state.loading[id] = 1; });
    state.notes = opts.notes || {};
    mediaStore = {};
    mid = 0;
    tid = 0;
    try { return (list || []).map(renderPost).join(""); }
    finally {
      state.following = saved.following;
      state.byId = saved.byId;
      state.archive = saved.archive;
      state.parents = saved.parents;
      state.shown = saved.shown;
      state.loading = saved.loading;
      state.notes = saved.notes;
      mediaStore = saved.mediaStore;
      mid = saved.mid;
      tid = saved.tid;
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderList: renderList, indexPosts: indexPosts, combinedArchive: combinedArchive, userHeader: userHeader,
      parentClick: P.parentClick, homeShardIds: homeShardIds, shardList: shardList, dataPathOk: dataPathOk,
      indexStamp: indexStamp, pickIndex: pickIndex, keepNewer: keepNewer, statusClass: statusClass,
      pollExpired: pollExpired, refreshTimeoutStatus: refreshTimeoutStatus, parentTimeoutNote: parentTimeoutNote,
      pickVideoURL: pickVideoURL, mediaEl: mediaEl, applyView: applyView, readView: readView, writeView: writeView,
      postsViewEmpty: postsViewEmpty, VIEW_KEY: VIEW_KEY, POSTS_EMPTY: POSTS_EMPTY };
  } else boot();
})(typeof window !== "undefined" ? window : this);
