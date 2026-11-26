# Security

afterwrd holds people's private photos, posts and Facebook history, so security problems matter a great deal.

## Reporting a problem

Please **don't open a public issue** for anything security-related. Report it privately instead:
**[report a vulnerability](https://github.com/afterwrd/afterwrd/security/advisories/new)** (GitHub's private
reporting; only the maintainer sees it), or email **security@afterwrd.app** if you'd rather not use GitHub.

It helps to include what you found, which version of afterwrd (shown on its Update page), and how to reproduce it.
You'll get a reply as soon as possible. Once a fix is released, and sites have had a chance to update, the problem
can be published with credit to you, if you'd like.

## What's in scope

- A person's afterwrd site, and a group's site (the code in `worker/`).
- The installer and the pages at afterwrd.app (`worker/central/`, which serves the pages in `worker/installer/`).
- How sites talk to each other ([PROTOCOL.md](PROTOCOL.md)).
- The self-hosted image, built by GitHub from the same code (`worker/selfhost/`), and how it's put together.

Problems in Cloudflare itself, or in someone's Cloudflare account settings, are outside it, though if afterwrd could
do something to protect people better, that's worth hearing.

## Versions

Only the latest release is supported. Every site on Cloudflare can update itself from its Update page, and a
self-hosted one by pulling the new image, so fixes go out as new releases. When a release fixes a security problem,
each older site says so to its owner on Home.

Sites with automatic updates turned on install a release by themselves once it has been **signed** and has been out
for three days (one day for a security fix), or at once on a site whose owner chose *Get updates first* (for people
helping to test afterwrd). Signing (`worker/scripts/sign.mjs`) happens on the maintainer's own
machine, with a key that never goes near GitHub, and only after rebuilding the release from its tag and finding it
matches what GitHub published byte for byte. The signed list of releases is
[`signatures/index.json`](signatures/index.json): one list, signed as a whole with a number that only goes up, so a
release is pulled by signing the list again without it, and an older list can't be put back. Each release in it also
carries its **etag**, Cloudflare's fingerprint of the release's code (the same in every account), which friends'
checks use. Every update, automatic or by hand, is put in place without going live, switched to, and switched straight
back if the new version doesn't answer healthily. *Install it now* on the Update page installs only signed releases
too.

Sites can also let their friends' sites **check them by themselves** (see below): a few times a week, and after each
update, a friend's site checks with read-only access that the site's code is exactly a signed release, set up as
afterwrd sets it up, in the account at its address, and that every upload to its code since the last check was a
signed release. A finding shows on both sites' Home.

To hear about every release, *Watch* this repository on GitHub (*Watch* → *Custom* → *Releases*) or follow the
[releases feed](https://github.com/afterwrd/afterwrd/releases.atom). Each release's notes are what its sites show on
their Update page.

## What else is trusted

Besides the release key, two things are trusted, and anyone who controlled them could harm people:

- **afterwrd.app and install.afterwrd.app**, which run in the project's own Cloudflare account (its domain, DNS and
  the installer's Worker all live there). The installer puts afterwrd on new sites, and afterwrd.app's Connect page
  passes Cloudflare's permission codes back to sites. Someone who controlled that account or the domain, even
  briefly, could install something else on new sites, or collect the permission of anyone connecting meanwhile. The
  project's Cloudflare account has a single login, with two-step sign-in, and holds the domain's registration.
- **The page you press *Allow* on.** Only press *Allow* when you started from your own site, just now: afterwrd.app's
  Connect page shows which site the permission is for, and a site with a look-alike address, from a link someone sent
  you, would get your Cloudflare access.

Releases are built on GitHub in a job that can only read the repository; the build record is signed and the release
published by a separate job that runs none of the build's npm packages.

GitHub is not trusted to say what a site runs: code reaches a site on Cloudflare only if it's in the signed list. A
self-hosted site pulls its image from GitHub's registry, which is not yet tied to the signed list.

## What the Cloudflare permission covers

Installing and updating ask Cloudflare for permission through its own sign-in for apps: you press *Allow*, and the
installer or your site gets a token that lasts **one hour**. Nothing is kept afterwards. It allows:

- making, changing and deleting **Workers** (Cloudflare calls this *Workers Admin*),
- making, changing and deleting **D1 databases**,
- reading the account's basic settings (its workers.dev name).

Since 0.57.0 your site keeps everything in its own Durable Object. Unlike a D1 database, Cloudflare's API has no way
to query it from outside: reaching it means deploying code to your site, which friends' checks look at. Another
Worker in the same account can be bound to your site's objects, but every call to them must carry a random key only
your site's own Worker holds (a secret, added at install or at the first update that finds it missing), so it gets
nothing; friends' checks report such a Worker too. The D1 permission remains for the database sites kept everything
in before then (left as it was, a safety copy), and for groups, until a later version stops needing it.

Automatic updates, if turned on, ask once for **Background Access** with *Workers Editor* only: changing (not making)
Workers, nothing else. It lasts until turned off on the Update page or revoked under *Connected Applications*. The
refresh token is kept in the site's own Durable Object storage, never in its database or downloads. afterwrd never
asks for permission to make API tokens: a token that can make tokens can make one with any permission in the account.

Letting friends' sites check yours, if turned on, asks once for **Background Access** to read Workers' code
(`workers-scripts.content_read`) only. Your site hands a friend's site that asks a one-hour access token from it, at
most two a day for each friend and twelve a day in all; the friend's site uses it for that check and keeps nothing. It
reads every Worker's code in the account (groups' too), but can't change anything or read databases, settings or the
audit log.

That's every Worker and database **in the account**, not just afterwrd's. So if you use Cloudflare for other things,
make a separate Cloudflare account just for afterwrd. It doesn't cover your domains, DNS, other Cloudflare
services, billing, your login, or making longer-lived tokens. You can see and revoke what you've allowed under *My
Profile* → *Connected Applications*.

## Check it yourself

You don't have to take the published files on trust. Two independent checks:

**Rebuild it.** Releases are reproducible: building a tag yourself gives byte-for-byte the same files. You need
`git` and Node.js 22.

```sh
git clone https://github.com/afterwrd/afterwrd && cd afterwrd/worker
git checkout v2.2.0         # the release you want to check
npm ci --ignore-scripts
npm run release -- --base https://github.com/afterwrd/afterwrd/releases/download/v2.2.0
shasum -a 256 release/2.2.0/manifest.json
```

The fingerprint should match the `manifest.json` attached to [that
release](https://github.com/afterwrd/afterwrd/releases); its start is also shown at the foot of
[afterwrd.app](https://afterwrd.app/). The manifest lists the SHA-256 of every code and site file, and the installer
and Update page refuse any file that doesn't match it, so a matching manifest covers all of those. (Releases before
0.53.0 also had an `installer.js` for Cloudflare's Deploy page, which carried the manifest's fingerprint and was worth
checking too.)

**Check its build record** (from 0.23.0 on). GitHub signs a record of every release saying that its files were built
by this repository's release workflow, from the tagged commit. The record is kept in Sigstore's public transparency
log, so it can't be quietly changed later. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify manifest.json --repo afterwrd/afterwrd
```

The self-hosted image has one too:
`gh attestation verify oci://ghcr.io/afterwrd/afterwrd:<version> --repo afterwrd/afterwrd`.

**Check what your site is running.** With a read-only API token (*Workers Scripts: Read*), download the code your
site is running from Cloudflare and compare it, file by file, with a release or with your own rebuild:

```sh
read -rs CF_TOKEN && export CF_TOKEN       # paste the token; nothing shows
node worker/scripts/check-site.mjs afterwrd --manifest worker/release/2.2.0/manifest.json
```

The code carries the SHA-256 of every static file the site serves (scripts, stylesheet, fonts) and refuses to send
any that doesn't match. What the code can't cover is how the Worker is set up in Cloudflare (what it's connected to,
where its logs go, whether Cloudflare hands out its files directly): the script checks only the code, while a check
by a friend's site checks those too. [Check your install](https://afterwrd.app/check/)
explains what else to look at in your Cloudflare dashboard after installing.

## How it's checked

See [How afterwrd is made](README.md#how-afterwrd-is-made) in the README: the code is public, it's covered by
automated end-to-end tests including hostile input, and it has had security reviews by AI agents at each major step.
It hasn't yet had a review by a human security expert; one would be very welcome.
