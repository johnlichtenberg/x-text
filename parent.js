/* Parent lookup for X Text. Works in the browser (window.XParent) and in node.
 * Archive and data/parents.json hits are local. A click may ask the relay for one
 * uncached parent; this file never calls the network. */
(function (root) {
  "use strict";
  var ID = /^[0-9]{1,25}$/;
  var NEGATIVE_MS = 24 * 60 * 60 * 1000;
  var MAX_PAIRS = 5;
  var MAX_QUEUE = 20;
  var MAX_DEPTH = 40; // ancestors shown above one reply; parent.py caps the cache the same way

  function isId(s) { return typeof s === "string" && ID.test(s); }

  function target(p) {
    var r = p && p.reply_to;
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    var id = isId(r.id) ? r.id : "";
    var username = typeof r.username === "string" ? r.username : "";
    if (!id && !username) return null;
    return { id: id, username: username };
  }

  function doc(raw) {
    raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      posts: Array.isArray(raw.posts) ? raw.posts : [],
      missing: Array.isArray(raw.missing) ? raw.missing : [],
    };
  }

  function index(posts) {
    var byId = {};
    (posts || []).forEach(function (p) {
      if (!p || typeof p !== "object" || !isId(p.id) || byId[p.id]) return;
      byId[p.id] = p;
    });
    return byId;
  }

  function missingIndex(raw) {
    var byId = {};
    doc(raw).missing.forEach(function (m) {
      if (!m || typeof m !== "object" || !isId(m.id) || byId[m.id]) return;
      byId[m.id] = m;
    });
    return byId;
  }

  // True when an explicit Try again is allowed. A missing or unreadable timestamp
  // does not allow a retry; a future timestamp does not either.
  function retryDue(entry, now) {
    if (!entry || typeof entry.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(entry.at)) return false;
    var t = Date.parse(entry.at);
    if (isNaN(t) || t > now) return false;
    return now - t >= NEGATIVE_MS;
  }

  // ready: show from memory. unavailable: cached miss. fetch: only an explicit click may ask.
  function classify(reply, archivePosts, raw, now) {
    now = now == null ? Date.now() : now;
    if (!reply || typeof reply !== "object" || !reply.reply_to) return { kind: "none" };
    var t = target(reply);
    if (!t || !t.id || reply.id === t.id) return { kind: "unlinked", username: t ? t.username : "" };
    var arch = index(archivePosts)[t.id];
    if (arch) return { kind: "ready", source: "archive", post: arch };
    var cached = index(doc(raw).posts)[t.id];
    if (cached) return { kind: "ready", source: "cache", post: cached };
    var miss = missingIndex(raw)[t.id];
    if (miss) return { kind: "unavailable", retry: retryDue(miss, now), at: miss.at, reason: miss.reason || "unavailable" };
    return { kind: "fetch", parent_id: t.id, username: t.username };
  }

  // Click outcome. enqueue is the only path that may contact the relay.
  function parentClick(reply, archivePosts, raw, now, retry) {
    var c = classify(reply, archivePosts, raw, now);
    if (c.kind === "ready") return { effect: "reveal" };
    if (c.kind === "unavailable") {
      if (retry && c.retry && isId(reply.id)) {
        var id = target(reply).id;
        return { effect: "enqueue", pair: { reply_id: reply.id, parent_id: id, retry: true } };
      }
      return { effect: "unavailable" };
    }
    if (c.kind === "fetch" && isId(reply.id)) {
      return { effect: "enqueue", pair: { reply_id: reply.id, parent_id: c.parent_id, retry: false } };
    }
    return { effect: "stop" };
  }

  // Thread view: every ancestor above reply, nearest first, from the archive and the parent
  // cache only (no network). end says why the walk stopped: "root" (top of the thread),
  // "fetch" (next ancestor not saved yet; end.reply_id/parent_id is the pair to ask for),
  // "unavailable" (deleted or protected), "cap" (MAX_DEPTH reached) or "unlinked".
  // root is the conversation's first post when it is saved but not reached by the walk.
  function chain(reply, archivePosts, raw, now) {
    now = now == null ? Date.now() : now;
    var arch = index(archivePosts), cache = index(doc(raw).posts), miss = missingIndex(raw);
    var out = [], seen = {}, cur = reply, rootId = "", end = null;
    if (!reply || typeof reply !== "object") return { ancestors: [], end: { kind: "root" }, root: null };
    if (isId(reply.id)) seen[reply.id] = 1;
    while (!end) {
      if (!rootId && isId(cur.conversation_id) && cur.conversation_id !== cur.id) rootId = cur.conversation_id;
      if (!cur.reply_to) { end = { kind: "root" }; break; }
      var t = target(cur);
      if (!t || !t.id || t.id === cur.id) { end = { kind: "unlinked", username: t ? t.username : "" }; break; }
      if (seen[t.id]) { end = { kind: "root" }; break; }
      var pair = { reply_id: cur.id, parent_id: t.id, username: t.username };
      if (out.length >= MAX_DEPTH) { end = Object.assign({ kind: "cap" }, pair); break; }
      var next = arch[t.id] || cache[t.id];
      if (next) { seen[t.id] = 1; out.push(next); cur = next; continue; }
      var m = miss[t.id];
      if (m) { end = Object.assign({ kind: "unavailable", retry: retryDue(m, now), reason: m.reason || "unavailable" }, pair); break; }
      end = Object.assign({ kind: "fetch" }, pair);
    }
    var root = null;
    if (end.kind !== "root" && rootId && !seen[rootId]) root = arch[rootId] || cache[rootId] || null;
    return { ancestors: out, end: end, root: root };
  }

  // Thread click. Like parentClick, only "enqueue" may contact the relay, and only for the
  // first ancestor that is not saved yet (the routine then walks the rest of the chain).
  function threadClick(reply, archivePosts, raw, now, retry) {
    var e = chain(reply, archivePosts, raw, now).end;
    if (e.kind === "fetch" && isId(e.reply_id) && isId(e.parent_id)) {
      return { effect: "enqueue", pair: { reply_id: e.reply_id, parent_id: e.parent_id, retry: false } };
    }
    if (e.kind === "unavailable" && retry && e.retry && isId(e.reply_id) && isId(e.parent_id)) {
      return { effect: "enqueue", pair: { reply_id: e.reply_id, parent_id: e.parent_id, retry: true } };
    }
    return { effect: "reveal" };
  }

  function pushPair(queue, pair) {
    queue = Array.isArray(queue) ? queue.slice() : [];
    if (!pair || !isId(pair.reply_id) || !isId(pair.parent_id) || pair.reply_id === pair.parent_id) return queue;
    if (queue.some(function (p) { return p.reply_id === pair.reply_id && p.parent_id === pair.parent_id; })) return queue;
    if (queue.length >= MAX_QUEUE) return queue;
    queue.push({ reply_id: pair.reply_id, parent_id: pair.parent_id, retry: pair.retry === true });
    return queue;
  }

  function takeBatch(queue) {
    queue = Array.isArray(queue) ? queue : [];
    return { batch: queue.slice(0, MAX_PAIRS), rest: queue.slice(MAX_PAIRS) };
  }

  // The page posts this and nothing else. The relay rebuilds its own webhook body.
  function requestBody(batch) {
    return { pairs: (batch || []).map(function (p) {
      return { reply_id: p.reply_id, parent_id: p.parent_id, retry: p.retry === true };
    }) };
  }

  // Same object the relay sends to the parent routine. Ids only.
  function webhookBody(parentIds, retryIds) {
    var body = { action: "parents", source: "x-text", parent_ids: parentIds.slice() };
    if (retryIds && retryIds.length) body.retry_ids = retryIds.slice();
    return body;
  }

  // What the page should do with a relay response. "reload" still polls if the published
  // file does not yet contain the row (Pages can lag). Errors are not a negative cache.
  function relayEffect(status, bodyStatus) {
    if (status === 202 || bodyStatus === "fetching") return "poll";
    if (status === 200 && (bodyStatus === "cached" || bodyStatus === "in_archive" || bodyStatus === "unavailable")) return "reload";
    return "error";
  }

  function parentURL(refreshURL) {
    if (typeof refreshURL !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/refresh$/.test(refreshURL)) return "";
    return refreshURL.replace(/\/refresh$/, "/parent");
  }

  // A pair is allowed only when that archived post replies to that parent.
  function pairAllowed(posts, replyId, parentId) {
    if (!isId(replyId) || !isId(parentId) || replyId === parentId) return false;
    return (posts || []).some(function (p) {
      return p && p.id === replyId && target(p) && target(p).id === parentId;
    });
  }

  var api = {
    isId: isId, target: target, doc: doc, index: index, classify: classify, parentClick: parentClick,
    pushPair: pushPair, takeBatch: takeBatch, requestBody: requestBody, webhookBody: webhookBody,
    parentURL: parentURL, pairAllowed: pairAllowed, retryDue: retryDue, relayEffect: relayEffect,
    chain: chain, threadClick: threadClick,
    NEGATIVE_MS: NEGATIVE_MS, MAX_PAIRS: MAX_PAIRS, MAX_DEPTH: MAX_DEPTH,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XParent = api;
})(typeof window !== "undefined" ? window : this);
