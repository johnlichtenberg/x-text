# X Text

A text-only reader for a list of X accounts. Static files only (`index.html`, `app.js`, `search.js`,
`parent.js`, `style.css`); no build step, no trackers, and no third-party requests until you tap a media
label, Show parent for a post that is not already saved, or the page reads its JSON from the relay
(the CSP allows images, video, and connections only from `https://x-text-relay.johnlichtenberg.workers.dev`,
and blocks every other host).

## Data
The page loads plain JSON. It tries the relay (`GET /d/<file>` on the same host as `refresh_url`) and, if
that is missing, the copy on GitHub Pages. `data/index.json` lists post shards (`data/shards/<month>.json`,
at most 400 posts each, newest shard first). The home view loads only the newest shard; **Show older posts**
and search or an account page load the rest. `data/posts.json` is still written while the archive is small,
so an older cached copy of the page keeps working. `data/following.json`, `data/site.json`, and
`data/saved-searches/<slug>.json` are unchanged. `data/parents.json` is the parent cache (also sharded under
`data/parents/` as it grows). Parents are context inside a reply and are not added to the feed or the
following list. `data/gate.json` is the compact id list the relay uses to check a Show parent click. Fetch
settings, tool arguments, raw outputs and state never leave the private folder.

## Refresh button
Sends `POST {"action":"refresh","source":"x-text"}` (Content-Type `application/json`, no key, no
Authorization header) to `refresh_url` in `data/site.json`: a small Cloudflare Worker relay that holds the
Grok Bot webhook URL and key as Worker secrets and wakes the refresh routine. Nothing secret is in the
site or the browser. If `refresh_url` is empty the button shows `Refresh isn't set up yet`. After a
successful send the page re-checks `data/index.json` on the relay (then Pages) every 20 s for up to 3
minutes and reloads when it changes, so new posts show up without waiting for GitHub Pages. The status shows sent / failed (HTTP code) / relay unreachable / offline. Refreshing is manual
only (no schedule); a refresh less than 10 minutes after the previous one is skipped. The relay only wakes
Grok Bot: if Grok Bot isn't running or the routine is paused, nothing refreshes and the site keeps showing
the last published data. A refresh also fetches immediate parents of new replies that are not already
saved (at most two batches of 100 ids, continuing on the next manual refresh if more remain). Show parent
is still the fallback for older replies. A separate `/parent` route on the same relay (its
own webhook secret, not the refresh key) wakes a parent lookup only after Show parent, and only for a
reply→parent pair that is already in the saved archive. The relay's parent gate is one SQLite Durable
Object, not KV: a granted wake is single-threaded on that object, and a failed object call does not wake
Grok. That is not an account-wide quota. Refresh does not read that binding; its relay cooldown stays the
per-isolate 60 second memory guard. Until `/parent` is deployed, Show parent still opens parents that are
already saved and otherwise says parent fetch isn't set up yet. Successful parent rows in `data/parents.json`
are kept. Only the negative-result list is capped.

## Status line
Shown on page load from `data/index.json` (`updated_at`, `accounts`, `post_count`, `last_run`), times in your local zone:
- `Last updated <date, time, zone> (<3 h ago>) · <N> posts from <M> accounts`, or `Never refreshed` if there is no data.
- After a Refresh tap: `Refreshing…` while polling, then the new `Last updated …` line plus one of
  `<k> new posts`, `No new posts`, or `Skipped: refreshed under 10 min ago` (every run writes `last_run`,
  even with nothing new; when publishing is enabled every run is pushed, with only `data/posts.json` committed
  when there are no new posts). After 3 min without a change: `No response after 3 min: the refresh may still be running. Tap Refresh again later.`

## Views and search
Hash routes: `#/` combined feed · `#/u/<handle>` one account · `#/search?q=…` · `#/saved/<slug>`.
Search syntax: `word word` (AND), `"exact phrase"`, `a OR b`, `-word`, `(group)`, `from:handle`, `to:handle`,
`is:reply`, `is:retweet`, `is:quote` (prefix `-` to exclude), `has:links`, `has:media`, `has:images`,
`has:videos` (the post's own media; a repost's is the original's), `since:YYYY-MM-DD`,
`until:YYYY-MM-DD` (UTC, exclusive), `lang:en`. Results are always newest first.

Quotes and reposts show the original inline: author (name + @username), date and full text (plus the post
it quotes, one level). Search also matches the quoted text and author.

Nothing on the page links to X. Timestamps are plain text, with the full timestamp in a tooltip. An @handle
of an account in the following list links to `#/u/<handle>`, including on that account's own page. Every
other @handle, including "Replying to", is plain text. There is no "View original post" link.

A reply starts with **Show parent**. The click reveals the parent when it is already
in the loaded archive (main feed plus saved searches, including posts outside the current filter, search, or
page) or in `data/parents.json`. That reveal is local: it does not call the relay. The preview has the parent's
author and text, with the same long-text toggle and hidden media. When the parent is a quote or repost, the
preview also includes the embedded original, one level deep. A parent that is itself a reply shows that parent's
text and a one-line "Replying to" marker, with no further parent button. If the parent is not saved, that same
click asks the relay for that one post (several clicks in the same moment share one request, at most five).
Nothing is requested while rendering, scrolling, searching, or refreshing. A saved "not available" result says
so, with no link out; **Try again** appears a day later and is another explicit click. Search matches a
reply's own text; the resolved parent is display context.

Web addresses in a post or a bio become links only when they are ordinary `http` or `https` URLs on some other
host (`rel="noopener noreferrer nofollow"`). `x.com`, `twitter.com`, `t.co`, and their subdomains are never
anchors. A `t.co` short link is replaced with its expanded destination when the post or profile stores a URL
entity (`entities.urls`, or `entities.description.urls` on a profile) whose `url` is that short link and whose
`expanded_url` is a safe destination. A short link that points at the post's own photo or video (a stored
`media_key`, or an expanded address on a pic host or a `/photo/` or `/video/` path) is left out of the text,
because **Show photo** / **Show video** already covers it. A `t.co` link with no safe destination is shown as
plain text. The public JSON does not carry those entities today: `urls` is a list of strings and is empty
whenever the text still contains `t.co`, and profile bios are the same. The private refresh would need to copy
each short link's expanded URL into that entity shape. This repo does not include that pipeline.

Long text (the post, a quoted/reposted original, or a nested quote) over 300 characters or 6 lines shows a
preview (cut at 280 characters on a word boundary, never inside a link, or after 6 lines) ending in "…" and a
**Show full post** button that expands it inline (**Show less** collapses it); the full text is already in the page
and search always matches it. The helper is `XSearch.preview` in `search.js`.

Media stay hidden. A post (or quoted/reposted original, or nested quote) that had photos, videos or GIFs shows
one small label button instead, e.g. **Show photo**, **Show 2 photos**, **Show video (0:42)**, **Show GIF**
(mixed: **Show 2 photos, video (1:05)**). Tapping it creates the `<img>`/`<video>` elements inline (photos lazy,
`referrerpolicy=no-referrer`; video with controls, `playsinline`, `preload=none`, never autoplay; GIFs loop muted)
and the label becomes **Hide …**, which removes them again. Until a tap, no media URL is in the page's DOM and
nothing is requested; any re-render (new view, search, refresh) resets every label to hidden. Alt text comes from
the post, or "Photo 1 of 2 by @user (no description)". `posts.json` stores only direct media-server URLs, checked
against an whitelist by `merge.py` (and again by the page): photos and video posters from `https://pbs.twimg.com`,
the highest-bit-rate mp4 from `https://video.twimg.com`; anything else is dropped (never x.com or twitter.com).
A tap loads the file from `https://x-text-relay.johnlichtenberg.workers.dev`, which fetches that same whitelist
of paths. The browser never requests `pbs.twimg.com` or `video.twimg.com` directly, so Firefox strict tracking
protection and Firefox Focus can show them. The content security policy allows images and video only from the relay.

## Publishing safety
`.gitignore` is an whitelist (everything ignored except the public files below), and the publish step
stages only this hard-coded list, never `git add -A` / `git add .`: `.gitignore`, `README.md`,
`index.html`, `app.js`, `search.js`, `parent.js`, `style.css`, `tests/search.test.js`, `tests/render.test.js`,
`tests/parent.test.js`, `tests/load.test.js`, `data/posts.json`, `data/index.json`, `data/gate.json`,
`data/following.json`, `data/site.json`, `data/parents.json`, `data/shards/`, `data/parents/`,
`data/saved-searches/` (status-only refresh runs stage just `data/posts.json`; a parent lookup stages just
`data/parents.json`).

## Tests (fake data, one public reply/parent fixture, and a read-only sweep of the published JSON for outbound X links)
    node tests/search.test.js
    node tests/render.test.js
    node tests/parent.test.js
    node tests/load.test.js
