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

eq(R.statusURL(PARENT_ID, "elonmusk"), "https://x.com/elonmusk/status/" + PARENT_ID, "status url");
eq(R.statusURL("42", ""), "https://x.com/i/status/42", "id-only status url");
eq(R.statusURL("42", "bad handle"), "https://x.com/i/status/42", "unsafe handle dropped");
eq(R.statusURL("12<script>", "elonmusk"), "", "unsafe id dropped");
eq(R.statusURL("42", "a<b"), "https://x.com/i/status/42", "unsafe handle does not enter the path");
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
  ok(html.includes('href="https://x.com/elonmusk/status/' + PARENT_ID + '"'), label + " parent date links to the status");
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
assertPreview(R.renderList([reply], [reply, parent, quotedArchiveCopy], following), "filtered");

// Same lookup when the parent sits past the first page of 50.
{
  const fillers = [];
  for (let i = 0; i < 60; i++) fillers.push(P({ id: String(3000 + i), username: "elonmusk", name: "Elon Musk", text: "page filler " + i }));
  const visible = [reply].concat(fillers).slice(0, 50);
  eq(visible.length, 50, "page size");
  ok(!visible.some((p) => p.id === PARENT_ID), "parent is off the page");
  const html = R.renderList(visible, [reply, parent, quotedArchiveCopy].concat(fillers), following);
  assertPreview(html, "paged");
  ok(html.includes("page filler 0") && html.includes("page filler 48"), "visible fillers render");
  ok(!html.includes("page filler 49") && !html.includes("page filler 59"), "off-page fillers stay off the page");
}

// Parent lives only in a saved search, which is part of the loaded archive.
{
  const archive = R.combinedArchive([reply], { sandbox: { posts: [parent, quotedArchiveCopy] } });
  ok(archive.some((p) => p.id === PARENT_ID), "saved search parent is in the archive");
  assertPreview(R.renderList([reply], archive, following), "saved-search parent");
  const dup = R.combinedArchive([Object.assign({}, parent, { text: "MAIN_COPY" })], { sandbox: { posts: [Object.assign({}, parent, { text: "SAVED_COPY" })] } });
  const html = R.renderList([reply], dup, following);
  ok(html.includes("MAIN_COPY") && !html.includes("SAVED_COPY"), "first archive copy wins");
}

// Both the reply and the parent are on screen: preview plus the parent post, with unique ids.
{
  const html = R.renderList([reply, parent], [reply, parent, quotedArchiveCopy], following);
  ok(count(html, PARENT_TEXT) >= 2, "parent text in the card and in its own post");
  ok(!html.includes(PHOTO_A), "media URL still withheld when the parent post is also visible");
  uniqueControls(html, "reply and parent together");
  ok(!idsOf(html).some((id) => id === PARENT_ID || id === REPLY_ID), "post ids are not element ids");
}

// Missing parent: say so, and link to that status. Do not invent text.
{
  const html = R.renderList([reply], [reply, quotedArchiveCopy], following);
  ok(html.includes("Original post isn't in this archive."), "missing parent message");
  ok(html.includes('class="quote parent missing"'), "missing card");
  ok(html.includes('href="https://x.com/elonmusk/status/' + PARENT_ID + '"'), "specific original-post link");
  ok(html.includes("View original post"), "link label");
  ok(html.includes('rel="noopener noreferrer"'), "external link rel");
  ok(!html.includes(PARENT_TEXT) && !html.includes("be Greg Brockman"), "missing parent has no invented text");
  ok(!html.includes("Text not available."), "missing is different from an empty loaded post");
  ok(html.includes(REPLY_TEXT), "reply still renders");
  const bare = R.renderList([P({ id: "77", kind: "reply", username: "elonmusk", name: "Elon Musk", text: "id only", reply_to: { id: "88" } })], [], following);
  ok(bare.includes('href="https://x.com/i/status/88"'), "id-only original link");
  const noId = R.renderList([P({ id: "78", kind: "reply", username: "zoe", name: "Zoe", text: "no id", reply_to: { username: "bob" } })], [], []);
  ok(noId.includes("Original post isn't in this archive.") && !noId.includes('class="parent-link"'), "no id means no fake status link");
  ok(noId.includes("@bob"), "handle still shown");
}

// Loaded parent with no text of its own still shows the author and an honest empty-text line.
{
  const empty = P({ id: "60", username: "elonmusk", name: "Elon Musk", text: "", url: "https://x.com/elonmusk/status/60" });
  const row = P({ id: "61", username: "elonmusk", name: "Elon Musk", kind: "reply", text: "ack", reply_to: { id: "60", username: "elonmusk" } });
  const html = R.renderList([row], [row, empty], following);
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
  const html = R.renderList([row], [row, repost, original], following);
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
  const html = R.renderList([row], [row, mid, grand], following);
  ok(html.includes("PARENT_REPLY_TEXT") && html.includes("@granduser"), "parent reply text and marker");
  ok(!html.includes("GRAND_TEXT"), "grandparent text is not pulled in");
  eq(count(html, 'class="quote parent"'), 1, "no nested parent card");
}

// Two replies that point at each other stay one level deep.
{
  const a = P({ id: "21", username: "ann", name: "Ann", kind: "reply", text: "AAA_TEXT", reply_to: { id: "22", username: "bob" } });
  const b = P({ id: "22", username: "bob", name: "Bob", kind: "reply", text: "BBB_TEXT", reply_to: { id: "21", username: "ann" } });
  const html = R.renderList([a, b], [a, b], []);
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
  ok(html.includes('href="https://x.com/elonmusk/status/15"'), "self reference still links to that status");
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
  ok(html.includes('href="https://x.com/i/status/42"'), "bad username falls back to the id link");
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
  const unsafe = R.renderList([nastyReply], [nastyReply, nastyParent], following);
  ok(!/<\/(script|img|svg|b)\b/i.test(unsafe), "names and text are escaped: " + unsafe.slice(0, 400));
  ok(unsafe.includes("&lt;img") && unsafe.includes("&amp;") && unsafe.includes("&lt;svg") && unsafe.includes("&lt;script&gt;"), "escaped text is present");
  ok(!unsafe.includes("javascript:"), "javascript URL is dropped");
  ok(unsafe.includes('href="https://x.com/elonmusk/status/10"'), "parent link rebuilt from id");
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
  const html = R.renderList([row], [row, rowParent], following);
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
    const html = R.renderList([liveReply], posts, following);
    ok(html.includes(PARENT_TEXT), "live parent text");
    ok(html.includes(REPLY_TEXT), "live reply text");
    ok(html.includes('class="quote parent"'), "live parent card");
    ok(html.includes("be Greg Brockman"), "live embedded quote");
    ok(!html.includes(PHOTO_A) && !html.includes(PHOTO_B), "live media URLs withheld");
    ok(html.includes("Show 2 photos") && html.includes("Show full post"), "live quote media and long text");
    uniqueControls(html, "live");
    const gone = R.renderList([liveReply], posts.filter((p) => p.id !== PARENT_ID), following);
    ok(gone.includes('href="https://x.com/elonmusk/status/' + PARENT_ID + '"'), "live reply falls back to the status link");
    ok(!gone.includes(PARENT_TEXT), "removed live parent is not invented");
  } else ok(true, "reported posts aged out of data/posts.json; fixture coverage remains");
}

console.log("render tests passed: " + n);
