# Self-hosting plan

17 Nov 2026. How to run afterwrd on your own server with Docker, without Cloudflare. Work through it in order.
Built and merged into main for 0.53.0 (17 Nov 2026); what's left is under Steps.

## Why, and for whom

- **To show afterwrd doesn't need Cloudflare.** Cloudflare's free plan stays the easy route, and the one the
  install page offers. Most people will take it.
- **For people happy with Docker and a terminal.** Setup is a `compose.yaml` and a few commands, with no
  setup pages and no hand-holding.
- **If you do it yourself, you self-host.** The do-it-yourself Cloudflare install (pasting `installer.js` into a
  Worker, `wrangler deploy`, pasting API tokens) goes. On Cloudflare you install through install.afterwrd.app.

## What stays the same

- **The code.** The same release runs in both places, on workerd (Cloudflare's open-source Workers engine, the one
  Cloudflare itself runs). There's no second version to keep in step, and the same tests cover both.
- **The protocol.** Sites already accept any `https://` address as a friend or group (`siteOrigin` in
  `worker/src/peers.js`), so self-hosted and Cloudflare sites can be friends and share groups. Nothing in
  PROTOCOL.md changes, apart from a note about checks (below).

## What's different, and decided

| | On Cloudflare | Self-hosted |
| --- | --- | --- |
| Install | install.afterwrd.app, Connect → Allow | `docker compose up`, then a command prints the first device link |
| Address | `afterwrd.<name>.workers.dev` | your own domain, over HTTPS |
| Updates | Update page or automatic, through Cloudflare's API | Update page says a release is out (signed list, as now); you pull the new image |
| Lost your device? | proves you can sign in to the Cloudflare account | a command on the server prints a recovery link |
| Friend checks | friends' sites read Cloudflare's records | **can't be checked, and can't check others.** Whoever runs the server can change anything, and nothing outside it can see. Friends' sites say "self-hosted, can't be checked". Checking others needs Cloudflare's answer back through afterwrd.app's relay, which only ever returns to a workers.dev address, and that stays so. That's the trade made by choosing this route |
| Groups | each group its own Worker, made through the API | the same server runs each group as another site at its own address (below) |
| Photos | Durable Objects, 5 GB free | Durable Objects on disk, as much as the disk holds |

### Groups on a self-hosted server

1. Add a DNS record for the group's address, e.g. `walkers.example.com`, pointing at the server.
2. `docker compose exec afterwrd new-group walkers.example.com`. The server adds a site in group mode, with its
   own database, photos and `GROUP_KEY`, and prints a setup code.
3. On your site: Groups → Start a group → paste the address and the code. Your site claims the group exactly as
   it does now (`POST /_group/claim`). This is today's test-only `/_groups/create/local` step, made real.

Updating the image updates you and your groups together. Closing a group works as now (members are told first),
and then `delete-group` removes its data. The website can't make or remove groups by itself: giving it control of
Docker would be a hole.

## The pieces

**The image.** workerd, the release's bundled code and site files, and a small start-up script that writes
workerd's config from a list of sites (the owner's, plus any groups). One container serves every site on the
server, picking by hostname, each with its own data folder:

```
/data/
  sites.json                    which sites, their addresses, and each group's GROUP_KEY
  sites/<host>/database/        the database (SQLite, in a Durable Object)
  sites/<host>/media/           photos and videos
  sites/<host>/outbox/          notes waiting to go to friends
```

Inside the one workerd (`selfhost/config.mjs` writes its config; `selfhost/serve.mjs` runs it, and starts it again
when `sites.json` changes):

- **router** (`router.js`): every visit, from Caddy or a tunnel, goes to the site at the address it was for, as
  https (sites must see their own https address, for passkeys and links).
- **outbound** (`outbound.js`): every call a site makes out. A call to another site on the same server is answered
  directly (many home servers can't reach their own public address from inside); everything else goes to the
  public internet only.
- **tools** (`tools.js`): the owner and recover commands, listening only inside the container, working through
  each site's own database object rather than opening its file.

**The database.** The code uses a small part of D1's API: `prepare().bind()`, `.first()`, `.all()`, `.run()`,
`.batch()` (one transaction) and `meta.changes`. workerd has no D1, so a small stand-in provides exactly that:
a Durable Object holding the SQLite database, with `env.DB` passing statements to it. The stand-in lives outside
`src/`, so nothing in the site's code changes.

**Site files and version.** `ASSETS` is workerd's own disk service over `public/`. `VERSION` comes from the
release (`{id, tag, timestamp}`), so `/_version` still answers.

**HTTPS.** workerd speaks plain HTTP inside the container. In front of it: Caddy (in the example `compose.yaml`;
certificates are automatic, one per address), or Cloudflare Tunnel or Tailscale Funnel for a home server that
can't open ports. Passkeys and friends both need a real HTTPS address.

**Calls out: never to private addresses (must be in before anyone uses it).** On Cloudflare a site can't reach
anything but the public internet (`global_fetch_strictly_public`). On a home server, a hostile "friend address"
could point at the router, the NAS or the server itself. workerd's outbound network is set to public addresses
only (`allow = ["public"]`, no `private`/`local`). Tried (Trial notes): 127.0.0.1, ::1, 10.x, 192.168.x,
169.254.169.254 and a public name resolving to 127.0.0.1 are all refused, by the address actually connected to.

**"Where am I running?"** `worker/src/hosting.js`. The setting `HOSTING = "self"` (config.mjs gives it every
self-hosted site) tells the code it isn't on Cloudflare: Connect, automatic updates, checks both ways and the
Cloudflare recovery answer `404` (one list in `index.js`); the Update page is its own short view (what's out, the
commands to update, "can't be checked"); sign-in's "Lost your device?" gives the `recover` command; Home has no
check cards; Start a group takes an address and setup code. Daily runs (`scheduled`) do nothing self-hosted.
On Cloudflare sites, whether a friend is self-hosted is decided by its address (any address that isn't workers.dev),
never by what the friend's site says, as a tampered site could claim to be self-hosted to dodge its checks. Such
friends are never picked for automatic checks (so never counted as refusing), aren't offered on Update's "Ask …"
buttons, can't be asked or given a check link, and their friend page says "self-hosted, can't be checked".

**Commands in the container.**

`docker compose exec afterwrd …` (`selfhost/afterwrd.mjs`):

- `owner "Your Name"` makes the owner and prints a device link; `owner` alone prints another one.
- `recover` signs every device out and prints a link whose passkey replaces all the others (as recover.js does).
- `new-group <address>` adds a group's site to `sites.json` (workerd restarts) and prints its setup code;
  `delete-group <address>` (asks for the address again) removes it and, once workerd runs without it, its data.
- `sites` lists them. The backup is the `afterwrd-data` volume; Download everything works as now.

**Releases.** `.github/workflows/image.yml` builds the image (`worker/selfhost/Dockerfile`) from each release tag on
an x86 and an ARM runner, with the Docker already there (no other actions), and publishes
`ghcr.io/afterwrd/afterwrd:<version>` and `:latest`. Not yet: the image checking its own code against the signed list
(`worker/src/signing.js`) at start-up. That wouldn't stop someone with root changing it; it would stop a wrong or
tampered download.

## Tidying the do-it-yourself Cloudflare install

Goes:

- README: the by-hand steps (create a Worker, paste `installer.js`) and the `wrangler deploy` "Running and
  developing" setup. Replaced by "Self-hosting" (Docker) next to "Easiest: the install page".
- `worker/installer/installer.js` and afterwrd.app's `#by-hand` section, and `installer.js` as a release asset.
  First check nothing on a live site or in `.github/workflows/release.yml` still points at it.
- Pasting an API token in Update and Groups (`token?` in `update.js`, `groupsites.js`, `cloudflare.js`): Connect only.
- Mentions in SECURITY.md, `installer/how-it-works.html` and `docs/security-and-install-plan.md`.

Stays (tests use them): `scripts/owner.mjs`, `scripts/deploy.mjs` and `wrangler dev`.

## Steps

1. **Try it.** Done (Trial notes).
2. **Calls out to public addresses only.** Done: in config.mjs for every site, and tried by hand (Trial notes).
   Still to do: an automatic test of it.
3. **`HOSTING = "self"`.** Done, with `test/e2e/selfhosted.mjs` (`npm run test:e2e -- selfhosted`), which passes on
   wrangler and on workerd.
4. **Commands.** Done and tried by hand on this computer: owner, recover, new-group, delete-group, sites, and a group
   claimed through the outbound route.
5. **The image, `compose.yaml` and Caddyfile, built in CI.** Built and run here (17 Nov, arm64, 549 MB): sign-in
   page through the router, owner, new-group, delete-group, a restart keeping everything, and GitHub reached over
   HTTPS from inside. It needed `ca-certificates` (workerd won't start without them). Still to do: try it end to end
   with Caddy on a real address and a phone; the signed-list check at start-up; perhaps a smaller image.
6. **Tests.** The suites run against workerd by hand (scratch scripts). Still to do: a `run.sh` way to run them on
   workerd, and the server pieces (router, outbound, tools, commands) tested automatically.
7. **Docs and tidy-up.** Done: `worker/selfhost/README.md`; the README's install section (the install page, or your
   own server); a line in PROTOCOL.md (section 3); the by-hand `installer.js` (and building it in releases), the
   pasted-token fallback, `scripts/deploy.mjs` and `npm run deploy` removed; SECURITY.md and How it works updated.

## Trial notes

17 Nov 2026, on a Mac with the workerd in `node_modules` (no Docker yet). The pieces are in `worker/selfhost/`:
`d1.js` (the database stand-in), `entry.js` (adds it to `env`), `files.js` (site files with their types) and
`config.mjs` (writes workerd's config from a list of sites).

- **It ran first time with no changes to `src/`.** Migrations, sign-in pages, `/_version`, fonts and the app
  manifest all worked.
- **The end-to-end suites, run unchanged against it:** security 70/70, comments 58/58, posts with photos 52/52,
  admin 40/40, fresh install 21/21, albums 26/26; on three sites (and a group's site), feed 163/163 (friend
  links, approvals, notes through the outbox, live updates), polls 50/50, mentions 52/52, events 120/120,
  notifications 59/59, groups 160/161. The one groups miss ("Bob's open page offers the new comment") fails the
  same way under `wrangler dev`, with the uncommitted work in `src/` at the time, so it isn't self-hosting's.
- **Not run yet:** update, checks, recover, auto, central and upgrade. These are the Cloudflare-only features, which
  step 3 hides or swaps when self-hosted.
- **One mistake of mine, fixed:** the database stand-in kept its connection between requests, which workerd
  forbids, as Cloudflare does. It now looks the database up for each call.
- **The build needs its own copy of `public/`.** Serving the live folder broke when a file changed after bundling:
  the site rightly refused a file that didn't match its release. The image will copy `public/` at build time.
- **Test plumbing:** `AFTERWRD_SELFHOST` (a site's data folder) points `helpers.mjs` and `scripts/owner.mjs` at a
  self-hosted site's database. `fresh.mjs` and `albums.mjs` now use `siteSql` instead of calling wrangler
  themselves.
- **Calls out to public addresses only works as hoped.** With `network = (allow = ["public"])`, a probe inside workerd
  reached https://example.com, and was refused ("connecting to … is not allowed") for 127.0.0.1, localhost, ::1,
  10.0.0.1, 192.168.1.1, 169.254.169.254 (cloud servers' metadata address) and localtest.me (a public name that
  resolves to 127.0.0.1). The check is made on the address actually connected to, so a friend's site can't get
  round it with its own DNS. Step 2 is then mostly a test: `config.mjs` already uses it for every site not marked
  `local`. The site sees a refusal as "unreachable", as it would a site that's down.
- **Several sites in one workerd** share the same Durable Object names (`database`, `media`, `outbox`), each in its own
  data folder, without trouble.
