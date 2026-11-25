// Run: node tests/load.test.js
// Checks the published shard index against data/posts.json. It does not write data/.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("../app.js");

const root = path.join(__dirname, "..", "data");
const posts = JSON.parse(fs.readFileSync(path.join(root, "posts.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
const gate = JSON.parse(fs.readFileSync(path.join(root, "gate.json"), "utf8"));
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const shards = R.shardList(index);
eq(R.homeShardIds(index).join(), shards[0].id, "home loads only the newest shard");
ok(shards.length > 1, "the archive is more than one shard");
eq(R.homeShardIds({ shards: [] }).length, 0, "no index means no shard fetch");
ok(!R.dataPathOk("data/../posts.json") && !R.dataPathOk("data/shards/../posts.json"), "shard paths cannot climb");
ok(R.dataPathOk("data/" + shards[0].file) && R.dataPathOk("data/index.json") && R.dataPathOk("data/gate.json"), "published data paths are allowed");
ok(!R.dataPathOk("data/private/state.json") && !R.dataPathOk("data/shards/%2e%2e/posts.json"), "other paths are refused");

let seen = 0;
const ids = new Set();
for (const shard of shards) {
  ok(shard.count <= 400, shard.id + " stays within the shard cap");
  const doc = JSON.parse(fs.readFileSync(path.join(root, shard.file), "utf8"));
  eq(doc.posts.length, shard.count, shard.id + " count matches the index");
  eq(doc.posts[0].id, shard.newest_id, shard.id + " starts at its newest post");
  doc.posts.forEach((p) => { ids.add(p.id); seen++; });
}
eq(seen, posts.posts.length, "shards cover every saved post");
eq(ids.size, posts.posts.length, "shard posts are not repeated");
eq(index.post_count, posts.posts.length, "index count is the full archive");
ok(index.shards[0].newest_id >= index.shards[index.shards.length - 1].newest_id, "shards are newest first");

const home = JSON.parse(fs.readFileSync(path.join(root, shards[0].file), "utf8"));
const html = R.renderList(home.posts.slice(0, 5), home.posts, [], {});
// Match the hostname. A substring check treats spacex.com as x.com.
function hrefsOf(html) {
  const out = [];
  const re = /href\s*=\s*(["'])([\s\S]*?)\1/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[2]);
  return out;
}
function isXHref(h) {
  let host = "";
  try { host = new URL(h).hostname.toLowerCase().replace(/\.+$/g, ""); }
  catch (e) { return /(?:^|\/\/|\.)(?:x\.com|twitter\.com|t\.co)(?:[:/]|$)/i.test(h); }
  return host === "x.com" || host === "twitter.com" || host === "t.co" ||
    host.endsWith(".x.com") || host.endsWith(".twitter.com") || host.endsWith(".t.co");
}
eq(hrefsOf(html).filter(isXHref).join(" "), "", "home shard render has no X href");

const pairIds = new Set(posts.posts.filter((p) => p.reply_to && p.reply_to.id).map((p) => p.id + ":" + p.reply_to.id));
eq(gate.pairs.length, pairIds.size, "gate lists each saved reply once");
ok(gate.pairs.every((pair) => pairIds.has(pair[0] + ":" + pair[1])), "gate pairs are real reply parents");
eq(gate.post_ids.length, posts.posts.length, "gate lists every post id");

const older = '{"updated_at":"2026-11-01T00:00:00Z","last_run":{"at":"2026-11-01T00:00:00Z"},"version":"aaaaaaaaaaaaaaaa"}';
const newer = '{"updated_at":"2026-11-11T00:00:00Z","last_run":{"at":"2026-11-11T00:00:00Z"},"version":"bbbbbbbbbbbbbbbb"}';
eq(R.pickIndex(older, newer), newer, "a newer Pages index wins over a stale relay");
eq(R.pickIndex(newer, older), newer, "a newer relay index wins over Pages");
eq(R.pickIndex("", older), older, "a missing relay index uses Pages");
ok(R.indexStamp(newer) > R.indexStamp(older), "index stamps follow last_run time");

// Pages can publish a parent before KV. The next relay-only tick must not put the stale KV doc back.
const freshParents = '{"updated_at":"2026-11-11T03:00:00Z","posts":[{"id":"9","text":"from Pages"}]}';
const staleParents = '{"updated_at":"2026-11-11T01:00:00Z","posts":[]}';
eq(R.keepNewer(R.pickIndex(staleParents, ""), freshParents), freshParents, "stale relay parents do not replace a newer Pages copy");
eq(R.keepNewer(R.pickIndex(freshParents, ""), staleParents), freshParents, "a newer relay parents doc still wins");
eq(R.keepNewer(R.pickIndex(older, ""), newer), newer, "stale relay index does not replace a newer Pages index");
eq(R.keepNewer(R.pickIndex(newer, ""), older), newer, "a newer relay index still wins over the applied copy");

const limit = 180000;
const t0 = 10000;
ok(!R.pollExpired(t0, t0 + limit), "a refresh poll is still running at 3 min");
ok(R.pollExpired(t0, t0 + limit + 1), "a refresh poll stops after 3 min");
const restarted = t0 + limit + 1;
ok(!R.pollExpired(restarted, restarted + 1000), "tapping Refresh starts the 3 min wait over");
ok(!R.pollExpired(restarted, restarted + limit), "the new wait still runs for the full 3 min");
const waiting = R.refreshTimeoutStatus();
eq(waiting.message, "Still refreshing… a big catch-up can take a few minutes. Reload the page in a minute to see new posts.", "timeout says the refresh is still running");
eq(waiting.error, false, "the waiting status is not an error");
eq(R.statusClass(waiting.error), "rstatus", "the waiting status keeps the neutral style");
eq(R.statusClass(true), "rstatus err", "a failed refresh stays an error");
ok(!/x\.com|twitter\.com|t\.co|https?:/i.test(waiting.message), "the waiting status has no outbound link");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
ok(!appSrc.includes("No response after 3 min"), "the page no longer says the refresh gave up");
ok(appSrc.includes(waiting.message), "the refresh poll shows the waiting status");
eq((appSrc.match(/pollExpired\(started, Date\.now\(\)\)/g) || []).length, 2, "refresh and parent polls share the 3 min limit");

// Refresh sends the viewed account so its posts are fetched and published first.
eq(R.refreshBody("#/u/elonmusk"), '{"action":"refresh","source":"x-text","handle":"elonmusk"}', "account page sends its handle");
eq(R.refreshBody("#/u/Some_User1?q=x"), '{"action":"refresh","source":"x-text","handle":"Some_User1"}', "query ignored");
eq(R.refreshBody("#/"), '{"action":"refresh","source":"x-text"}', "home sends no handle");
eq(R.refreshBody("#/saved/ai"), '{"action":"refresh","source":"x-text"}', "saved search sends no handle");
eq(R.refreshBody("#/search?q=from:elonmusk"), '{"action":"refresh","source":"x-text"}', "search sends no handle");
eq(R.refreshBody("#/u/bad%20name"), '{"action":"refresh","source":"x-text"}', "invalid handle dropped");
eq(R.refreshBody("#/u/abcdefghijklmnop"), '{"action":"refresh","source":"x-text"}', "16 chars dropped");
eq(R.refreshBody("#/u/%E0%A4%A"), '{"action":"refresh","source":"x-text"}', "bad escape dropped");
eq(R.refreshBody(""), '{"action":"refresh","source":"x-text"}', "no hash");
// Default page: no hash opens @elonmusk (so Refresh sends handle=elonmusk); "#/" stays the all-accounts view.
eq(R.DEFAULT_PAGE, "#/u/elonmusk", "default page is @elonmusk");
eq(R.defaultHash("", R.DEFAULT_PAGE), "#/u/elonmusk", "no hash -> @elonmusk");
eq(R.defaultHash("#", R.DEFAULT_PAGE), "#/u/elonmusk", "bare # -> @elonmusk");
eq(R.defaultHash("#/", R.DEFAULT_PAGE), "#/", "#/ stays the Following view");
eq(R.defaultHash("#/u/Tesla", R.DEFAULT_PAGE), "#/u/Tesla", "account links kept");
eq(R.defaultHash("#/search?q=mars", R.DEFAULT_PAGE), "#/search?q=mars", "search links kept");
eq(R.defaultHash("#/saved/ai", R.DEFAULT_PAGE), "#/saved/ai", "saved links kept");
eq(R.defaultHash("", ""), "", "DEFAULT_PAGE \"\" restores the Following view");
eq(R.refreshBody(R.defaultHash("", R.DEFAULT_PAGE)), '{"action":"refresh","source":"x-text","handle":"elonmusk"}', "default page refreshes @elonmusk");
ok(appSrc.includes("var start = defaultHash(location.hash, DEFAULT_PAGE)") && appSrc.includes("history.replaceState(null"), "boot applies the default page without a history entry");
ok(/<a href="#\/" class="title"/.test(fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")), "title still links to the Following view");
ok(appSrc.includes('<a href="#/" class="\' + (r.view === "home" ? "on" : "") + \'">Following</a>'), "Following tab still links to #/");
const run0 = { status: "new", at: "2026-11-17T10:00:00Z", new_posts: 3 };
const early = { status: "running", at: "2026-11-17T10:05:00Z", new_posts: 2, handle: "elonmusk" };
const final = { status: "new", at: "2026-11-17T10:06:00Z", new_posts: 5 };
eq(R.pollStep({ last_run: run0, updated_at: "u0" }, JSON.stringify(run0), "u0"), "wait", "unchanged index waits");
eq(R.pollStep({ last_run: early, updated_at: "u1" }, JSON.stringify(run0), "u0"), "partial", "early publish keeps polling");
eq(R.pollStep({ last_run: early, updated_at: "u1" }, JSON.stringify(early), "u1"), "wait", "same early publish waits");
eq(R.pollStep({ last_run: final, updated_at: "u2" }, JSON.stringify(early), "u1"), "done", "final run finishes");
eq(R.pollStep({ last_run: { status: "skipped", at: "x" } }, JSON.stringify(run0), "u0"), "done", "skip finishes");
eq(R.pollStep(null, "null", ""), "wait", "no doc waits");
eq(R.runMessage(early, 0), "2 new posts from @elonmusk · still checking the other accounts…", "early status names the account");
eq(R.runMessage({ status: "running", new_posts: 1, handle: "<b>" }, 0), "1 new post · still checking the other accounts…", "bad handle not shown");
ok(appSrc.includes("body: refreshBody(location.hash)"), "Refresh sends refreshBody");

console.log("load tests passed: " + n);
