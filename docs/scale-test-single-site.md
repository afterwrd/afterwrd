# A quicker scale test: one real site, fake friends (parked)

Parked 19 Nov 2026, after the 3,000-person run (social-20261119-1116). Not started; come back to it before the next
round of scale fixes.

## Why

The full run (8 servers, 3,000 sites, about 4 hours and 17 CHF) answers the question that matters most, "does one
person's account fit the free plan's daily limits?", by running everyone. But the limits are per account: to know
whether one account fits, only that account's site needs to be real, and the traffic reaching it realistic.

## The idea

- **The site under test** runs the real code in workerd (self-hosted image, `TEST_SCALE`), so its rows read and
  written are counted as Cloudflare counts them (`src/timing.js`). That's the part that has to be exact.
- **Its friends (500 to 2,000) are one Node program** pretending to be their sites:
  - answers the real site's asks for their posts (`GET /_peer/feed`), with generated feeds the size real ones are;
  - does to the real site what friends do: asks for its posts (as their Home visits and notes would), comments on
    its posts, sends notes, answers polls, on the schedule the social model gives each friend (`drive.mjs`
    social_day: the same classes of lurker, regular and busy).
- **Friendships are written straight into its database** (connections rows with keys), not made through friend
  links: making friends isn't what's measured.
- **A group the same way:** one real group site, fake members opening it, posting and commenting.

## What it would give

- A day for one account in about 15 to 30 minutes on a Mac, for nothing.
- Several at once: people with 500, 1,000, 1,500 and 2,000 friends; groups of 1,000 and 2,000.
- Before and after for each fix, the day it's written.

## What it can't do

- The fake friends behave only as written. A change to how friends' sites ask (what they send each other) must be
  made in the fakes too, or the test measures the old behaviour.
- Nothing that needs many real sites together: how long posts take to reach people, one post reaching all of
  someone's friends, the rush of friends' sites coming back for it. The full run stays for those, as an occasional
  final check (before releases, after changes to what sites send each other).

## Smaller, meanwhile

Add who's asking to each measurement line (`timing.js`: the asking connection, for `/_peer/feed` at least), so a
recorded full run can be asked "what if" afterwards: for example how many whole answers a shorter quiet window would
have saved, which the 19 Nov run can't tell (it records who answered, not who asked).

About a day's work for the harness.
