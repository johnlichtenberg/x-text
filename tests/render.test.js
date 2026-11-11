// Run: node tests/render.test.js
// Fixtures are inline. The final check reads data/posts.json only when the reported ids are still there,
// and never writes it.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("../app.js");

const P = (o) => Object.assign({
  id: "1", username: "a", name: "A", text: "", kind: "post", urls: [], metrics: {},
  created_at: "2026-10-15T12:00:00.000Z", url: "https://x.com/a/status/1",
}, o);
const following = [{ username: "elonmusk", name: "Elon Musk" }];
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const count = (html, s) => html.split(s).length - 1;
function idsOf(html) {
  const out = [];
  const re = /\sid="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
function uniqueControls(html, label) {
  const ids = idsOf(html);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  eq(dup.join(), "", label + " duplicate id " + dup.join());
  const re = /\saria-controls="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) ok(ids.indexOf(m[1]) >= 0, label + " aria-controls " + m[1]);
}
function hrefsOf(html) {
  const out = [];
  const re = /href\s*=\s*(["'])([\s\S]*?)\1/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push(m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  return out;
}
function isXHref(h) {
  let host = "";
  try { host = new URL(h).hostname.toLowerCase().replace(/\.+$/g, ""); }
  catch (e) { return /(?:^|\/\/|@)(?:[\w.-]+\.)?(?:x\.com|twitter\.com|t\.co)(?:[:/]|$)/i.test(h); }
  return host === "x.com" || host === "twitter.com" || host === "t.co" ||
    host.endsWith(".x.com") || host.endsWith(".twitter.com") || host.endsWith(".t.co");
}
function assertNoX(html, label) {
  const bad = hrefsOf(html).filter(isXHref);
  eq(bad.join(" "), "", label + " X href " + bad.join(" "));
}
// Revealed parents: the reader already clicked Show parent. The closed feed does not pass shown.
function open(list, archive, opts) {
  const shown = (list || []).filter(Boolean).map((p) => p.id);
  return R.renderList(list, archive, following, Object.assign({ shown: shown }, opts || {}));
}

const PARENT_TEXT = "“Best way to sandbox an AI,” said Musk. “Put it on a Delta flight: No escape is possible.”";
const QUOTE_TEXT = "be Greg Brockman\ngo to White House dinner to beg your enemies for compute\n\n> \"h-hey Elon... got any spare compute bro?\"\n\nElon calls you out in front of the entire room: \"DUDE, you stole my charity! You can't be a huge dick then ask for favors, hello?\"\n\nSergey Brin: “He was asking me for compute too. How many grown men do you know that keep a diary? If I did I’d burn it.”\n\nLMAOOOOOOOO";
const REPLY_TEXT = "38,000 foot air gap!";
const PHOTO_A = "https://pbs.twimg.com/media/HWDuTByXwAAZCrE.jpg";
const PHOTO_B = "https://pbs.twimg.com/media/HWDuTCAWsAAtyqk.jpg";
const PARENT_ID = "2116968674590441904";
const REPLY_ID = "2116969019303432203";
const QUOTE_ID = "2116955860073414760";

const parent = P({
  id: PARENT_ID, username: "elonmusk", name: "Elon Musk", kind: "quote", text: PARENT_TEXT,
  created_at: "2026-11-01T19:00:38.000Z", url: "https://x.com/elonmusk/status/" + PARENT_ID,
  ref: {
    id: QUOTE_ID, username: "ns123abc", name: "NIK", created_at: "2026-11-01T18:09:42.000Z", text: QUOTE_TEXT,
    media: [{ type: "photo", url: PHOTO_A, width: 1200, height: 800 }, { type: "photo", url: PHOTO_B, width: 1053, height: 1200 }],
  },
});
const reply = P({
  id: REPLY_ID, username: "elonmusk", name: "Elon Musk", kind: "reply", text: REPLY_TEXT,
  created_at: "2026-11-01T19:02:00.000Z", url: "https://x.com/elonmusk/status/" + REPLY_ID,
  reply_to: { id: PARENT_ID, username: "elonmusk" },
});
const quotedArchiveCopy = P({
  id: QUOTE_ID, username: "ns123abc", name: "NIK", text: "SENTINEL_archive_copy_of_quoted_post",
  url: "https://x.com/ns123abc/status/" + QUOTE_ID,
});

ok(String(2116968674590441904) !== PARENT_ID, "snowflake does not round-trip through Number");

function assertPreview(html, label) {
  ok(html.includes(PARENT_TEXT), label + " parent text");
  ok(html.includes("be Greg Brockman"), label + " embedded quote text");
  ok(html.includes("LMAOOOOOOOO"), label + " rest of embedded quote");
  ok(html.includes(REPLY_TEXT), label + " reply text");
  ok(!html.includes("SENTINEL_archive_copy_of_quoted_post"), label + " does not swap in the archive copy of the quote");
  ok(!html.includes("Original post isn't in this archive."), label + " parent is loaded");
  ok(!html.includes("View original post"), label + " no missing-parent link");
  ok(html.includes('class="quote parent"'), label + " parent card");
  eq(count(html, 'class="quote parent"'), 1, label + " one parent card");
  ok(html.includes("❝ Quoting"), label + " quote marker");
  ok(html.includes('<span class="handle">@ns123abc</span>'), label + " quote author is text");
  ok(!html.includes('href="https://x.com/ns123abc"'), label + " quote author is not an x.com link");
  ok(html.includes('href="#/u/elonmusk"'), label + " followed parent author links in-site");
  ok(html.includes('<span title="2026-11-01T19:00:38.000Z">'), label + " parent date is plain text");
  ok(!/<a\b[^>]*title="2026-11-01T19:00:38.000Z"/.test(html), label + " parent date is not a link");
  assertNoX(html, label);
  ok(html.includes("Show full post"), label + " long quote can expand");
  ok(html.includes('class="full" hidden'), label + " full quote text stays in the page");
  ok(html.includes("Show 2 photos"), label + " media stays behind a label");
  ok(!html.includes(PHOTO_A) && !html.includes(PHOTO_B), label + " media URLs stay out of the DOM");
  ok(html.includes('aria-expanded="false"'), label + " media and text start collapsed");
  const marker = html.indexOf("Replying to");
  const parentAt = html.indexOf(PARENT_TEXT);
  const quoteAt = html.indexOf("be Greg Brockman");
  const replyAt = html.indexOf(REPLY_TEXT);
  ok(marker >= 0 && marker < parentAt && parentAt < quoteAt && quoteAt < replyAt, label + " reads parent, then quote, then reply");
  uniqueControls(html, label);
}

// Reported reply. The parent is a quote and is not in the visible rows (filter / search results).
assertPreview(open([reply], [reply, parent, quotedArchiveCopy]), "filtered");
{
  const closed = R.renderList([reply], [reply, parent, quotedArchiveCopy], following);
  ok(closed.includes("Show parent") && !closed.includes(PARENT_TEXT), "archive parent stays behind the button");
  ok(!closed.includes("workers.dev") && !closed.includes("/parent"), "closed reply does not point at the relay");
  eq(R.parentClick(reply, [reply, parent], { posts: [], missing: [] }, Date.now(), false).effect, "reveal", "click on an archived parent does not enqueue");
}

// Same lookup when the parent sits past the first page of 50.
{
  const fillers = [];
  for (let i = 0; i < 60; i++) fillers.push(P({ id: String(3000 + i), username: "elonmusk", name: "Elon Musk", text: "page filler " + i }));
  const visible = [reply].concat(fillers).slice(0, 50);
  eq(visible.length, 50, "page size");
  ok(!visible.some((p) => p.id === PARENT_ID), "parent is off the page");
  const html = open(visible, [reply, parent, quotedArchiveCopy].concat(fillers));
  assertPreview(html, "paged");
  ok(html.includes("page filler 0") && html.includes("page filler 48"), "visible fillers render");
  ok(!html.includes("page filler 49") && !html.includes("page filler 59"), "off-page fillers stay off the page");
}

// Parent lives only in a saved search, which is part of the loaded archive.
{
  const archive = R.combinedArchive([reply], { sandbox: { posts: [parent, quotedArchiveCopy] } });
  ok(archive.some((p) => p.id === PARENT_ID), "saved search parent is in the archive");
  assertPreview(open([reply], archive), "saved-search parent");
  const dup = R.combinedArchive([Object.assign({}, parent, { text: "MAIN_COPY" })], { sandbox: { posts: [Object.assign({}, parent, { text: "SAVED_COPY" })] } });
  const html = open([reply], dup);
  ok(html.includes("MAIN_COPY") && !html.includes("SAVED_COPY"), "first archive copy wins");
}

// Both the reply and the parent are on screen: preview plus the parent post, with unique ids.
{
  const html = open([reply, parent], [reply, parent, quotedArchiveCopy]);
  ok(count(html, PARENT_TEXT) >= 2, "parent text in the card and in its own post");
  ok(!html.includes(PHOTO_A), "media URL still withheld when the parent post is also visible");
  uniqueControls(html, "reply and parent together");
  ok(!idsOf(html).some((id) => id === PARENT_ID || id === REPLY_ID), "post ids are not element ids");
}

// Parent not loaded yet: a button and the status link. No invented text, no relay URL.
{
  const html = R.renderList([reply], [reply, quotedArchiveCopy], following);
  ok(html.includes("Show parent"), "uncached parent offers a button");
  ok(!html.includes("Original post isn't in this archive."), "uncached is not described as already missing");
  ok(!html.includes("View original post"), "no original-post link");
  assertNoX(html, "uncached parent");
  ok(!html.includes(PARENT_TEXT) && !html.includes("be Greg Brockman"), "missing parent has no invented text");
  ok(!html.includes("workers.dev"), "button does not prefetch");
  ok(html.includes(REPLY_TEXT), "reply still renders");
  const bare = R.renderList([P({ id: "77", kind: "reply", username: "elonmusk", name: "Elon Musk", text: "id only", reply_to: { id: "88" } })], [], following);
  ok(bare.includes("Show parent") && !bare.includes("View original post"), "id-only reply has a button and no status link");
  assertNoX(bare, "id-only reply");
  const noId = R.renderList([P({ id: "78", kind: "reply", username: "zoe", name: "Zoe", text: "no id", reply_to: { username: "bob" } })], [], []);
  ok(noId.includes("Original post isn't in this archive.") && !noId.includes("Show parent"), "no id means no fetch button");
  ok(noId.includes('<span class="handle">@bob</span>'), "unfollowed handle is plain text");
  assertNoX(noId, "handle-only reply");
  const cached = P({ id: PARENT_ID, username: "outsider", name: "Outside", text: "CACHED_PARENT_TEXT", url: "https://x.com/outsider/status/" + PARENT_ID });
  const fromCache = open([reply], [reply], { parents: { posts: [cached], missing: [] } });
  ok(fromCache.includes("CACHED_PARENT_TEXT") && count(fromCache, "<li") === 1, "cache parent is context, not a feed row");
  eq(R.parentClick(reply, [reply], { posts: [cached], missing: [] }, Date.now(), false).effect, "reveal", "cache hit does not enqueue");
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const fresh = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const unavailable = open([reply], [reply], { parents: { posts: [], missing: [{ id: PARENT_ID, at: fresh, reason: "unavailable" }] } });
  ok(unavailable.includes("This post isn't available.") && !unavailable.includes("Try again"), "fresh negative cache has no retry yet");
  const retry = open([reply], [reply], { parents: { posts: [], missing: [{ id: PARENT_ID, at: old, reason: "unavailable" }] } });
  ok(retry.includes("This post isn't available.") && retry.includes("Try again"), "stale negative cache can be retried explicitly");
  eq(R.parentClick(reply, [reply], { posts: [], missing: [{ id: PARENT_ID, at: fresh, reason: "unavailable" }] }, Date.now(), true).effect, "unavailable", "retry click inside the window does not enqueue");
}

// Loaded parent with no text of its own still shows the author and an honest empty-text line.
{
  const empty = P({ id: "60", username: "elonmusk", name: "Elon Musk", text: "", url: "https://x.com/elonmusk/status/60" });
  const row = P({ id: "61", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "ack", reply_to: { id: "60", username: "elonmusk" } });
  const html = open([row], [row, empty]);
  ok(html.includes("Text not available.") && html.includes("Elon Musk") && !html.includes("isn't in this archive"), "empty loaded parent");
}

// Parent is a repost: show the embedded original, and do not replace it with another archive post.
{
  const original = P({ id: "8", username: "rocketco", name: "Rocket Co", text: "DO_NOT_PULL_ARCHIVE_ORIGINAL" });
  const repost = P({
    id: "7", username: "elonmusk", name: "Elon Musk", kind: "repost", text: "embedded repost text",
    url: "https://x.com/elonmusk/status/7", ref: { id: "8", username: "rocketco", name: "Rocket Co", created_at: "2026-11-01T00:00:00.000Z" },
  });
  const row = P({ id: "6", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "nice repost", reply_to: { id: "7", username: "elonmusk" } });
  const html = open([row], [row, repost, original]);
  ok(html.includes("embedded repost text") && html.includes("reposted") && html.includes("Rocket Co"), "repost parent context");
  ok(!html.includes("DO_NOT_PULL_ARCHIVE_ORIGINAL"), "repost parent does not expand to the archive original");
  eq(count(html, 'class="quote parent"'), 1, "one card around a repost parent");
}

// Parent is itself a reply: show that post, and stop before the grandparent.
{
  const grand = P({ id: "3", username: "granduser", name: "Grand", text: "GRAND_TEXT" });
  const mid = P({
    id: "4", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "PARENT_REPLY_TEXT",
    reply_to: { id: "3", username: "granduser" }, url: "https://x.com/elonmusk/status/4",
  });
  const row = P({ id: "5", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "CHILD_REPLY_TEXT", reply_to: { id: "4", username: "elonmusk" } });
  const html = open([row], [row, mid, grand]);
  ok(html.includes("PARENT_REPLY_TEXT") && html.includes("@granduser"), "parent reply text and marker");
  ok(!html.includes("GRAND_TEXT"), "grandparent text is not pulled in");
  eq(count(html, 'class="quote parent"'), 1, "no nested parent card");
}

// Two replies that point at each other stay one level deep.
{
  const a = P({ id: "21", username: "ann", name: "Ann", kind: "reply", text: "AAA_TEXT", reply_to: { id: "22", username: "bob" } });
  const b = P({ id: "22", username: "bob", name: "Bob", kind: "reply", text: "BBB_TEXT", reply_to: { id: "21", username: "ann" } });
  const html = open([a, b], [a, b]);
  eq(count(html, "AAA_TEXT"), 2, "A text is the post plus B's parent card");
  eq(count(html, "BBB_TEXT"), 2, "B text is the post plus A's parent card");
  eq(count(html, 'class="quote parent"'), 2, "cycle does not nest parent cards");
  uniqueControls(html, "cycle");
}

// Self-reference is not a parent preview of the reply's own text.
{
  const row = P({ id: "15", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "SELF_TEXT", reply_to: { id: "15", username: "elonmusk" } });
  const html = R.renderList([row], [row], following);
  eq(count(html, "SELF_TEXT"), 1, "self reply text once");
  ok(html.includes("Original post isn't in this archive."), "self reference uses the fallback");
  ok(!html.includes("View original post"), "self reference has no status link");
  assertNoX(html, "self reference");
  ok(!html.includes("Show parent"), "self reference is not a fetch");
}

// Malformed reply_to, quote cycles, bad media, and unsafe URLs.
{
  const chain3 = {
    id: "9", username: "quser", name: "Q", text: "LEVEL1",
    quote: { id: "8", username: "ruser", name: "R", text: "LEVEL2", quote: { id: "7", username: "suser", name: "S", text: "LEVEL3_SHOULD_NOT" } },
  };
  const loop = { id: "31", username: "quser", name: "Q", text: "LOOP_TEXT" };
  loop.quote = loop;
  const a = { id: "41", username: "a", name: "A", text: "CYCLE_A" };
  const b = { id: "42", username: "b", name: "B", text: "CYCLE_B", quote: a };
  a.quote = b;
  const cases = [
    P({ id: "101", kind: "reply", text: "string ref", reply_to: PARENT_ID }),
    P({ id: "102", kind: "reply", text: "array ref", reply_to: [PARENT_ID] }),
    P({ id: "103", kind: "reply", text: "number ref", reply_to: { id: 2116968674590441904, username: "elonmusk" } }),
    P({ id: "104", kind: "reply", text: "bad id", reply_to: { id: '12"><script>', username: "elonmusk" } }),
    P({ id: "105", kind: "reply", text: "bad user", reply_to: { id: "42", username: 'a" onmouseover="alert(1)' } }),
    P({ id: "106", kind: "quote", text: "depth", ref: chain3 }),
    P({ id: "107", kind: "quote", text: "loop", ref: loop }),
    P({ id: "108", kind: "quote", text: "obj cycle", ref: a }),
    null,
    undefined,
  ];
  const html = R.renderList(cases, cases.concat([parent]), following);
  ok(!html.includes(PARENT_TEXT), "malformed reply_to does not attach the real parent");
  ok(!html.includes(String(2116968674590441904)), "imprecise numeric id is not written into a link");
  ok(!html.includes("<script") && !html.includes('onmouseover="'), "malformed reply_to cannot open a tag or attribute");
  ok(html.includes("onmouseover=&quot;"), "quote in a handle is escaped");
  ok(html.includes("LEVEL1") && html.includes("LEVEL2") && !html.includes("LEVEL3_SHOULD_NOT"), "quote chain stops after one nested post");
  eq(count(html, "LOOP_TEXT"), 1, "self-quote renders once");
  eq(count(html, "CYCLE_A"), 1, "object cycle renders A once");
  eq(count(html, "CYCLE_B"), 1, "object cycle renders B once");
  assertNoX(html, "malformed rows");
  ok(!html.includes("View original post"), "malformed rows have no status link");
  ok(html.includes("string ref") && html.includes("array ref"), "malformed rows still render");

  const nastyParent = P({
    id: "10", username: "elonmusk", name: "</div><script>alert(1)</script>", kind: "quote",
    text: '<img src=x onerror="alert(1)">&', article_title: "<script>",
    url: "javascript:alert(1)", created_at: "not-a-date", media: "https://evil.example/pwnd.jpg",
    ref: { id: "11", username: "q<script>", name: "<b>Name</b>", text: "<svg onload=alert(1)>" },
  });
  const nastyReply = P({
    id: "12", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "plain reply",
    reply_to: { id: "10", username: "elonmusk" },
    media: [{ type: "photo", url: "https://pbs.twimg.com/media/reply-only.jpg" }, { type: "photo", url: "https://x.com/a.jpg" }],
  });
  const unsafe = open([nastyReply], [nastyReply, nastyParent]);
  ok(!/<\/(script|img|svg|b)\b/i.test(unsafe), "names and text are escaped: " + unsafe.slice(0, 400));
  ok(unsafe.includes("&lt;img") && unsafe.includes("&amp;") && unsafe.includes("&lt;svg") && unsafe.includes("&lt;script&gt;"), "escaped text is present");
  ok(!unsafe.includes("javascript:"), "javascript URL is dropped");
  ok(unsafe.includes('title="not-a-date"'), "invalid parent date stays a tooltip");
  assertNoX(unsafe, "unsafe parent");
  ok(!unsafe.includes("View original post"), "unsafe parent has no status link");
  ok(!unsafe.includes("evil.example") && !unsafe.includes("reply-only.jpg") && !unsafe.includes("https://x.com/a.jpg"), "media URLs stay out of the HTML");
  ok(unsafe.includes("Show 2 photos"), "reply media label still renders");
  ok(unsafe.includes("plain reply"), "reply text remains");
  const plain = R.renderList([P({ id: "1", text: "ordinary post", created_at: "nope" })], [], []);
  ok(plain.includes("ordinary post") && !plain.includes("quote parent"), "a normal post has no parent card");
}

// Long parent text uses the existing preview control. The full text remains in the page.
{
  const long = ("alpha ").repeat(80).trim();
  const rowParent = P({ id: "70", username: "elonmusk", name: "Elon Musk", text: long, url: "https://x.com/elonmusk/status/70" });
  const row = P({ id: "71", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "short reply", reply_to: { id: "70", username: "elonmusk" } });
  const html = open([row], [row, rowParent]);
  ok(html.includes("Show full post") && html.includes('class="full" hidden') && html.includes(long), "long parent expands inline");
  ok(html.includes("…"), "preview ellipsis");
  uniqueControls(html, "long parent");
}

// Live archive: the reported posts, when they are still published. Skips once they age out.
{
  const file = path.join(__dirname, "..", "data", "posts.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const posts = doc.posts || [];
  const liveReply = posts.find((p) => p.id === REPLY_ID);
  const liveParent = posts.find((p) => p.id === PARENT_ID);
  if (liveReply && liveParent) {
    const closed = R.renderList([liveReply], posts, following);
    ok(closed.includes("Show parent") && !closed.includes(PARENT_TEXT), "live parent is closed until click");
    const html = open([liveReply], posts);
    ok(html.includes(PARENT_TEXT), "live parent text");
    ok(html.includes(REPLY_TEXT), "live reply text");
    ok(html.includes('class="quote parent"'), "live parent card");
    ok(html.includes("be Greg Brockman"), "live embedded quote");
    ok(!html.includes(PHOTO_A) && !html.includes(PHOTO_B), "live media URLs withheld");
    ok(html.includes("Show 2 photos") && html.includes("Show full post"), "live quote media and long text");
    assertNoX(html, "live reply");
    ok(!html.includes("View original post"), "live parent card has no status link");
    uniqueControls(html, "live");
    const gone = R.renderList([liveReply], posts.filter((p) => p.id !== PARENT_ID), following);
    assertNoX(gone, "live reply without its parent");
    ok(!gone.includes("View original post"), "live reply has no status link");
    ok(!gone.includes(PARENT_TEXT), "removed live parent is not invented");
    ok(gone.includes("Show parent"), "removed live parent can be requested later");
  } else ok(true, "reported posts aged out of data/posts.json; fixture coverage remains");
}

// No href to X anywhere: reply to someone outside the following list, short links, user heading, parent card.
{
  const extReply = P({
    id: "601", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "plain reply body",
    created_at: "2026-11-01T19:02:00.000Z", url: "https://x.com/elonmusk/status/601",
    reply_to: { id: "600", username: "notfollowed" },
  });
  const extHtml = R.renderList([extReply], [extReply], following);
  ok(extHtml.includes("Replying to") && extHtml.includes('<span class="handle">@notfollowed</span>'), "reply handle is plain text");
  ok(!extHtml.includes('href="https://x.com/notfollowed"') && !extHtml.includes("#/u/notfollowed"), "unfollowed handle is not a link");
  ok(extHtml.includes('href="#/u/elonmusk"'), "followed author stays in-site");
  ok(extHtml.includes('<span title="2026-11-01T19:02:00.000Z">'), "reply timestamp keeps its tooltip");
  ok(!/<a\b[^>]*title="2026-11-01T19:02:00.000Z"/.test(extHtml), "reply timestamp is not a link");
  ok(extHtml.includes("Show parent") && !extHtml.includes("View original post"), "show parent stays, original link is gone");
  assertNoX(extHtml, "reply to someone not followed");

  const mediaPost = P({
    id: "502", username: "elonmusk", name: "Elon Musk", text: "Look https://t.co/media1234567",
    media: [{ type: "photo", url: "https://pbs.twimg.com/media/abc.jpg", width: 100, height: 100 }],
    entities: { urls: [{ url: "https://t.co/media1234567", expanded_url: "https://x.com/elonmusk/status/502/photo/1", media_key: "3" }] },
  });
  const mediaHtml = R.renderList([mediaPost], [mediaPost], following);
  ok(mediaHtml.includes("Look") && !mediaHtml.includes("t.co") && !mediaHtml.includes("/photo/1"), "media short link is omitted");
  ok(mediaHtml.includes("Show photo") && !mediaHtml.includes("pbs.twimg.com"), "photo stays behind its button");
  assertNoX(mediaHtml, "post with a media short link");

  const bareMedia = P({
    id: "503", username: "elonmusk", name: "Elon Musk", text: "Clip https://t.co/noEntityMed",
    media: [{ type: "video", url: "https://video.twimg.com/tweet_video/v.mp4" }],
  });
  const bareMediaHtml = R.renderList([bareMedia], [bareMedia], following);
  ok(bareMediaHtml.includes("https://t.co/noEntityMed") && bareMediaHtml.includes("Show video"), "short link without a destination stays text");
  assertNoX(bareMediaHtml, "media post without an expanded URL");

  const article = P({
    id: "501", username: "elonmusk", name: "Elon Musk",
    text: "Read this https://t.co/abcDEF1234 today",
    entities: { urls: [{ url: "https://t.co/abcDEF1234", expanded_url: "https://example.com/story", display_url: "example.com/story" }] },
  });
  const articleHtml = R.renderList([article], [article], following);
  ok(articleHtml.includes('href="https://example.com/story"'), "article short link uses the expanded destination");
  ok(articleHtml.includes('rel="noopener noreferrer nofollow"'), "external link keeps nofollow");
  ok(articleHtml.includes(">example.com/story</a>") && articleHtml.includes("Read this ") && articleHtml.includes(" today"), "destination is the visible link text");
  ok(!articleHtml.includes("t.co"), "article short link is not left in the text");
  assertNoX(articleHtml, "post with an article short link");

  const mixed = P({
    id: "504", username: "elonmusk", name: "Elon Musk",
    text: 'plain https://x.com/someone/status/1 and https://twitter.com/someone/status/2 plus https://example.com/a?b=1&c=2 end',
  });
  const mixedHtml = R.renderList([mixed], [mixed], following);
  ok(mixedHtml.includes("https://x.com/someone/status/1") && mixedHtml.includes("https://twitter.com/someone/status/2"), "X URLs stay visible as text");
  ok(mixedHtml.includes('href="https://example.com/a?b=1&amp;c=2"'), "a non-X URL is still linked");
  eq(hrefsOf(mixedHtml).filter((h) => h.indexOf("example.com") >= 0).length, 1, "only the safe URL is an anchor");
  assertNoX(mixedHtml, "post that mentions X by URL");

  const blockedExpand = P({
    id: "505", username: "elonmusk", name: "Elon Musk", text: "see https://t.co/toXstatus1",
    entities: { urls: [{ url: "https://t.co/toXstatus1", expanded_url: "https://twitter.com/someone/status/9" }] },
  });
  const blockedHtml = R.renderList([blockedExpand], [blockedExpand], following);
  ok(blockedHtml.includes("https://t.co/toXstatus1") && !blockedHtml.includes("twitter.com/someone"), "an expanded X URL is not written out as a link");
  assertNoX(blockedHtml, "short link that expands onto X");

  const outsider = P({
    id: "700", username: "outsider", name: "Outside Person", created_at: "2026-11-02T01:02:03.000Z",
    text: "PARENT_BLOCK_TEXT https://t.co/parentTco1", url: "https://x.com/outsider/status/700",
    entities: { urls: [{ url: "https://t.co/parentTco1", expanded_url: "https://example.com/parent-article" }] },
  });
  const child = P({
    id: "701", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "CHILD_BLOCK_TEXT",
    created_at: "2026-11-02T02:00:00.000Z", url: "https://x.com/elonmusk/status/701",
    reply_to: { id: "700", username: "outsider" },
  });
  const closedParent = R.renderList([child], [child, outsider], following);
  ok(closedParent.includes("Show parent") && !closedParent.includes("PARENT_BLOCK_TEXT") && !closedParent.includes("View original post"), "closed parent block");
  ok(closedParent.includes('<span class="handle">@outsider</span>'), "closed reply names the outsider in plain text");
  assertNoX(closedParent, "closed parent block");
  const openParent = open([child], [child, outsider]);
  ok(openParent.includes("PARENT_BLOCK_TEXT") && openParent.includes('href="https://example.com/parent-article"'), "open parent shows its article");
  ok(openParent.includes('<span title="2026-11-02T01:02:03.000Z">'), "parent timestamp is plain text");
  ok(openParent.includes('<span class="handle">@outsider</span>') && openParent.includes('href="#/u/elonmusk"'), "parent handle is plain, reply author stays in-site");
  ok(!openParent.includes("View original post") && !openParent.includes("Show parent"), "open parent has no outbound status link");
  assertNoX(openParent, "open parent block");

  const header = R.userHeader({
    username: "elonmusk", name: "Elon Musk",
    description: "bio https://t.co/BioShort01 and https://twitter.com/elonmusk",
    entities: { description: { urls: [{ url: "https://t.co/BioShort01", expanded_url: "https://example.com/about" }] } },
  }, "elonmusk", 4, following);
  ok(header.startsWith("Elon Musk ") && header.includes('href="#/u/elonmusk"') && header.includes(" · 4 saved posts"), "user page header");
  ok(header.includes('href="https://example.com/about"') && header.includes("https://twitter.com/elonmusk") && !header.includes("t.co"), "bio expands only the safe short link");
  assertNoX(header, "user page header");
  const plainBio = R.userHeader({ username: "elonmusk", name: "Elon Musk", description: "https://t.co/ZdBx5WABYx" }, "elonmusk", 1, following);
  ok(plainBio.includes("https://t.co/ZdBx5WABYx"), "bio short link without a destination stays text");
  assertNoX(plainBio, "user bio without an expanded URL");
  const stranger = R.userHeader({ name: "Nope", description: "https://x.com/nope" }, "nope", 0, following);
  ok(stranger.includes('<span class="handle">@nope</span>') && !stranger.includes("#/u/"), "unknown account header is plain text");
  ok(stranger.includes("https://x.com/nope"));
  assertNoX(stranger, "unknown user page header");
}

// Published JSON, read only: every rendered post, parent card, and account header.
{
  const dir = path.join(__dirname, "..", "data");
  const posts = JSON.parse(fs.readFileSync(path.join(dir, "posts.json"), "utf8"));
  const parents = JSON.parse(fs.readFileSync(path.join(dir, "parents.json"), "utf8"));
  const users = JSON.parse(fs.readFileSync(path.join(dir, "following.json"), "utf8")).users || [];
  const list = posts.posts || [];
  const html = R.renderList(list, list, users, { shown: list.map((p) => p.id), parents: parents });
  assertNoX(html, "published archive");
  ok(!html.includes("View original post"), "published archive has no original-post link");
  users.forEach((u) => assertNoX(R.userHeader(u, u.username, 1, users), "published header " + u.username));
}

// The page source must not build an outbound X URL. The host blocklist is a bare name, not a URL.
{
  const files = ["app.js", "search.js", "parent.js", "index.html", "style.css"];
  const src = files.map((f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8")).join("\n");
  ok(!/https?:\/\/(?:[\w.-]+\.)?(?:x\.com|twitter\.com|t\.co)\b/i.test(src), "site files do not contain an X URL");
  ok(!/href\s*=\s*["'][^"']*(?:x\.com|twitter\.com|t\.co)/i.test(src), "site files do not write an X href");
}

console.log("render tests passed: " + n);
