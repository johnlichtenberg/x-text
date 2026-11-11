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
ok(!/href\s*=\s*["'][^"']*(?:x\.com|twitter\.com|t\.co)/i.test(html), "home shard render has no X href");

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

console.log("load tests passed: " + n);
