// Run: node tests/parent.test.js
// Parent clicks, cache hits, and the relay request shape. No network.
const assert = require("assert");
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

console.log("parent tests passed: " + n);
