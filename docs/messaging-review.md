# Review: how sites tell each other things (brief, 20 Nov 2026)

A systematic pass over every way afterwrd sites send each other anything, to rationalise and optimise it as one
system rather than flow by flow. Start here in a fresh session. Background and numbers: docs/speed-and-scale-plan.md,
"3,000 people on eight servers"; the wire format: PROTOCOL.md.

## Where things stand

- Everything since 0.58.2 is committed on branch `scale-fixes` (20 Nov), not released: "only what's changed" for
  friends' posts (peers.js feed, feed.js askSites, migrations 0023 and 0025), fewer rows written on refresh, groups
  reading less (0024), member and event-people lists raised to 5,000. Full end-to-end suite and the upgrade from
  0.58.2 pass.
- The free plan, per account per day: 5M rows read, 100,000 rows written, 100,000 requests; 50 calls out per run.
  Going over makes that kind of operation fail until midnight UTC.

## The shape today

Content stays on the site that owns it and is pulled; what's pushed is small notes, after which the receiver pulls.

| Flow | Push or pull | When | Who pays | When it fails |
| --- | --- | --- | --- | --- |
| Friends' posts on Home (copies in friend_posts) | Pull | Each Home visit, for copies over 5 minutes old (FRESH_SECONDS), in the background, 40 a batch, at most 48 a day per friend; at once on a doorbell; after the owner acts on a friend's post | Asked: a request, plus 2 rows ("nothing new"), the changed posts, or all 30. Asker: a call (free), rows to save | Copy stays as it was; next refresh |
| Doorbell: new post (to all it's shared with), comment (to the other commenters), mention | Push, then the receiver pulls | When it happens | Sender: a queued row per recipient (written, then deleted). Receiver: a request, an inbox row | Retried after 1 m, 5 m, 30 m, 2 h, 6 h, then dropped, silently |
| A friend's page (/friend/…) | Live pull, no copy | While the owner waits | Asked: a request and rows | Error shown |
| Commenting, editing, deleting, voting on a friend's post | Push, while the owner waits | When they do it | Receiver: a request, rows; sender: a call | Error shown, nothing kept. A lost reply after it was stored leaves the comment unmarked as theirs, and a retry duplicates it |
| Own events: invitations, answers, changes | Push (invites queue; /_peer/answer) | When it happens | As notes | As notes |
| Groups: opening one | Live pull from the group's site | Each open | The group's account: about one row per member per open | Error shown |
| Groups: comment notes, @here, event changes, closing | Push from the group's site (member_notes) | When it happens | The group's account: a queued row per member | As notes |
| The owner's own page, "N new" | Browser polls its own site | Every 30 s while visible | Own account | — |
| Phone notifications | Web Push | Events only | Own account | — |

## What the 3,000-person run found (19 Nov)

- Every friend asks for your posts about 10 times a day (each Home visit), whatever happens: 74% of 9.1M asks found
  nothing new. A person with 1,518 friends was asked 22,806 times; their feed changed 148 times.
- Asks triggered by doorbells were only about 6% of all asks (an estimate: the run didn't record who asked); the
  routine 5-minute pull is the rest.
- Pushing every change to every friend would be fewer messages for most people (5.4M against 9.1M across the network)
  but about 4 times more for people with 1,500+ friends (83,000 against 19,000 a day).
- Writes: notes queued a row per recipient (26% of one popular person's writes); first Home visit made 30 copies per
  friend at once (75,000 rows for 1,218 friends: a one-off, but over the limit on day one).
- Groups: opening reads about one row per member, so 1,000 members was 78% of the read limit, 2,000 was 264%.

## Questions for each flow

1. How fresh does it need to be, as the owner would notice it? (New posts and replies to them feel immediate; others'
   comments, edits and deletions on friends' posts maybe within the hour: Ste to decide.)
2. Push or pull, by how often the sender changes against how often the receiver looks.
3. What it costs each account (requests, rows read, rows written), at 200, 1,000 and 2,000 friends or members.
4. What happens when it fails, and whether it can go missing silently.
5. Is a repeat harmless (can it be retried, or sent twice, without doing it twice)?
6. Does it still hold the security invariants (untrusted data from friends, atomic limits, nothing secret sent)?

## Candidates already found

- **Pull less often:** FRESH_SECONDS 5 minutes to about an hour, keeping the doorbell for new posts and replies, and a
  slow pull as the safety net (photo links force one a day anyway).
- **Doorbells that carry their content** ("fat" notes) for a new post and a comment, so the receiver needn't call
  back: no call chain, no rush of friends fetching a popular person's post. A new post has nothing per friend but its
  photo links, which the sender can sign per friend; notes are capped at 64 KB (peers.js MAX_REQUEST), plenty for a new
  post (5,000 characters at most) or a comment (2,000).
- **One queued row per note,** with how far through the recipients it's got, not a row per recipient.
- **Comments with their own id from the sender,** so a retry after a lost reply is recognised, not duplicated.
- **Ringing for every change,** for people who change rarely, and pulling the popular ones: parked unless requests
  become the limit (asks cost a popular person about 20% of requests).
- **A group's open reading only what it shows,** not something that grows with members.
- **The first day's copies:** fewer kept per friend (KEEP_POSTS 30; Home shows 100 from everyone), or filled over time.
- **Odd results to explain:** @here told 288 of 299 and 144 of 149, and "1,000 of 999"; closing the 600 group timed
  out; 410 actions refused with 400s (322 comments): injected failures or bugs?

## How to measure

The full run (docs/speed-and-scale-plan.md; worker/test/scale/README.md) costs about 17 CHF and 4 hours. The quicker
harness parked in docs/scale-test-single-site.md (one real site, fake friends) is worth building first if the review
changes several flows. Add who's asking to each measuring line (timing.js) either way.
