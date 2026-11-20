# Speed and scale plan

14 Nov 2026. How afterwrd copes as people's friend lists and groups grow, and how pages can feel quick on a phone
network. Work through it in order. Step 1 is in progress.

## What to design for

- **Facebook friends.** Pew (US, 2014): 338 on average, but a median of 200, so a few big lists pull the average up.
  Dunbar (UK, 2016): about 150 on average, with only about 4 people you'd rely on in a crisis and about 14 for
  sympathy.
- **afterwrd friends** are only people who've set up afterwrd themselves, so for a long while lists will be far
  shorter than on Facebook.
- **Groups** in real life (family, a friendship group, a club, a class's parents) are mostly 10–150 people.

Targets:

- 150 friends should feel as quick as 5.
- 500 should work properly.
- Beyond that it should still work, even if it catches up more slowly.
- Groups should reach 150 members.

## The free plan's walls

These are Cloudflare's published limits as of Nov 2026. Check them again before relying on them.

| Limit (free plan) | What runs into it here |
| --- | --- |
| **50 calls out per request** (fetch: to friends' sites, GitHub). Tried on a free account, 14 Nov 2026: the 51st call fails. Calls to Durable Objects don't count (tried 18 Nov 2026: 60 went through). | Home (up to 40 friends' sites); closing a group; copying a post's photos to a group |
| Database queries per request: a separate cap of about 1,000. 200 worked and 1,100 failed in the same test. Database queries do **not** count towards the 50, whatever the D1 docs suggest. | Not close |
| A Durable Object's run (the Outbox) has its own 50. In the same test, 45 queries in the Worker plus 45 calls in a Durable Object both went through. | Room for background fetching (step 3) |
| 10 ms of CPU per request | Reading and drawing many friends' posts in one page |
| 100,000 requests a day per account | Not close |
| D1: 10 databases per account, 500 MB each, 5M rows read and 100k written a day | Groups (one database each), so about 9 groups per account |
| Durable Objects (SQLite) | No per-account count that matters here |

## Where things stand

- **Home asks friends' sites while you wait.** Each visit asks up to 40 friends' sites (`SITES` in feed.js), and the
  page waits for the slowest one, up to 8 s.
- **No limit on friends.** With more than 40, Home asks the 40 that matter most this time (recent posters first, then
  whoever's turn it is), so a quiet friend's post can take a few visits to appear. Home itself won't break: the test
  of 40 calls plus 30 queries went through.
- **Your site is asked by every friend on every visit.** It answers once per friend for each time they open Home. 200
  friends opening Home 10 times a day comes to 2,000 answers a day, each reading 30 posts and their comments. That
  isn't a problem for the request allowance; the per-page limit and the waiting are what hurt.
- **Groups:**
  - 40 members, because closing a group tells everyone within one request.
  - 8 photos a post, because they're copied within one request.
  - About 9 groups per account, because each group has its own database.

## 1. Fewer lookups, and posting that feels instant (in progress)

- Your comments on friends' posts are looked up in 2 queries, however many posts there are (`markAllMine`).
- Event copies and friends' pictures are saved in one batch.
- Home's lookups, the header's lookups and your posts' details all run side by side instead of one after another.
- A comment shows straight away, faded and marked "Sending…". The button pressed pulses while it's sent. If it fails,
  the comment goes back into its box.
- A form sent in place sends the page to redraw from in an `Afterwrd-Redraw` header. When it works, the site sends
  that page back in the same reply (index.js `redrawn`), so it's one trip instead of two.

## 2. Measure (built 17 Nov 2026, uncommitted)

- **A `Server-Timing` header** on the owner's own pages and actions (src/timing.js). Friends' sites, groups and anyone
  signed out never get it. It shows in Chrome's devtools (Network → a request → Timing), including remote debugging
  on an Android phone:
  - `db`: time with a query waiting, and how many statements ran (a batch counts each one).
  - `sites`: time with a call to another site waiting (friends, groups, GitHub), and how many calls.
  - `calls`: calls out so far, other sites and Durable Objects together, "of 50".
  - `total`: from the request arriving to the reply being ready.
- **How:** AsyncLocalStorage holds each request's figures. `fetch` is wrapped once, and the request's env gets a timed
  `DB` and counted `MEDIA` and `OUTBOX` (`measured`), so no other code changes. The self-hosted D1 stand-in is
  timed the same way, and its own Durable Object calls don't count as calls out, as on Cloudflare.
- **What it can't show:** CPU time, as a Worker's clock only moves while it waits (Cloudflare's dashboard has it);
  calls made after the reply has gone (`work.waitUntil`), which still count against the 50; and the Outbox's own
  runs, which are separate.
- Next: try it on Ste's site with real friends, before and after each step.

## 3. Keep friends' posts, so Home asks nobody while you wait (built 14 Nov 2026, uncommitted)

The main change. A new table, `friend_posts` (migrations/0020_friend_copies.sql), keeps each friend's newest posts as
their site last sent them. Two new columns on `connections`, `copied_at` and `copy_until`, say when each copy was
fetched and until when it can be shown.

- **Stored after cleaning only.** Posts go in after `cleanFeed`. No keys are stored. Each friend's copy is exactly what
  their feed last sent (30 posts), so nothing else needs to be capped.
- **When a copy can be shown.** Until the first of its signed photo links expires (their sites sign them for 1–2 hours),
  less 5 minutes, or for a day if it has no photos. Only real signed links count (`/files/<hash>?exp=…&sig=`), not
  anything a friend wrote.
- **Home reads only its own database.** It shows the newest 100 friends' posts from every friend together, plus your
  own. Before this, Home could draw up to 40 × 30. It asks a friend's site while it waits only if that friend has no
  copy it can show, so it's never worse than before.
- **A note is a doorbell.** A post or comment note that's kept (within notify.js's limits) queues a re-fetch of that
  friend (peers.js). It runs in the Outbox alarm, which has its own 50 calls, after the notes.
- **Old copies are fetched again in the background.** Each time Home opens, copies older than 5 minutes are queued.
  The visit after has them.
- **Your own changes make the copy stale.** When you comment on a friend's post, edit or delete a comment, vote or
  answer one of their events, that friend's copy stops being shown until it's been fetched again
  (feed.js `copyChanged`). Otherwise your comment would vanish when you reopened Home.
- **Nothing is fetched when nobody's looking.** Unchanged posts aren't rewritten (`WHERE data IS NOT excluded.data`).
  That keeps within D1's 100,000 rows written a day. Photo links change hourly, so a post with photos is rewritten at
  most about once an hour while you're active.
- **No change between sites**, so it works with friends on older versions. A friend's own page still asks their site
  live.
- **Removing a friend** deletes their copy (events.js `friendGone`).
- **After the 14 Nov security review:**
  - Background fetches are rationed to 48 a day per friend, so a friend's notes can't use up your database writes.
  - At most 30 posts are kept per friend, and a post dated in the future is filed as now.
  - A friend who removes you has their copy deleted as soon as their site says so.
  - An invitation taken back removes that post from the copy at once.

How it feels:
- A friend's new post or reply shows within seconds, through the doorbell.
- An edit, or a new profile picture (no note is sent for either), shows within a few minutes of using the site.
- A copy whose photo links have run out is fetched while Home waits, as before. So someone who opens Home once a day
  still waits on that first visit.
- **Longer photo links in feeds: not for now** (Ste, 14 Nov 2026: keep 2 hours and see how it feels). If a friend's site signed feed photo links by the day (1–2 days)
  instead of the hour, copies would last a day: even a once-a-day visit would be instant, and far fewer rewrites
  would be needed.
  - It's a small change on the sending side, for example `/_peer/feed?links=day`. Older sites would just ignore it.
  - The cost: a removed friend could still open photos they'd already been shown for up to two days, instead of two
    hours.

Not done yet:
- **Home has no "older posts" link** past the newest 100 friends' posts.
- **Live updates.** live.js's "N new · Show" still counts post notes, which is right, as the doorbell will usually
  have fetched the post by the time it's tapped.

## 4. Phones keep scripts and styles

Static files are sent marked "check every time" (static.js). That's one wait per file on every page, small but slow
on a phone network.

- Give each file's address its fingerprint (`/static/ui.js?v=<hash>`) and serve it as `immutable`.
- The site still checks every file against the release before sending it, and the fingerprint in the address pins
  its content.
- Check the effect on friend checks (checks.js) before relying on it.

## 5. In the browser

1. **Prefetch on tap.** Speculation rules, at "moderate": Chrome starts loading a link on pointer-down on a phone, or
   on hover with a mouse. That saves 100–300 ms per tap. Only use it for pages that don't call friends' sites, until
   step 3 makes Home and Friends cheap. Safari ignores the rules, which does no harm.
2. **Photos.** Friends' photos come by links signed for 1–2 hours, so the browser only keeps them that long.
   - Option: sign thumbnails by the day.
   - Cost: a leaked thumbnail link then works for longer.
   - Lazy loading is already on.
3. **Topping up Home from the browser, in slices.** Once Home shows from the stored copy, the page asks for fresher
   copies of the friends on show, about 10 friends per request. Each request has its own 50, so a list of 500 friends
   never meets the limit.
   - New posts arrive through the existing quiet "N new · Show" bar. Nothing jumps.
   - Newer comments are swapped quietly into posts that aren't on screen.
4. **A service worker copy of Home.** This would open the home-screen app instantly, even offline. Only do it if Home
   is still slow after steps 3–5. It would have to be cleared on Sign out, like drafts.

## 6. Groups

- **Tell members in the background.** Send group closes and removals through the Outbox, so they no longer have to fit
  in one request. That lets the cap rise from 40 to 150.
- **Copy photos in the background too.** Done after the post instead of during it, so the cap of 8 photos a post can
  rise.
- **More than 9 groups per account.** Keep groups in Durable Objects (SQLite) inside a group Worker, instead of a
  database each. This is a big change; only do it if people actually reach 9.

## Deep dive (17 Nov 2026)

### What was measured

On Ste's site (0.55.0, from a laptop in London, with the cache off):

| Page | Queries | Database | Friends' sites | Total in the Worker | Browser waited |
| --- | --- | --- | --- | --- | --- |
| Home | 43 | 363–366 ms | none | 366–403 ms | 690–740 ms (once 360 ms) |
| A friend's page | 14 | 183 ms | 535 ms, 1 call | 718 ms | 826 ms |
| A friend's post | 15 | 171 ms | 714 ms, 1 call | 885 ms | 949 ms |
| Ste's own post | 21 | 170 ms | none | 170 ms | 267 ms |

- **CPU (Cloudflare dashboard, a day):** median 3.9 ms, P90 15 ms, P99 27 ms, peaks 40–47 ms. The free plan's limit is
  10 ms, so the busiest pages (Home) go 3–4 times over. That works now, as Cloudflare is lenient about bursts.
- **Home's page is small:** 10.6 kB compressed, so its size isn't what's slow.
- **Every script and the stylesheet** cost 60–120 ms each. Each request also looked up the session in the database.
- **Friends' photos** take about 0.5 s each, against 70–130 ms for Ste's own. The cause is on the friends' sites, and
  is still unknown.

A throwaway Worker and database in London (17 Nov, deleted straight after) timed 20 small queries:

| How | Time |
| --- | --- |
| one after another | 255–335 ms (one query: 10–25 ms) |
| side by side (`Promise.all`) | 36–61 ms |
| as one `db.batch` | 20–47 ms |

So D1 handles queries side by side well. What costs is **queries that wait on each other**. Batching adds a little on
top. With a 15 ms delay per query on a test site (`TEST_DB_DELAY`), Home turned out to make 9 waits in a row.

### Done so far (17 Nov, uncommitted)

- **Home: 9 waits in a row down to 3 or 4.** On a test site with the delay, its database time went from about 160 ms
  to about 80 ms.
  - Each page's own lookups start alongside the header's. They run straight away for pages shown whatever's
    published, and the post page now counts as one of those.
  - A post's photos load alongside its other details, and so do a comment's earlier versions and whether it's
    still editable.
  - Friends' copies are read alongside the friends list.
  - The reminder's facts are looked up alongside everything else.
  - The Outbox is handed its refresh list while the rest of Home is read.
- **Friends' pages:** their site is asked alongside the Facebook-link lookup, and the follow-up work runs side by side.
- **Your own post:** one lookup fewer.
- **Scripts and the stylesheet are kept for good,** fetched by their fingerprint (`?v=<16 hex>`). An import map gives
  the scripts' own imports their fingerprints too. On a test run, static file requests fell from about 1,450 to 184.
- **The timing header** now also shows rounds (how many fresh waits for the database), and `sql`: the time D1 spent
  running the queries and the rows they read.
- **Test sites can be made as slow as Cloudflare:** `TEST_DB_DELAY` and `TEST_SITE_DELAY`, for `ALLOW_LOCAL_SITES`
  sites only.
- **Memories by index** (migrations/0022_day_index.sql, `posts_day`): "on this day" goes straight to today's date in
  earlier years. Checked in wrangler's local D1: `SEARCH … USING COVERING INDEX posts_day`.
- **Posts, Photos and their pages start alongside the header too.** They wait for `ctx.chosen` (a promise until the
  header's batch is back) instead of for the whole header. Posts, Comments and Likes now get their page of rows,
  their kinds and their years all at once, not one after another.
- **Fonts are kept for a week.** They're named in the stylesheet, so they can't carry a fingerprint: give a font a new
  file name if it ever changes.
- **Prefetch on tap** (speculation rules, `moderate`) for the owner's own pages that only read the site: Posts, a post,
  Photos, Memories, Friends, the Facebook pages. Home is left out (it can ask friends' sites whose copies have run
  out), and so are Events (it asks groups' sites), friends' and groups' pages, and Notifications (opening it marks
  things seen).

What was tried and taken out, or decided against:

- **A friend's post from Home's copy** (built, then taken out the same day). The events test caught it: Bob opened
  Ann's event and didn't see Cat's answer, as nothing tells Bob's site when a third person answers, votes or comments
  there. A copy can't promise to be current for those, even seconds after it was fetched. The right design is to show
  the copy first, then have the browser ask for the live page and swap in what's changed (step 5.3). It must never
  swap while someone's typing.
- **A friend's page from the copy:** not without a protocol change. Their page includes the Facebook posts they share
  (`/_peer/posts`), and the feed and copies only hold posts written on afterwrd.
- **The header's lookups from memory:** now that each page's own lookups run alongside the header's, it would only
  save about 5–10 ms a page. That isn't worth a migration and invalidation triggers.
- **Home's CPU isn't drawing the page.** A benchmark of `homePage` with 100 friends' posts, 2 photos and 3 comments
  each (370 kB of HTML) took 2.8 ms warm and 5.6 ms on a fresh start, and unpacking the 100 copies took 0.2 ms. The
  minified Worker is about 960 kB: views 210 kB, plus the passkey and certificate libraries (`@simplewebauthn`,
  `asn1js`, `@peculiar/x509`) at about 200 kB. Which requests make the 27–47 ms peaks is still unknown. Imports,
  exports, uploads (hashing), push notifications and the Outbox's refreshes are all candidates. `wrangler tail`
  shows CPU time per request.

### The privacy model, for anything that keeps a copy

What's private stays in two places: the owner's own Cloudflare account, and their own devices. Friends' things are kept
only as short-lived copies that have been cleaned first. Those copies never outlive the friendship, and nothing goes to
anyone else's cache or service. Judged against that:

| Idea | Where the copy lives | Verdict |
| --- | --- | --- |
| The browser keeping scripts, styles, fonts and your own photos | your device; the same for every site | **Fine** (done for scripts and styles) |
| Remembering rarely-changing lookups in the Worker's own memory | your Worker, gone when it stops | **Fine** |
| Showing a friend's page and posts from the copies Home already keeps | your database, under the 14 Nov rules | **Fine:** no new data, the same copies |
| Prefetching your own pages on tap (speculation rules) | your device | **Fine**, but not pages a GET changes (Notifications marks them seen) |
| A service worker copy of Home, so the app opens at once | your device; includes friends' posts | **Fine with care:** cleared on Sign out, as drafts are |
| Cloudflare's Cache API for signed-in pages | Cloudflare's shared edge cache | **No:** one wrong cache key shows a private page to a stranger, and it may not work on workers.dev at all |
| Workers KV | another product, written slowly everywhere | **No:** 1,000 writes a day on the free plan, and one more place personal data sits |
| Copying friends' photos onto your site | your database | **No:** today a friend controls their photos through links that expire; a copy would take that away |

### Where the CPU goes (17 Nov, after 0.56.0's changes)

`wrangler tail` on Ste's site (0.55.0, read-only, a few minutes of browsing; raw log deleted afterwards):

| Request | CPU (median / max) |
| --- | --- |
| Home | 49 / 72 ms |
| one of his posts | 47 ms |
| a friend's page | 15 / 52 ms |
| a group, a group post | 31–32 ms |
| Photos, an album, a person, Notifications | 19–26 ms |
| the Outbox's run | 17 ms |
| scripts, styles, photos | about 1 ms |

The same page varied a lot (Home: 72, 19 and 49 ms; Overview: 6 ms).

A local test site, profiled through the inspector (`Profiler.start` over CDP):

- **Warm, Home used 7.6 ms of JavaScript, even with little data.** About 3 ms of that is D1's own client code in the
  Worker: `_send`, `toJson`, reading the reply's `text`, and tracing spans for each call. So **every query costs CPU
  as well as waiting**, and more for bigger results.
- **On a freshly started Worker, the first visit used 12–21 ms.** Code is compiled the first time it runs. With little
  traffic, many visits land on a fresh copy of the Worker, which explains most of the spread on the live site.

What that points to:

1. **Fewer, bigger queries.** A `db.batch` of 9 statements is one send and one reply, where 9 separate queries are nine
   of each. That saves CPU even where it saves no waiting. Start with the header's lookups and Home's big wave.
2. **Smaller results.** `SELECT *` and `p.*` where a page needs a few columns. `connections` is read whole several
   times a page.
3. **Less code to compile on a fresh start.** The bundle is about 960 kB minified; wrangler doesn't minify by default.
   Try `minify: true`, and check the release's code checks still match.
4. **The Durable Object design** would remove D1's client overhead too: `sql.exec` in the object costs microseconds.

### The "site in an object" prototype (17 Nov, uncommitted)

- **What was built:**
  - With `SITE_STORE=object`, the Worker hands every request to an Outbox object named `site`. There's no new kind of
    object (scripts/release.mjs).
  - That object holds the site's database in its own SQLite (src/sqlite.js, a D1-shaped layer like
    selfhost/d1.js) and runs app.js on it.
  - The other objects (the outbox) reach the database through it.
  - The visitor's `request.cf` goes along in an `Afterwrd-Cf` header that the Worker always sets.
  - Locally, with the switch on, the core, feed, albums and events suites pass (`TEST_VARS="--var SITE_STORE:object"`).
- **On Cloudflare** (a test site, afterwrd-object-test, with Ste's site copied in), compared with his real site on
  0.56.0:

  | Page | Browser waited (real site) | Browser waited (in an object) |
  | --- | --- | --- |
  | Home | 297–381 ms | 72–111 ms |
  | his post | 267 ms | 92 ms |

  The queries take no measurable time: "0 µs" for Home's 39, and for the post page's 20.
- **Known so far:**
  - **Whole numbers bind as decimals.** The object's SQLite binds `5` as `5.0`, so a text column keeps `"5.0"`, and
    BigInt isn't accepted. selfhost/d1.js has the same problem. Fix: write whole numbers into the SQL as literals.
  - **The very first request** after deploying failed once (a 500) while the object made its tables.
  - **Still to measure:** waking after a quiet spell.

**Free-plan limits** (Cloudflare's pages, read 17 Nov; four of the five updated 13 Nov):

- Durable Objects (SQLite only on Free), per account, per day:
  - 100,000 requests (each RPC call counts as one);
  - 13,000 GB-s of active time (about 28 hours at 128 MB). It counts while working or waiting on I/O, but not while
    idle and able to hibernate;
  - 5M rows read and 100k written, as D1 has, **but shared with photos**;
  - 5 GB of storage in total (1 GB per object), **shared with photos**.

  Over a limit, operations fail until 00:00 UTC.
- **Large imports need to carry on the next day:** a very large Facebook import could use up the 100k writes in a
  day.
- D1 Free: 10 databases, 500 MB each, Time Travel 7 days, and now **"50 queries per Worker invocation"**. (Home runs
  42; our 14 Nov test got 200 through.)
- Object point-in-time recovery covers 30 days, through code only. The page doesn't say whether it's on Free.
- **CPU, tested with a throwaway Worker and object** (17 Nov, deleted after). A Worker on the free plan got through
  about 800 ms of CPU but was stopped (`exceededCpu`, error 1102) at about 2 s, so the 10 ms limit is loosely
  enforced. An object ran 2.9 s of CPU without complaint: objects get the 30 s default on the free plan. So **pages
  built inside the object escape the 10 ms limit**, and the Worker in front uses about 1 ms.

### What's left, by likely payoff

1. **How much one query costs** (measured 17 Nov with a second throwaway Worker, D1 database and Durable Object in
   Ste's account, all deleted straight after). From London, 20 small queries:

   | How | Time |
   | --- | --- |
   | D1, one after another | 330–480 ms (one query: 15–20 ms) |
   | D1, side by side | 51–83 ms |
   | inside a Durable Object's own SQLite, including the trip to it | 16–26 ms (250–300 ms the first time it wakes) |

   - **Smart Placement can't help here.** The test database was in London itself (D1 said WEUR, served from LHR, as
     primary), the Worker ran in LHR, and Cloudflare reported `cf-placement: local-LHR`. There's no distance to
     remove: the 15–20 ms per query is D1's own overhead. (It might still help someone whose database ended up in
     another region.)
   - **The site's database in a Durable Object** (SQLite in the object, as self-hosting already does). The page is
     built inside the object, so a whole page's queries cost about what one D1 query costs today, and query
     chains stop mattering. The costs:
     - About 0.3 s to wake the object after it's been idle.
     - A move of every site's data (the move feature is most of it).
     - D1's dashboard console is lost.
     - Backups become the object's 30-day point-in-time recovery.
     - Friends' checks of what a site is bound to change.
     - The installer and Update flow change.

     This is the lever that makes database speed stop mattering. It's a decision for later, once the cheaper steps
     below have been measured.
2. **Friends' posts from the stored copy, then topped up live in the browser** (see "tried and taken out" above).
   This removes the 0.5–0.7 s wait in most cases, but only with the top-up, so other people's latest answers and
   comments still show.
3. **The rows each page reads.** Ste's figures from the new `sql` entry will show whether a query looks through a whole
   table.
   - Known now: Memories ("on this day", on Home too) reads posts newest-first until it finds a match. On a large
     Facebook archive that can be thousands of rows. An index on the day of the year makes it direct; tested in SQLite
     3.54: `CREATE INDEX posts_day ON posts(strftime('%m-%d', created_at, 'unixepoch'), created_at)`. Check it in
     D1, and match the query to the index's expression exactly.
4. *(Decided against for now: see above.)* **The header's lookups from memory.** About 9 queries on every page (sections, name, pictures, friends' faces,
   latest release…) rarely change. Keep them in the Worker's memory, with a version number every change bumps,
   checked in the session lookup that already runs. Most pages then have one database round before their own
   lookups.
5. *(Done: kept a week.)* **Fonts:** they're still checked on every page. Give them a fingerprint, as the other files have, or keep them a day.
6. **CPU** (27–47 ms against 10): it isn't Home's drawing (see above). Next, find which requests it is with
   `wrangler tail`. (First guess, before the benchmark: profile Home with 100 friends' posts.)
   Likely candidates: unpacking every copy (`JSON.parse` of 100 posts), and drawing everything at once. Drawing the
   first 20 and the rest as you scroll would cut both.
7. **Sending the page's head straight away** (streaming), so the browser fetches the stylesheet and scripts while the
   database is still answering. Fingerprinted files make this matter less. The catch: once sent, a page can't turn
   into a redirect or an error page.
8. *(Done, for the pages that only read this site.)* **Prefetch on tap,** for pages that don't change anything when opened. Speculation rules send
   `Sec-Purpose: prefetch`, which a page could use to skip its side effects.
9. **Friends' sites answering slowly** (0.5–0.7 s). This is on their side. They'll get faster with everything above
   once they update. Worth one look at why a friend's photo takes 0.5 s: time one signed photo link with `curl`.
   Where the installer puts a new site's database (it gives D1 no location hint) may matter.

## Scale test (17–18 Nov 2026)

503 sites on one computer, in the self-hosted image: three hubs (Sam Taylor, with 5, 150 and 500 friends), 500 others
(Ann Example, each with 30 posts and about 10 friends) and two groups (40 and 150 members). Calls between sites were
made as slow as on Cloudflare: 0.5–0.7 s; 5% take 1.5 s, 2% hang and 1% fail. Every object run had the free plan's
50 calls out enforced. How to run it: worker/test/scale/README.md. Full figures: test/scale/out/report.md (not kept in
git).

### What breaks, in order of how much it matters

1. **The Outbox makes one call to the site object per friend it refreshes.**
   - In the test, refreshing 40 friends' copies in one alarm made 81 calls: 1 to claim the ration, 40 fetches, then 40
     saves, each save a call to the site object (since 0.57.0).
   - The harness counted calls to objects towards the 50 and refused the rest. Home then kept asking 6–41 friends'
     sites live, and only 15 of 50 new posts were on Home 10 s later.
   - **Then tried on Cloudflare (18 Nov 2026, a throwaway Worker in Ste's personal account, deleted after): calls to
     Durable Objects don't count towards the 50.**
     - 60 RPC calls and 60 `stub.fetch` calls to another object went through: from a Worker, from an object's
       request, and from an alarm.
     - 45 fetches then 10 object calls also went through.
     - The 51st plain fetch failed, in a Worker and in an object ("Too many subrequests by single Worker
       invocation").
   - So this was never broken on Cloudflare. timing.js and the harness now count only fetches towards 50, and show
     object calls separately.
   - **Still worth fixing, and fixed:** every call to an object is one of the account's 100,000 object requests a day.
     A refresh now saves all its copies in one call instead of one per friend.
2. **Closing a group of 150 told only 49 members.** Closing tells everyone within one request (groups.js close), so
   the 50 runs out.
   - The code also slices to `maxMembers + MAX_WAITING`, which is fine at today's 40.
   - Step 6 (telling members through the Outbox) is needed before the cap rises.
   - An @here post did reach 144 of 150 within the wait, through the Outbox. Its batches of 40 work.
3. **Rows written a day, for people with many friends.**
   - Keeping one friend's copy writes 3 rows when nothing changed and 17 when the hour has turned: friends' photo links
     are signed to the hour (share.js), so every photo post is rewritten. A first copy is 93 rows. Each refresh also
     claims 1 row of ration.
   - With 500 friends, opening Home in 10 different hours of a day comes to about 10 × 500 × 18 = **90,000 rows**,
     against 100,000 a day.
   - The squeezed day already reached 33,000 rows for the 500 hub, with three-quarters of its saves refused. With 150
     friends it's about 27,000 rows, which is fine.
   - **Fix:**
     - Keep friends' photo links out of the stored post, as one small row per friend, so a new hour rewrites 1 row,
       not every photo post.
     - Make the three bookkeeping updates (checked, answer, copied) one.
     - Together: about 2 rows a refresh, so about 10,000 a day for 500 friends.
     - This keeps 2-hour photo links. Day-long links (step 3) would do it too, but give photos away for longer.
4. **Home reads every stored copy to show 100.**
   - SQLite fetches the copies friend by friend, then sorts them all. For the 500 hub that's 25,000–52,000 rows read
     a visit and 30–44 ms of CPU, growing as copies fill in.
   - `+connection_id IN (…)` makes it walk `friend_posts_newest` and stop at 100: 0.11 ms against 2.5 ms on the
     hub's data, with the same dates in the same order.
   - One character in feed.js loadFeed.
5. **A first Home with many friends waits up to 8 s.**
   - It asks up to 40 sites live and waits for the slowest. With 2% of calls hanging, more than half of such visits
     meet one.
   - Shorten the live wait (3 s, say), or show the copies and top up in the browser (step 5.3).
6. **Answering a friend's feed reads about 490 rows** (`/_peer/feed`).
   - A popular site is asked by every friend each time they refresh. 500 friends opening Home 10 times a day is about
     2.5M rows read a day on its account, half the 5M.
   - Look at that query next.

### Decided (18 Nov 2026, Ste): fixes 1, 2 and 4, and day-long photo links for friends

Built on the `scale-test` branch, then checked with the scale test again.

- **Photo links for friends last a day, and stop working when the friend is removed.** This replaces the 14 Nov "keep
  2 hours" decision.
  - What the scale test showed:
    - Hourly links rewrite every photo post in every stored copy each hour (17 rows a refresh against 3), most of
      the 90,000 rows a day at 500 friends.
    - A stored copy only lasts until its first link runs out, so a once-a-day visitor always waits for live asks.
    - Phones download friends' thumbnails again every hour, as the address changes.
  - Prior art: Google Photos' API links last an hour, Dropbox's temporary links 4 hours, Discord's attachment links
    24 hours (since late 2023), Facebook's image links a few days, and S3 or Google Cloud signed links up to 7 days.
  - **Signed to the day:** valid for 24–48 hours, all changing at 00:00 UTC, the same address all day.
  - **Each link is for one friend:** the 32 bytes of `sig` are the friend's connection number (4 bytes) and an HMAC
    of the file, the expiry and that number (28 bytes). It's a different message from the plain links' HMAC.
    - The site checks the friend is still connected before serving.
    - So **removing a friend stops their links at once**, where today they work for up to 2 hours. (Photos their
      browser already has stay there, as now.)
    - A link that leaks works for up to 48 hours instead of 2, but only someone who was shown the photo could leak
      it, and the link now says whose it was.
  - **No protocol change:** the link keeps exactly the `?exp=<digits>&sig=<43 characters>` shape older sites check
    for (friends.js `signedLink`). Their copies simply last longer.
  - Unchanged:
    - profile pictures and covers (7 days, not per friend);
    - groups' photo links, and the links a member's site gives its group for copying photos (hourly).
  - Not covered, and that's fine (Ste): someone uninvited from an event keeps working links to its photos until they
    expire, as the check is per friend, not per post.
- **Fix 1, the Outbox's calls:** a refresh keeps all its friends' copies in one call to the site object (each friend
  still in its own transaction). Invitation results are saved in one call per batch. Calls to objects turned out not
  to count towards the 50 (see 1), but each is an object request, so a refresh now makes 1 instead of 40.
- **Fix 2, closing a group in rounds:**
  - The owner's site asks the group to close, then to carry on, until it says nobody is left to tell. Each round is
    a new request with its own 50 calls.
  - The first round empties the group and keeps a short list of who's still to be told. Each round tells up to 30
    people.
  - A round that gets no answer is asked for again, up to twice running. That's safe: the group saves who's left before
    telling them, and once closed it carries on for the owner's key. (The scale test's first run lost a whole
    40-member close to one dropped call.)
  - If three rounds in a row get no answer, the owner's site stops and deletes the group all the same, as it always has
    for a group it can't reach. The members not yet told then aren't told.
  - On Cloudflare the group's Worker is deleted only after that.
  - An owner's site on an older version asks only once, so it would tell only the first 30, not 50. Groups update
    with their owner's site, so this shouldn't arise.
  - At today's cap of 40 (and 10 waiting), closing tells at most 50 and fits. Removing the group's photos is calls to
    objects, which don't count.
- **Fix 4:** Home picks its 100 newest friends' posts by walking `friend_posts_newest` (`+connection_id`).

### After the fixes (18 Nov 2026, same network and delays)

| | Before | After |
| --- | --- | --- |
| Calls refused (the squeezed day, all sites; counting object calls, as the harness then did) | 1,945 on the 500 hub alone | none (most in one run: 43) |
| Home, 150 friends, warm | 0.6–8 s, up to 41 live calls, 11,000 rows | 11 ms, no calls, 1,660 rows |
| Home, 500 friends, warm | about 730 ms, 6 live calls, 25,600 rows | 10–12 ms, no calls, 4,159 rows |
| New posts on Home after a burst of 50 | 15 at 10 s, 28 at 60 s | 10 at 10 s, 45 at 60 s |
| Closing a group of 150 | 49 of 149 told | 146 of 149, in 5 rounds of up to 30 calls |
| Closing a group of 40 | 39 of 39 | 37 of 39, in 2 rounds |
| The day, 500 hub: rows written / read | 33% / 27%, with three-quarters of copies thrown away | 18.8% / 18.3%, every copy kept |
| The day, 150 hub: rows written | 8.0% | 5.3% |

The few not told when a group closes are members whose own call was dropped (the test's 1% failures and 2% hangs).
That call isn't retried, as before. The day still keeps refreshes within a day of photo links, so its writes are about
what a real day would be.

Tests: type checks; the sqlite and sitecopy unit tests; e2e core, feed (with new checks that a friend's link runs to
the end of the next day, keeps the old shape, can't be stretched, and stops once the friend is removed), albums,
groups and forged.

### The open items, done (18 Nov 2026)

- **Calls to objects:** tried on Cloudflare, and they don't count towards the 50 (see "What breaks", 1).
- **One row per refreshed friend, not three.** When the friend was asked, whether they answered and when their copy
  was made are now one update to their row (feed.js askSites). A refresh where nothing's changed writes 2 rows (that,
  and the ration), against 4 before.
- **Answering a friend's feed reads less** (`/_peer/feed`). Measured per statement with the harness, which now logs the
  heaviest statements of any run reading over 200 rows:
  - Of about 560 rows, 140 came from checking, each time the object woke, whether the move from D1 had finished.
    It looked for the table in `sqlite_master`, which reads every table and index the site has. It now asks the table
    directly (sitecopy.js `copied`): 1 row.
  - About 210 were polls, votes, events and invitations being looked up one post id at a time, even on a site with
    none. They're now read by the range of the 30 posts' numbers, which reads only rows that exist (polls.js
    `sitePolls`, events.js `eventsFor`).
  - Result: about 190 rows an answer (photos 50, comments 31, and the posts themselves are most of it), against 426,
    plus 140 more the first time after waking.
  - For a site with 500 friends refreshing it 10 times a day: about 1M rows read a day, against 2.1M (and up to 0.7M
    more for waking).
- **Home waits at most 3 s for a friend's site with no copy to show,** not 8 s. One that doesn't answer in time is
  queued for the Outbox to fetch in the background, with the full 8 s. Before, a failed live ask was left until the
  next Home.
- **Checked at scale** (same network, 18 Nov):
  - The first Home with 150 or 500 friends waited 1.5–1.6 s, against 8.1 s; warm Home 8–12 ms.
  - Feed answers read a median of 173 rows, against about 490.
  - After a burst of 50 new posts, 46 were on Home a minute later. At 10 s it varies (3, 10 and 15 across runs), with
    how much the Outbox still has queued from the first visit.
  - The full e2e suite passes (all 19 suites), as do the type checks and unit tests.

### Security review (18 Nov 2026)

An independent review of the changes found nothing high or medium. It raised four low points:
1. A friend's link outlives unsharing (an uninvited guest, a photo taken off a post) by up to 48 hours instead of 2.
   Accepted (Ste): the friend was already sent the photo.
2. All of a refresh's copies went in one call, so that call failing would lose them all. **Fixed:** if it fails,
   each friend's batch is sent on its own.
3. `TEST_SCALE` alone switched on the test-only code, whose log lines included paths with link tokens. **Fixed:** it
   needs `HOSTING=self` too (as `ALLOW_LOCAL_SITES` needs a local address), and long path parts aren't logged.
4. Home's 3 s timeout marked a slow friend as missing and "couldn't reach". **Fixed:** a timeout on Home only notes
   that they were asked. The background refresh, with 8 s, decides whether they're reachable.

### 0.58.0 couldn't be installed on 0.57.0 sites (18 Nov 2026), fixed in 0.58.1

- **What happened on Ste's site:** the update put 0.58.0 live, and three minutes later put 0.57.0 back ("didn't
  start"). `wrangler tail` showed why:
  - The Worker ran the new version straight away, but the site's Durable Object kept running 0.57.0's code the whole
    time.
  - Since 0.57.0 the health check (`/_version?health=1`) was answered inside that object, so it always gave the old
    version's id, and the update never counted as healthy.
  - The Update page's progress checks (a database read each second) and the health checks themselves kept the object
    busy.
- **Tried on Cloudflare** (a throwaway Worker, deleted after):
  - An object asked every second kept its old code for over 2½ minutes after a switch.
  - An object that restarts itself (`ctx.abort`) comes straight back on the new code.
  - One left alone for 15 s came back on the new code by itself.
- **The fix (0.58.1), which has to work with 0.57.0's own update steps, as they're what's running:**
  - `/_version` is answered by the Worker, with its own id. With `?health=1` it also asks the site's object for its
    health, so a broken object still fails the check.
  - The Worker passes its version (`Afterwrd-Front`) with every request to the object. An object running an older
    version restarts itself, and the Worker asks again. Requests with a body get "try again" instead, as they can't
    be sent twice.
  - From 0.57.0 to 0.58.1, the object can't restart itself (0.57.0's code doesn't know how), so it runs 0.57.0's code
    until the site has had about 15 seconds of quiet. Then it's on 0.58.1. The two work together meanwhile.
- **Why the tests didn't catch it:** on this computer, and self-hosted, the Worker and its objects always run the same
  code. Only Cloudflare keeps a busy object on old code after a switch.

### Groups, and 0.58.2 (18 Nov 2026)

- 0.58.1 updated Ste's site, but its group was put back ("didn't take 0.58.1").
  - A group's switch was checked through `/_group/ping`, answered by the group's object, which kept 0.57.0's code
    while the checks kept it busy, and so the old version.
- 0.58.2 checks a group as a site is checked:
  - the group's Worker answers `/_version` as the new version;
  - and `/_group/ping` still answers as a group, whichever version.
- Ste's update to 0.58.2 (watched with `wrangler tail`):
  - The site's object saw the newer front door and restarted itself at once ("…running older code than its Worker,
    so it has restarted").
  - The switch took 8 s and the whole run 43 s, against 3 minutes and more before. The group came along in the same
    run.
- Lessons:
  - Groups only move to a signed version, and GitHub serves the signature list up to 5 minutes stale. Update about
    5 minutes after signing.
  - "Get updates first" removes the waiting days, not the daily time: "Install it now" is the way to update at once.

### What's fine

- **5 friends:** Home 13 ms warm, 8.5 ms CPU. A friend's page waits 0.6 s (their site), with 2–4 ms of CPU.
- **One post reaching 500 friends:** half told in 34 s, 90% in 54 s, all 500 by 7 minutes, after retries of
  dropped calls. Each Outbox batch of 40 stayed within the 50. All 500 friends' sites coming back for the post at
  once cost the hub 1–9 ms each.
- **The squeezed day** (170 people: Home 10 times, a post, 5 comments and 2 friends' pages each; 3,060 actions):
  - Home 21 ms median, 49 ms at the 90th percentile.
  - Posting 15 ms, with a photo 36 ms.
  - Comments and friends' pages 0.6 s (one friend's site).
  - Every account stayed far inside the day's object requests (at most 2.9%) and active time (at most 3.1% of
    13,000 GB-s, counting each run 10 s longer).
  - Rows read: 27% for the 500 hub. Rows written: 33% for the 500 hub (see 3); 0.4% for a typical person.
- **CPU per page is small inside the object:** Home 5–15 ms warm (more for the 500 hub, see 4), well within the
  objects' 30 s. It's this Mac's CPU, from V8's profiler, so compare cases with it rather than quoting it as
  Cloudflare's.
- **Self-hosting:** one workerd can hold about 250 sites (about 15 MB each; V8 gives a process 4 GB), far more than one
  person and their groups. The test ran three.

### How far to trust it

- The delays and failure rates are a guess shaped by the 0.5–0.7 s measured on Cloudflare. How often calls hang or
  fail on Cloudflare hasn't been measured.
- Squeezing a day into 30 minutes keeps most refreshes within one hour. Rows written in "the day" are a floor; the
  hour-turn figures in 3 come from a separate run across midnight.
- Active time counts only while a run is going (and, as an upper bound, 10 s after). Cloudflare's meter may differ.
- One unexplained miss: a friend's page twice said it couldn't reach one site while the network was busy, and never
  when quiet. It was probably the injected failures; worth watching.

### 1,000 sites on a rented server (18 Nov 2026, 0.58.2)

1,005 sites on an Exoscale CPU Huge server (32 GB, 16 cores, about 1.20 CHF for 2.5 hours): hubs of 150, 500 and 1,000
friends, groups of 150 and 300, and the same delays. The day was squeezed into 60 minutes, with each person's 10 Home
visits evenly spread, so every visit found copies over 5 minutes old and refreshed every friend, as in a real day. Full
figures: worker/test/scale/out/exoscale/mid/report.md (not in git). How to run it: worker/test/scale/README.md ("On a
rented server"). The account only allows servers up to 32 GB, so a 2,000-site run spreads over several (README.md, "On
several machines": two or three CPU Huge servers).

**The first limit a popular person meets is rows read, and most of it is friends reading them.**

| The day, per account | Rows read | Rows written | Object requests |
| --- | --- | --- | --- |
| 150 friends | 7% | 8% | 1% |
| 500 friends | 21% | 22% | 3% |
| 1,000 friends | 52% | 40% | 6% |
| A typical person (about 10 friends) | 0.2% | 0.5% | 0.1% |

- For the 1,000 hub, 43% of rows read were its answers to friends asking for its posts (`/_peer/feed`: 4,286 answers,
  about 260 rows each), 34% saving its own copies of friends' posts (about 2,100 rows read per batch of 40), and 9%
  the Outbox.
- Only a third of its friends were active. Each asked for its posts about 13 times in the day. **If all 1,000 used
  afterwrd that day, the answers alone would read about 3.3M rows,** and with its own refreshes it would be at about
  5M, the day's limit. Rows written would still be under half.
- So about 1,000 friends who all use afterwrd daily is where the free plan runs out, and for reads, not writes.
- The cheapest lever looks like answering "nothing new" cheaply: a friend asking for posts says what it last got,
  and an unchanged site answers by reading a row or two. Most refreshes find nothing new. Not built or tested.
- Why an answer costs 260 rows on the 1,000 hub but about 160 on the others isn't known yet. It may be the extra
  comments its posts got (every active person was its friend), or a lookup that grows with friends.

**A member list longer than 200 is cut at 200** (membership.js `parseGroupMembers`, `slice(0, 200)`).
- The list is sorted by name, so in a group of over 200, an admin can't see or approve anyone waiting past the 200th.
  Setting up the 300 group stuck there.
- Harmless at today's cap of 40, but it must change before the cap goes above 200. A group event's people list has the
  same 200 cap (events.js `people`).
- The test raised it to 1,000 on the server's copy only.

**Fine:**
- Not one call out was refused in 242,526 object runs; the most in one was 41.
- Home warm: 14 ms (150 friends), 16 ms (500), 22 ms (1,000), all from stored copies. First Home: 0.7–3.2 s.
- One post reaching 1,000 friends: half told in 56 s, 90% in 100 s, all by 7.3 minutes. Their 970 requests for the
  post cost the hub 2–4 ms each.
- Groups of 300: @here reached 292 of 300, and closing told 293 of 299, in rounds. A group of 150: 146 and 142.
- The day: 6,066 actions; Home 18 ms median, 31 ms at the 90th percentile. 58 of 1,685 comments (3.4%) failed with
  400s from friends' sites, about the injected 3% of calls that fail or hang.
- Memory: about 26 GB for 1,005 sites, a little under the Mac run's figure per site. CPU was barely used (load 0.4 on
  16 cores), so the timings weren't squeezed by the server.

**Running it:** two problems that would have cost a 2,000-site run, now handled in the server setup:
- Ubuntu's automatic updates restarted containerd during the run, which killed an image build.
- Ubuntu allows 65,530 memory maps per process, against 262,144 under Docker on a Mac.

### 3,000 people on eight servers (19 Nov 2026)

3,000 people on 8 Exoscale CPU Huge servers (32 workerd processes, about 17 CHF for 4 hours), in a network shaped like
Facebook's (`net.mjs --model social`): friends median 204, average 281, 459 people with over 500 and 71 over 1,000, the
most 1,931; 422,127 friendships; groups of 50, 150, 300, 600, 1,000 and 2,000, each its own site. A day of lurkers,
regulars and busy people (1,616, 1,047 and 337), squeezed 8 times into 2 hours, with Cloudflare's delays and failures.
Full figures: worker/test/scale/out/exoscale-multi/social-20261119-1116/report.md (not in git; run
social-20261119-1116 in the results bucket).

**The run.** 65,000 actions (33,800 Home visits, 2,073 posts, 10,090 comments, 11,594 group opens), 0.6% failed. Not
one call out was refused in 16.4M object runs; the most in one was 41.
- drive.mjs crashed at the very end of the day, reading 2 GB of new measuring lines in one go, so the day's summary
  (results/social-day.json) was rebuilt afterwards from run.log; nothing measured was lost. Fixed: it reads them a piece
  at a time now.
- Closing the 600 group timed out (`POST /_groups/1/delete`), so no group was closed and closing wasn't measured. To
  look at before groups grow past 40.

**Rows read, the limit that bites, and almost all of it answering friends.**

| Friends | People | Rows read: median / 90% / most | Rows written: median / 90% / most | Over a limit |
| --- | --- | --- | --- | --- |
| under 250 | 1,765 | 2% / 5% / 16% | 8% / 16% / 27% | 0 |
| 250–499 | 775 | 5% / 13% / 36% | 20% / 30% / 43% | 0 |
| 500–749 | 294 | 9% / 24% / 69% | 29% / 46% / 70% | 0 |
| 750–999 | 95 | 14% / 42% / 71% | 39% / 58% / 85% | 0 |
| 1,000–1,249 | 44 | 22% / 62% / 133% | 48% / 96% / 127% | 5 |
| 1,250–1,499 | 17 | 34% / 65% / 78% | 47% / 66% / 68% | 0 |
| 1,500–1,999 | 10 | 116% / 282% / 282% | 74% / 87% / 87% | 6 |

- "Nothing new" itself was cheap: 2 rows. 74% of the 9.1M asks were answered that way, 3% of the rows. The other 26%
  sent the whole feed again, 172 rows on average and about 440 for a popular person: 97% of the rows.
- Every friend asks about 10 times a day (each time they open Home), whatever happens. A person with 1,518 friends was
  asked 22,806 times; their feed changed 148 times (mostly friends' comments), about every 3 minutes.
- **The 15-minute wait was the main cause.** A site gave no "as of" for 15 minutes after any change (because comments
  stay editable that long), so 80–87% of the asks a popular person got fell in that window and were answered whole;
  and a friend answered then had nothing to give back next time, so got everything again even if nothing had
  changed. The person with 1,518 friends answered 94% of asks in full: 9.4M rows, 188% of the limit, on answers alone.
  The wait wasn't needed: whether a comment can still be changed is worked out by the site showing it, from when it
  was written (feed.js markAllMine); nothing in what's sent changes as it stops being editable.
- Even without the wait, one new comment meant all 30 posts with every comment, to each of 1,500 friends.
- A bug made it worse: opening Notifications (users.activity_seen_at) counted as a change to the feed.

**Rows written: mostly a one-off.** For the people over the write limit, 80–87% of their writes were saving friends'
copies (friend_posts), but 75,632 of one person's 77,532 were in the first 10 minutes: their first Home visit making
copies of all 1,218 friends' posts (3 rows each: the row and two index entries). Without that they'd have been at about
51%, not 127%. Measured since: saving an unchanged copy writes nothing (1 row read), a changed one writes 1 row.
- Still a real first day for anyone joining (or moving their site) with over about 1,000 friends: 30 posts kept for
  each is 3 × 30 × friends rows. Home shows 100 posts from everyone together, so keeping 30 a friend is generous: a
  lever if it matters (KEEP_POSTS), not yet changed.
- Queued notes are a row per friend (Outbox `notes`): 26% of one popular person's writes. One row per note with how far
  it's got would do.

**Groups, each taken as its own account** (analyse.mjs now counts them apart from their owners):

| Members | Opens | Rows read to open (median) | Rows read in the day | Rows written | Object requests |
| --- | --- | --- | --- | --- | --- |
| 50 | 127 | 98 | 0.3% | 0.1% | 0.2% |
| 300 | 853 | 751 | 11.9% | 3.0% | 1.7% |
| 600 | 1,633 | 1,015 | 33.1% | 5.7% | 3.3% |
| 1,000 | 2,786 | 1,415 | 78.1% | 8.3% | 5.2% |
| 2,000 | 5,502 | 2,383 | 264.1% | 16.4% | 10.0% |

- Opening a group reads about one row per member, so a group's reads grow as members × opens. Making an open read only
  the posts it shows is the lever. A group of 1,000 is at the edge until then.
- @here reached 1,998 of 1,999, 597 of 599, 288 of 299, 144 of 149, 48 of 49; the 1,000 group said "1,000 of 999",
  one more than it has. Both to look at.

**Also:** one post reached all 1,931 of a person's friends, half in 2 minutes, 90% in 3.4, the last at 9. 410 actions
were refused with a 400 (322 comments, 68 group comments, 20 group posts): to check they're the injected failures and
not bugs. Memory: at the evening peak the first server got down to 1.3 GB free and 3 GB of swap; workerd kept about
21 GB per server once the day was over.

**So is 1,000 friends, or members, a reasonable limit?** Roughly, but not with room to spare as things were: nobody
under 1,000 went over, about 1 in 9 just over did, and going over makes the database refuse until midnight UTC. On that
code about 750 was the comfortable figure; with the change below, 1,000 should be, and groups need their open fixed.
How busy someone's friends are matters as much as how many: 1,877 friends read 71%, 1,773 read 282%.

#### How others keep copies up to date (researched 19 Nov 2026)

Every system looked at sends what's changed, from a point the reader gives back, never the whole feed for one comment:
Bluesky (repo sync `getRepo?since=`, each commit with an always-increasing rev), CouchDB (`_changes?since=`, the latest
change of each document), Matrix (`/sync?since=`), Scuttlebutt (each log by sequence number), Nostr (`since` filters),
and for feeds, RFC 3229's `A-IM: feed`, which sends only entries new or changed since the reader's version.

Their known pitfalls, and how the design below avoids them:
- Nostr's `since` uses the author's own timestamps, so something backdated slips past: changes here are stamped by the
  database as they happen, never with a post's date.
- CouchDB may send a change twice, so readers must take repeats: keeping a post twice is harmless.
- Deletions need tombstones kept for a while (RFC 6721, Cassandra's 10 days), and a reader further behind than that
  brings deleted things back: each answer lists the newest 30 instead (cheap, as the copy is only ever 30 posts), and
  anything not listed goes.
- A reader too far behind needs everything again: here a version change, a change to what every post shows, a post the
  copy is missing, or photo links running out.

What doesn't fit:
- Logs and hash trees (Bluesky, Scuttlebutt, Dynamo) replicate whole histories to big indexers; this keeps 30 posts a
  friend, so a time per post and the list of the newest do the same with nothing to trim.
- Pushing every change to every follower (Mastodon/ActivityPub) costs the publisher one delivery per follower per
  change. Here that's about 4 times today's asks for people with 1,500+ friends (83,000 a day against 19,000), though
  fewer than today's asks for most people (5.4M against 9.1M across the network). With a queued row per friend it
  would break the write limit, and it writes on every friend's site whether anyone looks or not.
- Sending the content with the push (WebSub's "fat pings") needs one payload for everyone; here each friend gets their
  own photo links, audience, and their own poll and event answers.
- Hubs and relays are a third party between sites, which self-hosted sites don't want.
- Push or pull is decided best for each pair, by how often one changes against how often the other looks (Silberstein
  et al., "Feeding Frenzy", SIGMOD 2010); Twitter pushes for most and pulls celebrities; Facebook and LinkedIn pull.
  Here popular people change about 150 times a day and each friend looks about 10, which says pull them.

Cloudflare's limits, checked in their docs on 19 Nov 2026 (Durable Objects pricing and limits, 13 Nov; Workers, 18 Nov):
5M rows read, 100,000 rows written and 100,000 requests a day per account; index updates count as rows written; rows
read are those scanned; calls out cost the caller nothing but count against 50 a run; each ask costs the publisher one
Worker request and one object request.

#### Built (19 Nov 2026, uncommitted): only what's changed

- **Each post has a time it last changed** (posts.changed_at), kept by the database (migrations/0025_feed_changed.js):
  its words, who it's shared with, photos, comments and their edits, poll and answers, event and answers.
  feed_changed.at moves with any of it, and whole_at with what every post shows (the owner's name and pictures, a
  friend's name in an event's guest list). Facebook's posts move nothing, and nor does opening Notifications.
- **A friend's site gives back what its copy is as of** (`?since=`), and is told only "nothing new" (2 rows), or sent
  only the posts changed since, with the addresses of the newest 30 (`afterwrd:changedSince`, `afterwrd:newest`), or
  everything (a change every post shows, another version's token, none). No 15-minute wait.
- Times are the database's own clock, read before anything else, and changes in the same second as a token are sent
  again: nothing's missed, at the cost of the odd repeat.
- **The asking site** keeps the changed posts with the rest of its copy and drops any not among the newest. If one of
  the newest is a post it hasn't got (a newer one went and an older one came in), it asks for everything next time
  (connections.copy_keys). Their owner's own comments are named as it calls them, as these answers don't say again
  (the first test run found them dropped).
- Two fetches of the same friend can overlap (Home asking while the Outbox does, after the owner's changed something
  there): an answer is kept only if none asked for later has been (copied_at, to the millisecond).
- Works with older sites both ways: they don't send `since`, and ignore it, so they get and give everything as before.
- Tests: test/triggers.mjs (what moves what), the feed suite (nothing new, only the new post, only a commented post, a
  post deleted, everything again, a missing post).
- Expected: the person with 1,518 friends from about 240% of rows read to roughly 40–50%; to be measured, not promised.

**Still open, in order:**
1. Measure it: the next run, or the one-site harness parked in docs/scale-test-single-site.md.
2. Requests are the next ceiling: asks still cost a popular person about 20,000 requests a day (20%).
3. Parked unless requests bind: quiet people ring their friends when something changes, and friends stop asking them on
   every Home visit; popular people don't ring, and are asked at most every so often.
4. One queued row per note, not per friend.
5. A group's open reading only what it shows.
6. The first day for someone with over about 1,000 friends (copies made all at once).

## Order

1. Fewer lookups and instant-feeling posting (in progress).
2. Measure.
3. Stored friends' posts with the doorbell (built 14 Nov 2026). Then decide on longer photo links in feeds.
4. Fingerprinted static files, plus prefetch on tap.
5. Groups: background telling, then the member and photo caps.
6. Topping up from the browser, then the service worker copy, only if they're still needed.

Sources: [Pew 2014](https://www.pewresearch.org/short-reads/2014/02/03/what-people-like-dislike-about-facebook/);
Dunbar, R. (2016), *Do online social media cut through the constraints that limit the size of offline social
networks?*, Royal Society Open Science;
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/);
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Frameworks: decided against (14 Nov 2026)

Looked at again before the speed work, with clean, maintainable code in mind. The answer is no framework, for now.

- **What's there already does the useful part.** Pages are drawn on the server, loading data is kept separate from
  drawing the page, and the `html` template tag escapes everything. Only two libraries (passkeys, zip).
- **htmx.** ui.js's in-place sending is a home-made htmx, but htmx would replace only the simple part. The rest is
  ours whatever we use: drafts, no jumping, focus, the site's refusal words, the "Sending…" comment. It also runs code
  from page attributes, so it would need locking down.
- **Alpine.js.** Needs a looser security policy in its usual form, and there's very little state in the browser.
- **Preact / Lit.** Made for pages drawn in the browser; ours are drawn on the server.
- **Hono** (routing for Workers). The only real case: tidier routing and one shared place for checks. But it would
  mean rewriting every route, with sign-in and security checks depending on order. Look again if the owner API for an
  app becomes real.
- **Why lean suits afterwrd.** Friend checks rest on the site running exactly the released code. Every dependency is
  more to trust, keep updated and hand over, and another way in through a library update.

What's done instead:
1. **One cross-site check** for every signed-in action, in index.js (done 14 Nov 2026). It replaced 11 copies.
   security.mjs proves it covers a path no handler has yet.
2. **ui.js split into small files by job** (done 14 Nov 2026): public/static/ui/ (main.js imports confirm, look, menus,
   drafts, inplace, arriving, search, app), loaded as modules with no build step. nav.js preloads them all at once
   (`modulepreload`), so a slow phone network waits once, as with the single file.
3. **Keep the loader/view split** as the rule for new pages. The views are split by area too (done 14 Nov 2026):
   views/archive.js (the Facebook download, Posts, Notifications), home.js, friends.js, groups.js, events.js, with
   layout.js and parts.js shared.
4. **Type checks widened** (14 Nov 2026): database rows (types/rows.d.ts, generated from migrations/ on every check by
   scripts/row-types.mjs), the browser scripts (tsconfig.browser.json) and the service worker (tsconfig.sw.json), and
   unused imports or variables now fail the check. Strict "might be empty" checks were measured and left off: 156
   findings, all already safe.
