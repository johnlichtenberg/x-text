/* X Text: text-only static reader. Loads data/site.json + data/*.json, hash-routed views. */
(function (root) {
  "use strict";
  var S = (typeof module !== "undefined" && module.exports) ? require("./search.js") : root.XSearch;
  var P = (typeof module !== "undefined" && module.exports) ? require("./parent.js") : root.XParent;
  var state = { config: { saved_searches: [] }, following: [], posts: [], saved: {}, updated: null, limit: 50, byId: {},
    parents: { posts: [], missing: [] }, shown: {}, loading: {}, notes: {} };
  var sess = { text: null, bound: false };  // text of the last loaded data/posts.json (for refresh polling)
  var $ = function (id) { return document.getElementById(id); };
  var PAGE = 50;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Escape, then turn http(s) URLs into plain links (no previews/media).
  function linkify(text) {
    var out = "", re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
    while ((m = re.exec(text))) {
      var url = m[0].replace(/[.,;:!?)\]]+$/, "");
      out += esc(text.slice(last, m.index));
      out += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(url.replace(/^https?:\/\//, "")) + "</a>";
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
  function extLink(u) { return '<a href="https://x.com/' + encodeURIComponent(u) + '" target="_blank" rel="noopener noreferrer">@' + esc(u) + "</a>"; }

  function known(u) { return state.following.some(function (f) { return f.username.toLowerCase() === (u || "").toLowerCase(); }); }
  function who(u) { return u ? (known(u) ? userLink(u) : extLink(u)) : "a post"; }
  // Status ids are decimal snowflakes. Handles use X's username charset. Anything else is not a specific post link.
  function statusURL(id, username) {
    if (typeof id !== "string" || !/^[0-9]{1,25}$/.test(id)) return "";
    var u = typeof username === "string" && /^[A-Za-z0-9_]{1,15}$/.test(username) ? username : "";
    return u ? "https://x.com/" + encodeURIComponent(u) + "/status/" + id : "https://x.com/i/status/" + id;
  }
  function safePostURL(p) {
    var u = p && p.url;
    if (typeof u === "string" && /^https:\/\/(x|twitter)\.com\/[^\s<>"']+$/.test(u)) return u;
    return statusURL(typeof p.id === "string" ? p.id : "", p && p.username);
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
  // Author of a quoted/reposted original: name + @username, no x.com link (followed accounts link in-site).
  function refMeta(r) {
    var u = r.username || "";
    return '<div class="meta"><span class="name">' + esc(r.name || u || "Unknown account") + "</span>" +
      (u ? (known(u) ? userLink(u) : '<span class="handle">@' + esc(u) + "</span>") : "") +
      (r.created_at ? '<span>·</span><span title="' + esc(r.created_at) + '">' + esc(when(r.created_at)) + "</span>" : "") + "</div>";
  }
  function articleLine(t) { return t ? '<div class="article">Article: ' + esc(t) + "</div>" : ""; }
  // The original shown inline: author, full text, and the post it quotes (one level), never a link to it.
  // depth caps a cyclic or very deep quote chain: this post, plus the one post it quotes.
  function refBlock(r, text, label, media, depth) {
    if (!r || typeof r !== "object") return "";
    depth = depth || 0;
    if (depth >= 2) return "";
    var nested = "";
    var q = r.quote;
    if (depth < 1 && q && typeof q === "object" && q !== r) {
      var same = r.id != null && q.id != null && String(r.id) === String(q.id);
      if (!same) nested = refBlock(q, typeof q.text === "string" ? q.text : "", "❝ Quoting", undefined, depth + 1);
    }
    var body = typeof text === "string" && text ? textBlock(text) : '<div class="text missing">Text not available.</div>';
    return '<div class="quote">' + (label ? '<div class="marker">' + label + "</div>" : "") + refMeta(r) +
      articleLine(r.article_title) + body +
      mediaBlock(media === undefined ? r.media : media, r.username) + nested + "</div>";
  }

  // Hidden media: only a label button is rendered. The original URL stays in this JS map (never in the DOM).
  // On tap, mediaURL() turns an allowed path into the relay URL and that is what the <img>/<video> requests.
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
  function mediaEl(m, i, n, username) {
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
      var vsrc = S.mediaURL(m.url, "video");
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
      list.forEach(function (m, i) { var el = mediaEl(m, i, list.length, st.username); if (el) box.appendChild(el); });
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
  function textBlock(text) {
    var pv = S.preview(text);
    if (!pv) return '<div class="text">' + linkify(text) + "</div>";
    var id = "t" + (++tid);
    return '<div class="text" id="' + id + '"><span class="pv">' + linkify(pv) + '</span><span class="full" hidden>' + linkify(text) +
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
      return refBlock(r, p.text, "", p.media, 0);
    }
    var textHtml = typeof p.text === "string" && p.text ? textBlock(p.text)
      : (forParent ? '<div class="text missing">Text not available.</div>' : textBlock(p.text));
    var html = articleLine(p.article_title) + textHtml + mediaBlock(p.media, p.username);
    if (p.kind === "quote" && p.ref && typeof p.ref === "object" && !Array.isArray(p.ref) && p.ref !== p) html += refBlock(p.ref, p.ref.text, "❝ Quoting", undefined, 0);
    return html;
  }
  function parentHead(p) {
    var name = esc(p.name || p.username || "Unknown account");
    var handle = typeof p.username === "string" && p.username ? userLink(p.username) : "";
    var whenHtml = "";
    if (p.created_at) {
      var href = safePostURL(p);
      var label = esc(when(p.created_at));
      whenHtml = href
        ? '<span>·</span><a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" title="' + esc(p.created_at) + '">' + label + "</a>"
        : '<span>·</span><span title="' + esc(p.created_at) + '">' + label + "</span>";
    }
    return '<div class="meta"><span class="name">' + name + "</span>" + handle + whenHtml + "</div>";
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
  function originalLink(id, username) {
    var href = statusURL(id, username);
    return href ? '<a class="parent-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">View original post</a>' : "";
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
      var href = t ? originalLink(t.id, t.username) : "";
      return '<div class="quote parent missing"><div class="text missing">Original post isn\'t in this archive.</div>' + href + "</div>";
    }
    var id = String(p.id);
    if (state.shown[id] && c.kind === "ready") return parentPreview(c.post);
    if (state.shown[id] && c.kind === "unavailable") {
      var again = c.retry ? showParentButton(p.id, t.id, true) : "";
      return '<div class="quote parent missing"><div class="text missing">This post isn\'t available.</div>' +
        originalLink(t.id, t.username) + again + "</div>";
    }
    var link = originalLink(t.id, t.username);
    if (state.loading[id]) return '<div class="parent-slot"><div class="text missing">Loading parent…</div>' + link + "</div>";
    if (state.notes[id]) return '<div class="parent-slot"><div class="text missing">' + esc(state.notes[id]) + "</div>" + showParentButton(p.id, t.id, false) + link + "</div>";
    return '<div class="parent-slot">' + showParentButton(p.id, t.id, false) + link + "</div>";
  }

  function renderPost(p) {
    if (!p || typeof p !== "object") return "";
    var marker = "", m = p.metrics || {};
    if (p.kind === "repost") marker = '<div class="marker">⟲ ' + esc(p.name || p.username) + " reposted</div>";
    else if (p.reply_to) marker = '<div class="marker">↩ Replying to ' + who(p.reply_to && p.reply_to.username) + "</div>";
    var head = '<div class="meta"><span class="name">' + esc(p.name) + "</span>" + userLink(p.username) +
      '<span>·</span><a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(p.created_at) + '">' + esc(when(p.created_at)) + "</a></div>";
    var context = (p.kind !== "repost" && p.reply_to) ? parentSlot(p) : "";
    return '<li class="post">' + marker + context + head + postContent(p) +
      '<div class="foot"><span>' + num(m.replies) + " replies</span><span>" + num(m.reposts) + " reposts</span><span>" +
      num(m.likes) + " likes</span></div></li>";
  }

  function allPosts() { return combinedArchive(state.posts, state.saved); }

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
    var r = parseHash(), list, label = "";
    if (resetLimit) state.limit = PAGE;
    renderNav(r);
    if (document.activeElement !== $("q")) $("q").value = r.view === "search" ? r.q : "";
    if (r.view === "u") {
      var u = state.following.filter(function (f) { return f.username.toLowerCase() === r.arg.toLowerCase(); })[0];
      list = S.search(allPosts(), "from:" + r.arg + (r.q ? " " + r.q : ""));
      label = (u ? esc(u.name) + " " : "") + extLink(r.arg) + " · " + list.length + " saved posts" + (u && u.description ? '<br><span>' + linkify(u.description) + "</span>" : "");
    } else if (r.view === "search") {
      list = S.search(allPosts(), r.q);
      label = list.length + " result" + (list.length === 1 ? "" : "s") + " in " + allPosts().length + " saved posts";
    } else if (r.view === "saved") {
      var sv = state.saved[r.arg];
      list = sv ? S.search(sv.posts || [], "") : [];
      var cfg = (state.config.saved_searches || []).filter(function (s) { return (s.slug || slugify(s.name)) === r.arg; })[0] || {};
      label = "Saved search: <code>" + esc(cfg.query || (sv && sv.query) || r.arg) + "</code> · " + list.length + " posts" +
        (sv && sv.updated_at ? " · updated " + esc(when(sv.updated_at)) : " · not fetched yet");
    } else {
      list = S.search(state.posts, "");
    }
    $("status").innerHTML = label || (list.length ? "" : "No posts.");
    state.archive = allPosts(); // full archive, not the filtered or paged slice; parent cache stays out of it
    state.byId = indexPosts(state.archive);
    mediaStore = {};  // a re-render drops revealed media; every label starts hidden again
    mid = 0; tid = 0;
    $("feed").innerHTML = list.slice(0, state.limit).map(renderPost).join("");
    $("more").hidden = list.length <= state.limit;
    $("more").textContent = "Show more (" + (list.length - state.limit) + ")";
  }

  function bind() {
    $("searchForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var q = $("q").value.trim();
      $("q").blur();
      if (q) go("search", "", q); else go("home", "", "");
    });
    $("more").addEventListener("click", function () { state.limit += PAGE; render(false); });
    $("feed").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button");
      if (!b) return;
      if (b.classList.contains("show-parent")) { onShowParent(b); return; }
      if (b.classList.contains("expand")) (b.classList.contains("media-btn") ? toggleMedia : toggleText)(b);
    });
    window.addEventListener("hashchange", function () { render(true); window.scrollTo(0, 0); });
  }

  var fmtFull = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  // status line: "Last updated <local time> (<relative>) · N posts from M accounts" or "Never refreshed"
  function statusLine() {
    var m = state.meta || {};
    if (!m.updated_at && !state.posts.length) return "Never refreshed";
    var accounts = m.accounts != null ? m.accounts : Object.keys(state.posts.reduce(function (o, p) { o[p.username] = 1; return o; }, {})).length;
    return "Last updated " + (m.updated_at ? fmtFull.format(new Date(m.updated_at)) + " (" + ago(m.updated_at) + ")" : "unknown") +
      " · " + plural(state.posts.length, "post") + " from " + plural(accounts, "account");
  }
  function showUpdated() {
    if (poll) return;  // "Refreshing…" stays while polling
    $("updated").textContent = statusLine();
    $("updated").title = (state.meta && state.meta.updated_at) || "";
  }

  // ------------------------------------------------------------------ data
  function getText(url) {
    return fetch(url + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.text();
    });
  }
  function getJSON(url) { return getText(url).then(JSON.parse); }

  // load everything; postsText (already fetched) avoids a second download when polling
  function loadAll(postsText) {
    return Promise.all([getJSON("data/site.json").catch(function () { return {}; }), getJSON("data/following.json").catch(function () { return {}; }),
      postsText ? Promise.resolve(postsText) : getText("data/posts.json").catch(function () { return null; }),
      getJSON("data/parents.json").catch(function () { return { posts: [], missing: [] }; })]).then(function (res) {
      var site = res[0];
      sess.text = res[2];
      var posts = res[2] ? JSON.parse(res[2]) : {}, saved = {};
      return Promise.all((site.saved_searches || []).map(function (s) {
        var slug = s.slug || slugify(s.name);
        return getJSON("data/saved-searches/" + encodeURIComponent(slug) + ".json")
          .then(function (d) { saved[slug] = d; }, function () { saved[slug] = { posts: [] }; });
      })).then(function () { applyData(site, res[1], posts, saved, res[3]); });
    });
  }

  function applyData(site, following, posts, saved, parents) {
    state.config = { site_title: site.site_title, saved_searches: site.saved_searches || [], refresh_url: site.refresh_url || "" };
    state.following = (following.users || []).slice().sort(function (a, c) { return (c.followers || 0) - (a.followers || 0); });
    state.posts = posts.posts || [];
    state.saved = saved;
    state.parents = P.doc(parents); // context cache only; never merged into the feed or following list
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
  function rstatus(msg, err) { $("refreshStatus").textContent = msg; $("refreshStatus").className = "rstatus" + (err ? " err" : ""); }

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } $("refreshBtn").disabled = false; showUpdated(); }

  // outcome of the run that wrote last_run (status written by merge.py on every manual run)
  function runMessage(run, before_n) {
    if (!run) return "Updated · " + plural(Math.max(0, state.posts.length - before_n), "new post");
    if (run.status === "skipped") return "Skipped: refreshed under 10 min ago";
    if (run.status === "no_new") return "No new posts";
    return plural(run.new_posts != null ? run.new_posts : Math.max(0, state.posts.length - before_n), "new post");
  }

  function startPoll() {
    var started = Date.now(), before = sess.text, before_n = state.posts.length,
      before_run = JSON.stringify((state.meta && state.meta.last_run) || null);
    if (poll) clearInterval(poll);
    $("refreshBtn").disabled = true;
    poll = setInterval(tick, 20000);
    $("updated").textContent = "Refreshing…";
    function tick() {
      if (Date.now() - started > 180000) { stopPoll(); rstatus("No response after 3 min: the refresh may still be running. Tap Refresh again later."); return; }
      getText("data/posts.json").then(function (text) {
        if (text === before) return;
        var doc = JSON.parse(text);
        if (JSON.stringify(doc.last_run || null) === before_run && doc.updated_at === (state.meta && state.meta.updated_at)) return;
        clearInterval(poll); poll = null;
        return loadAll(text).then(function () { stopPoll(); rstatus(runMessage(doc.last_run, before_n)); });
      }).catch(function () { /* transient; keep polling */ });
    }
  }

  function sendRefresh() {
    var url = relayUrl();
    if (!url) { rstatus("Refresh isn't set up yet"); return; }
    $("refreshBtn").disabled = true;
    rstatus("Sending refresh…");
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refresh", source: "x-text" }),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
      if (r.ok) { rstatus("Refresh sent. Checking every 20 s for up to 3 min."); startPoll(); }
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

  function reloadParents() {
    return getJSON("data/parents.json").then(function (doc) { state.parents = P.doc(doc); }, function () {});
  }

  function stopParentPoll() { if (parentPoll) { clearInterval(parentPoll); parentPoll = null; } }

  function startParentPoll(pairs) {
    var started = Date.now();
    stopParentPoll();
    parentPoll = setInterval(function () {
      if (Date.now() - started > 180000) {
        stopParentPoll();
        pairs.forEach(function (pair) {
          if (!state.loading[pair.reply_id]) return;
          delete state.loading[pair.reply_id];
          state.notes[pair.reply_id] = "No parent yet. It may still be saving. Try again later.";
        });
        render(false);
        return;
      }
      reloadParents().then(function () {
        var waiting = false;
        pairs.forEach(function (pair) {
          if (!state.loading[pair.reply_id]) return;
          var post = (state.byId || {})[pair.reply_id];
          var c = post ? P.classify(post, state.archive || [], state.parents, Date.now()) : { kind: "fetch" };
          if (c.kind === "ready" || c.kind === "unavailable") settlePair(pair, "");
          else waiting = true;
        });
        if (!waiting) stopParentPoll();
        render(false);
      });
    }, 20000);
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
    module.exports = { renderList: renderList, indexPosts: indexPosts, combinedArchive: combinedArchive, statusURL: statusURL, parentClick: P.parentClick };
  } else boot();
})(typeof window !== "undefined" ? window : this);
