# Scale test

How afterwrd behaves with hundreds of sites: Home with 5, 150 and 500 friends, one post reaching 500 friends, groups of
40 and 150, and a day's activity against the free plan's daily limits. Everything runs on this computer, in the
self-hosted image, and nothing goes to Cloudflare. The plan and results are in `docs/speed-and-scale-plan.md`
("Scale test").

## What it is

- **One container, three workerd processes,** each running about 170 sites. One workerd can't hold more than about
  250: each site's isolate takes about 15 MB, and V8 gives all of a process's JavaScript 4 GB. Calls between sites in
  different processes go to the other process's router (`selfhost/config.mjs`, `elsewhere`), all inside the container.
- **Calls between sites are as slow as on Cloudflare** (`selfhost/outbound.js`, `TEST_NET`): 0.5–0.7 s, 5% take
  1.5 s, 2% hang for 30 s and 1% fail. Nothing else goes out.
- **Each site counts as Cloudflare does** (`src/timing.js`, sites with `TEST_SCALE` set): every run of an object (a
  request, an alarm, a call from another object) has its own 50 calls out, and the 51st fails. Each run logs one line,
  with its calls, the rows it read and wrote, and how long it took. `start.mjs` collects them in `out/stats.log`.
- **CPU** comes from V8's profiler for the one site being measured (through workerd's inspector). It's this Mac's CPU,
  not Cloudflare's: compare cases with it, don't quote it as Cloudflare's.
- **Owners sign in with passkeys made in Node** (`lib.mjs`), through the real device-link steps. Friends are made with
  real friend links, and groups are claimed with their setup code, as people do it.

Names are made up: Sam Taylor's sites are the hubs (`h005.scale.test`, `h150…`, `h500…`); Ann Example's are the
others (`s001…s500`); `g040` and `g150` are groups owned by the 500 hub.

## Running it

From `worker/`, with Docker given 16 GB (the full network uses about 13):

```sh
docker build -f selfhost/Dockerfile -t afterwrd-scale .   # the image (for its workerd and Node)
test/scale/scale.sh build                                 # the code under test, into test/scale/out/build
node test/scale/net.mjs --no-delays                       # the network, quick for setting up
test/scale/scale.sh up
for s in owners posts friends groups; do test/scale/scale.sh drive $s; done   # about 3 minutes
test/scale/scale.sh down && test/scale/scale.sh snapshot  # keep it, to start again from here (restore)

node test/scale/net.mjs                                   # now with Cloudflare's delays
test/scale/scale.sh up
test/scale/scale.sh drive home        # Home at 5, 150 and 500 friends; a burst of posts on the 150 hub
test/scale/scale.sh drive fanout      # one post reaching 500 friends
test/scale/scale.sh drive groups_run  # a post, a comment and a removal in each group
test/scale/scale.sh drive day 30      # a day's activity squeezed into 30 minutes
test/scale/scale.sh drive refresh     # copies refreshed in the same hour and just after it turns (waits for it)
test/scale/scale.sh drive groups_run close   # last: closes the groups
node test/scale/analyse.mjs           # out/report.md
```

A smaller network for trying changes: `node test/scale/net.mjs --leaves 12 --processes 2 --hubs 5,12 --groups 4,12`.
Don't change `src/` or rebuild while a run is going: the processes read `out/build`.
