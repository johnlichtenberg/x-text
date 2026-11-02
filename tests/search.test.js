// Run: node tests/search.test.js   (fake handles/posts only; never use real data here)
const assert = require("assert");
const S = require("../search.js");
const P = (o) => Object.assign({ id: "1", username: "a", name: "A", text: "", kind: "post", urls: [], metrics: {}, created_at: "2026-10-15T12:00:00.000Z" }, o);
const posts = [
  P({ id: "10", username: "rocketco", text: "Rocket flight 12 is go for launch", metrics: { likes: 100, reposts: 50 }, created_at: "2026-10-30T10:00:00.000Z" }),
  P({ id: "11", username: "carco", text: "Widget production update https://carco.com/x", urls: ["https://carco.com/x"], metrics: { likes: 500, reposts: 10 }, created_at: "2026-10-31T10:00:00.000Z" }),
  P({ id: "12", username: "alice_ex", kind: "reply", reply_to: { id: "9", username: "bob" }, text: "@bob Rocket is awesome", metrics: { likes: 1000, reposts: 1 }, created_at: "2026-11-01T00:00:00.000Z" }),
  P({ id: "13", username: "alice_ex", kind: "repost", ref: { id: "8", username: "rocketco" }, text: "Flight 12 recap: Rockets everywhere", created_at: "2026-11-01T05:00:00.000Z" }),
  P({ id: "9", username: "dave_ex", kind: "quote", ref: { id: "7", username: "x", text: "quoted cursive talk" }, text: "so true", created_at: "2026-10-01T00:00:00.000Z" }),
];
const ids = (q) => S.search(posts, q).map((p) => p.id);
let n = 0; const t = (q, exp) => { assert.deepStrictEqual(ids(q), exp, `${q} -> ${ids(q)} expected ${exp}`); n++; };

t("", ["13", "12", "11", "10", "9"]);
t("rocket", ["12", "10"]);                 // word match, not "Rockets"
t("ROCKET flight", ["10"]);                // AND, case-insensitive
t('"go for launch"', ["10"]);
t('"for go"', []);
t("widget OR awesome", ["12", "11"]);
t("rocket -awesome", ["10"]);
t("from:alice_ex", ["13", "12"]);
t("from:@Alice_Ex -is:reply", ["13"]);
t("-is:retweet from:alice_ex", ["12"]);
t("is:reply", ["12"]);
t("is:retweet", ["13"]);
t("is:quote", ["9"]);
t("cursive", ["9"]);                           // matches quoted text
{ // the quoted post's author and the post it quotes are searchable too
  const qp = [P({ id: "5", kind: "quote", text: "look", ref: { id: "4", username: "qauthor", name: "Quinn Q", text: "outer",
    quote: { id: "3", username: "deep", name: "Dee", text: "nested marmalade" } } })];
  for (const [q, e] of [["marmalade", ["5"]], ["@deep", ["5"]], ['"Quinn Q"', ["5"]], ["outer -look", []]]) {
    assert.deepStrictEqual(S.search(qp, q).map((p) => p.id), e, q); n++;
  }
}
t("has:links", ["11"]);
t("since:2026-10-31", ["13", "12", "11"]);
t("until:2026-10-31", ["10", "9"]);           // exclusive
t("since:2026-10-30 until:2026-11-01", ["11", "10"]);
t("(rocket OR widget) -from:alice_ex", ["11", "10"]);
t("-(from:alice_ex OR from:dave_ex)", ["11", "10"]);
t("@bob", ["12"]);
t("to:bob", ["12"]);
t("from:rocketco OR from:carco", ["11", "10"]);
t('unterminated "quote', []);
t("zzz OR", []);              // dangling OR ignored
// big ids compare numerically
assert.deepStrictEqual(S.search([P({ id: "999" }), P({ id: "1000" })], "").map((p) => p.id), ["1000", "999"]); n++;
// long-post preview helper (fake text only)
{
  const pv = S.preview, ok = (c, m) => { assert.ok(c, m); n++; };
  ok(pv("short post") === null, "short text: no preview");
  ok(pv("a".repeat(300)) === null, "<= 300 chars, <= 6 lines: shown whole");
  ok(pv("1\n2\n3\n4\n5\n6") === null && pv("1\n2\n3\n4\n5\n6\n\n") === null, "6 lines (trailing blanks ignored): whole");
  ok(pv("1\n2\n3\n4\n5\n6\n7") === "1\n2\n3\n4\n5\n6…", "7 lines: first 6 lines + …");
  const words = Array.from({ length: 80 }, (_, i) => "word" + i).join(" ");      // ~540 chars
  const w = pv(words);
  ok(w.length <= 281 && w.endsWith("…") && words.startsWith(w.slice(0, -1)), "cut <= 280 chars, prefix of the text");
  ok(/word\d+…$/.test(w) && words.includes(w.slice(0, -1) + " "), "cut on a word boundary");
  const url = "https://example.com/" + "p".repeat(60);
  const t = "x ".repeat(125) + "see " + url + " and more ".repeat(10);       // the URL spans char 280
  const u = pv(t);
  ok(!u.includes("https://example") && u.endsWith("see…"), "never cut inside a URL: " + u.slice(-12));
  const t2 = "y ".repeat(50) + url + " " + "z ".repeat(150);                    // URL fully before the cut
  ok(pv(t2).includes(url), "a whole URL before the cut is kept intact");
  const cjk = "本当にこれ".repeat(80);                                              // no spaces: hard cut
  ok(pv(cjk).length === 281, "no word boundary: hard cut at 280");
  ok(!/[\uD800-\uDBFF]…$/.test(pv("😀".repeat(200))), "no split surrogate pair");
  ok(pv("a, ".repeat(150)).endsWith("a…"), "trailing punctuation/space trimmed before …");
  ok(pv("One.\nTwo.\n3\n4\n5\nSix.\n7") === "One.\nTwo.\n3\n4\n5\nSix…", "a final period merges into …");
}
// hidden-media label + URL allowlist + has:media (fake URLs only)
{
  const ok = (c, m) => { assert.ok(c, m); n++; };
  const ph = { type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }, gif = { type: "animated_gif", url: "https://video.twimg.com/g.mp4" };
  const vid = (ms) => ({ type: "video", url: "https://video.twimg.com/v.mp4", duration_ms: ms });
  const L = S.mediaLabel;
  ok(L([ph]) === "photo" && L([ph, ph]) === "2 photos", "photo labels");
  ok(L([vid(42000)]) === "video (0:42)" && L([vid(65400)]) === "video (1:05)" && L([vid(3725000)]) === "video (1:02:05)", "video durations");
  ok(L([vid()]) === "video" && L([vid(1000), vid(2000)]) === "2 videos", "video without duration / several");
  ok(L([gif]) === "GIF" && L([gif, gif]) === "2 GIFs", "GIF labels");
  ok(L([ph, ph, vid(65000)]) === "2 photos, video (1:05)", "mixed: " + L([ph, ph, vid(65000)]));
  ok(L([]) === "" && L(undefined) === "" && L([{ type: "3d" }]) === "", "nothing to show -> empty");
  const U = S.mediaURL;
  ok(U("https://pbs.twimg.com/media/a.jpg", "photo") && U("https://video.twimg.com/v.mp4", "video") && U("https://pbs.twimg.com/t.jpg", "poster"), "allowed hosts");
  ["https://x.com/a.jpg", "http://pbs.twimg.com/a.jpg", "https://pbs.twimg.com.evil.com/a.jpg", "https://u@pbs.twimg.com/a.jpg",
   "https://pbs.twimg.com:444/a.jpg", "https://video.twimg.com/a.jpg", "javascript:alert(1)", "https://pbs.twimg.com/a b", "//pbs.twimg.com/a"]
    .forEach((u) => ok(U(u, "photo") === null, "rejected " + u));
  ok(U("https://pbs.twimg.com/v.mp4", "video") === null && U("https://pbs.twimg.com/a.jpg", "gif") === null && U(null, "photo") === null, "wrong kind");
  const mp = [P({ id: "1", media: [ph] }), P({ id: "2", media: [vid(1000)] }), P({ id: "3", media: [gif] }), P({ id: "4" })];
  const q = (x) => S.search(mp, x).map((p) => p.id);
  ok(q("has:media").join() === "3,2,1" && q("has:images").join() === "1" && q("has:videos").join() === "3,2" && q("-has:media").join() === "4", "has: operators");
}
console.log(`search tests passed: ${n}`);
