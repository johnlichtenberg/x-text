/* X Text: text-only static reader. Loads data/site.json + data/*.json, hash-routed views. */
(function () {
  "use strict";
  var S = window.XSearch;
  var state = { config: { saved_searches: [] }, following: [], posts: [], saved: {}, updated: null, limit: 50 };
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
  // Author of a quoted/reposted original: name + @username, no x.com link (followed accounts link in-site).
  function refMeta(r) {
    var u = r.username || "";
    return '<div class="meta"><span class="name">' + esc(r.name || u || "Unknown account") + "</span>" +
      (u ? (known(u) ? userLink(u) : '<span class="handle">@' + esc(u) + "</span>") : "") +
      (r.created_at ? '<span>·</span><span title="' + esc(r.created_at) + '">' + esc(when(r.created_at)) + "</span>" : "") + "</div>";
  }
  function articleLine(t) { return t ? '<div class="article">Article: ' + esc(t) + "</div>" : ""; }
  // The original shown inline: author, full text, and the post it quotes (one level), never a link to it.
  function refBlock(r, text, label, media) {
    return '<div class="quote">' + (label ? '<div class="marker">' + label + "</div>" : "") + refMeta(r) +
      articleLine(r.article_title) +
      (text ? textBlock(text) : '<div class="text missing">Text not available.</div>') +
      mediaBlock(media === undefined ? r.media : media, r.username) +
      (r.quote ? refBlock(r.quote, r.quote.text, "❝ Quoting") : "") + "</div>";
  }

  // Hidden media: only a label button is rendered. Media URLs stay in this JS map (never in the DOM) and the
  // <img>/<video> elements are created on tap, so nothing loads from X's media servers until then.
  var mediaStore = {}, mid = 0;
  function mediaBlock(media, username) {
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

  function renderPost(p) {
    var marker = "", m = p.metrics || {};
    if (p.kind === "repost") marker = '<div class="marker">⟲ ' + esc(p.name || p.username) + " reposted</div>";
    else if (p.reply_to) marker = '<div class="marker">↩ Replying to ' + who(p.reply_to.username) + "</div>";
    var head = '<div class="meta"><span class="name">' + esc(p.name) + "</span>" + userLink(p.username) +
      '<span>·</span><a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(p.created_at) + '">' + esc(when(p.created_at)) + "</a></div>";
    var html = '<li class="post">' + marker + head;
    if (p.kind === "repost") {
      var r = Object.assign({}, p.ref || {}, { article_title: p.article_title });
      html += refBlock(r, p.text, "", p.media);
    } else {
      html += articleLine(p.article_title) + textBlock(p.text) + mediaBlock(p.media, p.username);
      if (p.kind === "quote" && p.ref) html += refBlock(p.ref, p.ref.text, "❝ Quoting");
    }
    html += '<div class="foot"><span>' + num(m.replies) + " replies</span><span>" + num(m.reposts) + " reposts</span><span>" +
      num(m.likes) + " likes</span></div></li>";
    return html;
  }

  function allPosts() { // main archive + saved-search posts, deduped
    var seen = {}, out = [];
    state.posts.concat.apply(state.posts, Object.keys(state.saved).map(function (k) { return state.saved[k].posts || []; }))
      .forEach(function (p) { if (!seen[p.id]) { seen[p.id] = 1; out.push(p); } });
    return out;
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
    mediaStore = {};  // a re-render drops revealed media; every label starts hidden again
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
      var b = e.target.closest && e.target.closest("button.expand");
      if (b) (b.classList.contains("media-btn") ? toggleMedia : toggleText)(b);
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
      postsText ? Promise.resolve(postsText) : getText("data/posts.json").catch(function () { return null; })]).then(function (res) {
      var site = res[0];
      sess.text = res[2];
      var posts = res[2] ? JSON.parse(res[2]) : {}, saved = {};
      return Promise.all((site.saved_searches || []).map(function (s) {
        var slug = s.slug || slugify(s.name);
        return getJSON("data/saved-searches/" + encodeURIComponent(slug) + ".json")
          .then(function (d) { saved[slug] = d; }, function () { saved[slug] = { posts: [] }; });
      })).then(function () { applyData(site, res[1], posts, saved); });
    });
  }

  function applyData(site, following, posts, saved) {
    state.config = { site_title: site.site_title, saved_searches: site.saved_searches || [] };
    state.following = (following.users || []).slice().sort(function (a, c) { return (c.followers || 0) - (a.followers || 0); });
    state.posts = posts.posts || [];
    state.saved = saved;
    state.updated = posts.updated_at;
    state.meta = { updated_at: posts.updated_at || null, accounts: posts.accounts, last_run: posts.last_run || null };
    document.title = $("title").textContent = state.config.site_title || "X Text";
    if (!sess.bound) { bind(); sess.bound = true; setInterval(showUpdated, 60000); }
    showUpdated(); render(true);
  }

  // ------------------------------------------------------------------ refresh webhook
  var WH_STORE = "xtext.webhook", poll = null;
  function whGet() { try { return JSON.parse(localStorage.getItem(WH_STORE) || "null"); } catch (e) { return null; } }
  function rstatus(msg, err) { $("refreshStatus").textContent = msg; $("refreshStatus").className = "rstatus" + (err ? " err" : ""); }

  function openSettings() {
    var c = whGet() || {};
    $("whUrl").value = c.url || "";
    $("whKey").value = c.key || "";
    $("settings").showModal();
  }
  function settingsSubmit(e) {
    e.preventDefault();
    var action = e.submitter ? e.submitter.value : "save";
    if (action === "save") {
      var url = $("whUrl").value.trim();
      var key = $("whKey").value;
      if (!/^https:\/\//i.test(url)) { alert("Webhook URL must start with https://"); return; }
      if (key && url.indexOf(key) >= 0) { alert("Remove the key from the URL: it is sent only in the Authorization header."); return; }
      localStorage.setItem(WH_STORE, JSON.stringify({ url: url, key: key }));  // header-only; no other modes
      rstatus("Refresh webhook saved on this device.");
    } else if (action === "clear") {
      localStorage.removeItem(WH_STORE);
      rstatus("Refresh webhook removed from this device.");
    }
    $("settings").close();
  }

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
    var c = whGet();
    if (!c || !c.url || !c.key) { openSettings(); return; }
    // the key goes ONLY in the Authorization header; it is never added to the URL
    var url = c.url, headers = { "Content-Type": "application/json", "Authorization": "Bearer " + c.key };
    var body = JSON.stringify({ source: "x-text", action: "refresh", requested_at: new Date().toISOString() });
    $("refreshBtn").disabled = true;
    rstatus("Sending refresh…");
    fetch(url, { method: "POST", headers: headers, body: body, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
      if (r.ok) { rstatus("Refresh sent (HTTP " + r.status + "). Checking every 20 s for up to 3 min."); startPoll(); }
      else { stopPoll(); rstatus("Refresh failed: HTTP " + r.status + (r.status === 401 || r.status === 403 ? " (check the key)" : r.status === 429 ? " (rate limited)" : ""), true); }
    }, function () {
      if (!navigator.onLine) { stopPoll(); rstatus("Refresh failed: you are offline.", true); return; }
      stopPoll();
      rstatus("CORS blocked (or network error): the webhook does not accept requests from this page with an Authorization header (it must allow CORS for this site).", true);
    });
  }

  // ------------------------------------------------------------------ start
  $("refreshBtn").addEventListener("click", sendRefresh);
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsForm").addEventListener("submit", settingsSubmit);

  loadAll().catch(function (e) {
    $("updated").textContent = "Never refreshed";
    $("status").textContent = "Could not load data: " + e.message;
  });
})();
