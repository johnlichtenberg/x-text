# X Text

A text-only reader for a list of X accounts. Static files only (`index.html`, `app.js`, `search.js`,
`style.css`); no build step, no trackers, and no third-party requests until you tap a media label (the CSP
allows images only from `pbs.twimg.com` and video only from `video.twimg.com`, and blocks every other host;
`connect-src https:` is only for the refresh relay).

## Data
The page loads plain JSON directly on open: `data/posts.json`, `data/following.json`, `data/site.json`
and `data/saved-searches/<slug>.json`. These are generated from a private, git-ignored working copy on
each refresh. Fetch settings, tool arguments, raw outputs and state never leave that private folder.

## Refresh button
Sends `POST {"action":"refresh","source":"x-text"}` (Content-Type `application/json`, no key, no
Authorization header) to `refresh_url` in `data/site.json`: a small Cloudflare Worker relay that holds the
Grok Bot webhook URL and key as Worker secrets and wakes the refresh routine. Nothing secret is in the
site or the browser. If `refresh_url` is empty the button shows `Refresh isn't set up yet`. After a
successful send the page re-checks `data/posts.json` every 20 s for up to 3 minutes and reloads when it
changes. The status shows sent / failed (HTTP code) / relay unreachable / offline. Refreshing is manual
only (no schedule); a refresh less than 10 minutes after the previous one is skipped. The relay only wakes
Grok Bot: if Grok Bot isn't running or the routine is paused, nothing refreshes and the site keeps showing
the last published data.

## Status line
Shown on page load from `data/posts.json` metadata (`updated_at`, `accounts`, `last_run`), times in your local zone:
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
it quotes, one level), with no link to it on x.com. Search also matches the quoted text and author.

A reply shows that parent post when the parent is already in the loaded archive (the main feed plus saved
searches, including posts outside the current filter, search, or page). The preview has the parent's author
and text, with the same long-text toggle and hidden media. When the parent is a quote or repost, the preview
also includes the embedded original, one level deep. A parent that is itself a reply shows that parent's text
and a one-line "Replying to" marker. If the parent is not in the archive, the reply says so and links to that
specific post (`https://x.com/<handle>/status/<id>`, or `https://x.com/i/status/<id>` when the handle is
missing). Search matches a reply's own text; the resolved parent is display context.

Long text (the post, a quoted/reposted original, or a nested quote) over 300 characters or 6 lines shows a
preview (cut at 280 characters on a word boundary, never inside a link, or after 6 lines) ending in "…" and a
**Show full post** button that expands it inline (**Show less** collapses it); the full text is already in the page
and search always matches it. The helper is `XSearch.preview` in `search.js`. Posts have no "open on X" link.

Media stay hidden. A post (or quoted/reposted original, or nested quote) that had photos, videos or GIFs shows
one small label button instead, e.g. **Show photo**, **Show 2 photos**, **Show video (0:42)**, **Show GIF**
(mixed: **Show 2 photos, video (1:05)**). Tapping it creates the `<img>`/`<video>` elements inline (photos lazy,
`referrerpolicy=no-referrer`; video with controls, `playsinline`, `preload=none`, never autoplay; GIFs loop muted)
and the label becomes **Hide …**, which removes them again. Until a tap, no media URL is in the page's DOM and
nothing is requested; any re-render (new view, search, refresh) resets every label to hidden. Alt text comes from
the post, or "Photo 1 of 2 by @user (no description)". `posts.json` stores only direct media-server URLs, checked
against an whitelist by `merge.py` (and again by the page): photos and video posters from `https://pbs.twimg.com`,
the highest-bit-rate mp4 from `https://video.twimg.com`; anything else is dropped (never x.com or twitter.com).
**Note:** revealed media load from `pbs.twimg.com` / `video.twimg.com`, not `x.com`, so a block on x.com alone
(DNS, firewall, Screen Time) may not stop them; block those two hosts too if you need that.

## Publishing safety
`.gitignore` is an whitelist (everything ignored except the public files below), and the publish step
stages only this hard-coded list, never `git add -A` / `git add .`: `.gitignore`, `README.md`,
`index.html`, `app.js`, `search.js`, `style.css`, `tests/search.test.js`, `tests/render.test.js`, `data/posts.json`,
`data/following.json`, `data/site.json`, `data/saved-searches/` (status-only runs stage just `data/posts.json`).

## Tests (fake data only, plus one public reply/parent fixture in the render tests; they do not read `data/`)
    node tests/search.test.js
    node tests/render.test.js
