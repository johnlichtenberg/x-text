// Run: node tests/parent.test.js
// Parent clicks, cache hits, and the relay request shape. No network.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const P = require("../parent.js");
const R = require("../app.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const post = (id, extra) => Object.assign({ id: id, username: "a", name: "A", text: "t" + id, kind: "post", created_at: "2026-11-01T00:00:00.000Z" }, extra);
const reply = post("10", { kind: "reply", text: "reply", reply_to: { id: "9", username: "bob" } });
const parent = post("9", { text: "PARENT_TEXT", username: "bob", name: "Bob" });
const now = Date.parse("2026-11-07T00:00:00Z");
const day = 24 * 60 * 60 * 1000;

eq(P.parentURL("https://x-text-relay.example.workers.dev/refresh"), "https://x-text-relay.example.workers.dev/parent", "parent url");
eq(P.parentURL("https://evil.example/refresh"), "https://evil.example/parent", "same host, parent path");
eq(P.parentURL("https://x-text-relay.example.workers.dev/refresh/extra"), "", "only the refresh path");
eq(P.parentURL("https://x-text-relay.example.workers.dev/refresh?x=1"), "", "no query string");
eq(P.parentURL("http://x-text-relay.example.workers.dev/refresh"), "", "https only");
eq(P.parentURL(""), "", "empty refresh url");

ok(P.pairAllowed([reply], "10", "9"), "archived reply pair");
ok(!P.pairAllowed([reply], "10", "8"), "other parent refused");
ok(!P.pairAllowed([reply], "9", "10"), "reversed pair refused");
ok(!P.pairAllowed([reply], "10", "10"), "self pair refused");
ok(!P.pairAllowed([reply], "10<script>", "9"), "unsafe id refused");

eq(P.classify(reply, [reply, parent], {}, now).kind, "ready", "archive hit");
eq(P.classify(reply, [reply, parent], {}, now).source, "archive", "archive wins");
eq(P.classify(reply, [reply], { posts: [parent] }, now).source, "cache", "cache hit");
eq(P.parentClick(reply, [reply, parent], {}, now, false).effect, "reveal", "archive click stays local");
eq(P.parentClick(reply, [reply], { posts: [parent] }, now, false).effect, "reveal", "cache click stays local");
eq(P.parentClick(reply, [reply], {}, now, false).effect, "enqueue", "uncached click may ask");
eq(P.parentClick(reply, [reply], {}, now, false).pair.parent_id, "9", "enqueue names that parent");
eq(P.parentClick(reply, [reply], {}, now, false).pair.retry, false, "first ask is not a retry");

const fresh = { posts: [], missing: [{ id: "9", at: "2026-11-07T00:00:00Z", reason: "unavailable" }] };
const stale = { posts: [], missing: [{ id: "9", at: "2026-11-05T00:00:00Z", reason: "deleted" }] };
eq(P.classify(reply, [reply], fresh, now).kind, "unavailable", "negative cache");
eq(P.classify(reply, [reply], fresh, now).retry, false, "negative cache is quiet for a day");
eq(P.parentClick(reply, [reply], fresh, now, true).effect, "unavailable", "early retry does not enqueue");
eq(P.classify(reply, [reply], stale, now + 2 * day).retry, true, "retry opens after a day");
const again = P.parentClick(reply, [reply], stale, now + 2 * day, true);
eq(again.effect, "enqueue", "explicit retry of a stale miss may ask");
eq(again.pair.retry, true, "retry flag is set");
eq(P.parentClick(reply, [reply], stale, now + 2 * day, false).effect, "unavailable", "opening a stale miss does not ask by itself");
eq(P.classify(reply, [reply], { missing: [{ id: "9", at: "not-a-date" }] }, now).retry, false, "bad timestamp does not open a retry");
ok(!P.retryDue({ at: "2026-11-08T00:00:00Z" }, now), "future timestamp is not due");

let q = [];
q = P.pushPair(q, { reply_id: "10", parent_id: "9", retry: false });
q = P.pushPair(q, { reply_id: "10", parent_id: "9", retry: true });
q = P.pushPair(q, { reply_id: "11", parent_id: "12" });
q = P.pushPair(q, { reply_id: "bad", parent_id: "12" });
q = P.pushPair(q, { reply_id: "13", parent_id: "13" });
eq(q.length, 2, "queue dedupes and drops bad ids");
eq(q[0].retry, false, "a repeat click does not upgrade into a retry");
for (let i = 0; i < 30; i++) q = P.pushPair(q, { reply_id: String(100 + i), parent_id: String(200 + i) });
eq(q.length, 20, "queue is bounded");
const taken = P.takeBatch(q);
eq(taken.batch.length, 5, "one request carries at most five clicks");
eq(taken.rest.length, 15, "the rest wait for a later request");
const body = P.requestBody(taken.batch);
eq(Object.keys(body).join(), "pairs", "request has pairs only");
eq(body.pairs.length, 5, "five pairs");
ok(body.pairs.every((p) => Object.keys(p).sort().join() === "parent_id,reply_id,retry"), "pair fields are ids and retry");
eq(P.relayEffect(202, "fetching"), "poll", "a wake polls the published cache");
eq(P.relayEffect(200, "cached"), "reload", "a cache hit reloads and does not ask again");
eq(P.relayEffect(200, "unavailable"), "reload", "a negative row is read from the file");
eq(P.relayEffect(502, "archive unavailable"), "error", "a failed cache read is not treated as a miss");
eq(P.relayEffect(429, "limited"), "error", "a refused wake is not a negative cache");
eq(P.relayEffect(504, "timeout"), "error", "a transport failure is not a deleted post");
const hook = P.webhookBody(["9", "12"], ["9"]);
eq(JSON.stringify(hook), '{"action":"parents","source":"x-text","parent_ids":["9","12"],"retry_ids":["9"]}', "webhook body is ids only");

const closed = R.renderList([reply], [reply, parent], [], {});
ok(closed.includes("Show parent") && !closed.includes("PARENT_TEXT"), "render does not reveal a parent");
ok(!closed.includes("https://x-text-relay"), "render does not name the relay");
const loading = R.renderList([reply], [reply], [], { loading: ["10"] });
ok(loading.includes("Loading parent…") && !loading.includes("Show parent"), "in-flight click shows loading");
const noted = R.renderList([reply], [reply], [], { notes: { "10": "Parent fetch isn't set up yet." } });
ok(noted.includes("Parent fetch isn&#39;t set up yet.") && noted.includes("Show parent"), "setup failure keeps the original ask");

const parentLimit = 180000;
ok(!R.pollExpired(0, parentLimit), "a parent poll is still running at 3 min");
ok(R.pollExpired(0, parentLimit + 1), "a parent poll stops after 3 min");
const askedAgain = parentLimit + 1;
ok(!R.pollExpired(askedAgain, askedAgain + parentLimit), "Show parent again starts a full 3 min wait");
const parentWait = R.parentTimeoutNote();
eq(parentWait, "Still loading this parent… a slow lookup can take a few minutes. Reload the page in a minute to see it.", "parent timeout says the lookup is still running");
ok(!/x\.com|twitter\.com|t\.co|https?:/i.test(parentWait), "the parent wait has no outbound link");
const waitingParent = R.renderList([reply], [reply], [], { notes: { "10": parentWait } });
ok(waitingParent.includes(parentWait), "the parent slot shows the waiting note");
ok(waitingParent.includes("Show parent"), "Show parent stays available after the wait");
ok(!waitingParent.includes("rstatus err") && !waitingParent.includes('class="msg"'), "the parent wait is not an error");
ok(!/href\s*=\s*["'][^"']*(?:x\.com|twitter\.com|t\.co)/i.test(waitingParent), "the parent wait renders no X link");
const parentSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
ok(!parentSrc.includes("No parent yet. It may still be saving"), "the page no longer says the parent lookup gave up");
ok(parentSrc.includes(parentWait), "the parent poll shows the waiting note");

const photo = { type: "photo", url: "https://pbs.twimg.com/media/parent-only.jpg", width: 40, height: 40 };
const mediaParent = post("9", { text: "", username: "bob", name: "Bob", media: [photo] });
const mediaReply = post("10", { kind: "reply", text: "reply", reply_to: { id: "9", username: "bob" } });
const openedMedia = R.renderList([mediaReply], [mediaReply, mediaParent], [], { shown: ["10"] });
ok(openedMedia.includes("Show photo") && openedMedia.includes("Bob") && !openedMedia.includes("Text not available."), "opened parent with media and no text omits the missing line");
ok(!openedMedia.includes("parent-only.jpg") && !openedMedia.includes("pbs.twimg.com"), "opened parent keeps the media URL hidden");
ok(openedMedia.includes('aria-expanded="false"'), "opened parent media stays hidden");
ok(!/href\s*=\s*["'][^"']*(?:x\.com|twitter\.com|t\.co)/i.test(openedMedia), "media parent renders no X link");
const blankParent = post("9", { text: "", username: "bob", name: "Bob" });
const openedBlank = R.renderList([mediaReply], [mediaReply, blankParent], [], { shown: ["10"] });
ok(openedBlank.includes("Text not available.") && openedBlank.includes("Bob") && openedBlank.includes("reply"), "opened parent with no text and no media still says text is missing");
ok(!openedBlank.includes("Show photo") && !openedBlank.includes("Show video"), "blank parent has no media toggle");

// Thread chain: nearest first, end reasons, depth cap, and the only pair a click may ask for.
{
  const mk = (id, up, extra) => post(id, Object.assign({ kind: "reply", reply_to: { id: up, username: "w" } }, extra));
  const r = mk("100", "101", { conversation_id: "90" });
  const c1 = P.chain(r, [r], { posts: [mk("101", "102"), mk("102", "103"), post("90")] }, now);
  eq(c1.ancestors.map((p) => p.id).join(), "101,102", "nearest first");
  eq(c1.end.kind, "fetch", "next ancestor not saved");
  eq(c1.end.reply_id + ">" + c1.end.parent_id, "102>103", "pair names the saved child and its parent");
  eq(c1.root && c1.root.id, "90", "saved root shown above the gap");
  const d1 = P.threadClick(r, [r], { posts: [mk("101", "102"), mk("102", "103")] }, now, false);
  eq(d1.effect, "enqueue", "gap may ask");
  eq(JSON.stringify(P.requestBody([d1.pair])), '{"pairs":[{"reply_id":"102","parent_id":"103","retry":false}]}', "request is that pair only");
  const done = P.chain(r, [r], { posts: [mk("101", "90"), post("90")] }, now);
  eq(done.end.kind, "root", "walk ends at the root");
  eq(done.root, null, "root is in ancestors, not repeated");
  eq(P.threadClick(r, [r], { posts: [mk("101", "90"), post("90")] }, now, false).effect, "reveal", "saved thread stays local");
  const prot = P.chain(r, [r], { posts: [mk("101", "102")], missing: [{ id: "102", at: "2026-11-06T23:00:00Z", reason: "protected" }] }, now);
  eq(prot.end.kind + ":" + prot.end.reason + ":" + prot.end.retry, "unavailable:protected:false", "fresh miss");
  eq(P.threadClick(r, [r], { posts: [mk("101", "102")], missing: [{ id: "102", at: "2026-11-06T23:00:00Z", reason: "protected" }] }, now, true).effect, "reveal", "fresh miss does not ask even on retry");
  const stale = { posts: [mk("101", "102")], missing: [{ id: "102", at: "2026-11-01T00:00:00Z", reason: "deleted" }] };
  eq(P.threadClick(r, [r], stale, now, true).pair.retry, true, "stale miss retries only on an explicit Try again");
  eq(P.threadClick(r, [r], stale, now, false).effect, "reveal", "stale miss without retry stays local");
  const archived = P.chain(r, [r, mk("101", "102")], { posts: [post("102")] }, now);
  eq(archived.ancestors.map((p) => p.id).join() + ":" + archived.end.kind, "101,102:root", "archive and cache rows mix");
  const loop = P.chain(r, [r], { posts: [mk("101", "102"), mk("102", "101")] }, now);
  eq(loop.end.kind, "root", "a reply cycle stops");
  const rows = [];
  for (let i = 1; i <= P.MAX_DEPTH + 5; i++) rows.push(mk(String(1000 + i), String(1000 + i + 1)));
  const deep = P.chain(mk("1000", "1001"), [], { posts: rows }, now);
  eq(deep.ancestors.length, P.MAX_DEPTH, "depth cap");
  eq(deep.end.kind, "cap", "cap end");
  eq(P.threadClick(mk("1000", "1001"), [], { posts: rows }, now, false).effect, "reveal", "cap does not ask");
}

console.log("parent tests passed: " + n);
