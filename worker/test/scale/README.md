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

## On a rented server

For networks too big for this computer (2,000 sites take about 55 GB), `vm.sh` runs everything on a Linux server with
Docker, from a copy of `worker/`, as root: `test/scale/vm.sh smoke` first (a small network end to end, a few minutes),
then `test/scale/vm.sh full`. Each step is marked done, so running it again carries on after a failure. It logs to
`out/<mode>/run.log` and leaves everything in `out/<mode>.tgz`.

- One workerd runs its JavaScript on one thread, so `full` runs 16 processes of about 125 sites: give it 16 cores or more.
- Start the server with `cloud-init.yaml` as its user data. It raises `vm.max_map_count` (Linux's usual 65,530 is
  too few for hundreds of isolates in one process; Docker on a Mac allows 262,144) and turns off automatic updates,
  which restarted containerd during a run.
- `mid` (1,000 sites) fits a 32 GB server with 16 cores; `full` (2,000) needs about 64 GB.
- Copy the results back and run `node test/scale/analyse.mjs <dir>` here: the report reads them from any folder.
- To rehearse it here without touching a network that's kept, give other names: `SCALE_NAME`, `SCALE_IMAGE` and
  `SCALE_VOLUME`, and run it in a copy of `worker/`.

## On several machines

One server only goes so far (2,000 sites take about 55 GB), and the biggest sizes have to be switched on by the
provider. Instead, the network can be spread over several: `net.mjs --machines` gives each process a machine (their
addresses, in order), and each machine runs `scale.sh up` with `SCALE_MACHINE` set to its own address, starting only
its own processes.

- **The first machine** runs the hubs and groups, and `drive.mjs`: it measures their CPU through workerd's inspector,
  which only listens there. The other machines send it their measuring lines (port 9300), so its `stats.log` has
  everything; each also keeps its own, and `check.mjs` checks none went missing.
- **Routers and tools listen on the machine's address** (ports 8081 up and 9400 up), with no sign-in: only the other
  test machines may reach them (a private network, or a firewall that lets in only them).
- **Each machine has its own** data volume, `out/` folder and copy of the build.

### Rehearsing here

`machines.sh` runs each machine as a container on its own Docker network (172.30.0.10 up), with its own names,
volumes and `out/multi/` folder, so a network that's kept is left alone. `MACHINES` (default 3) says how many.

```sh
test/scale/machines.sh build
test/scale/machines.sh net --leaves 12 --processes 4 --hubs 5,12 --groups 4,12 --no-delays
test/scale/machines.sh up
for s in owners posts friends groups; do test/scale/machines.sh drive $s; done
test/scale/machines.sh down
test/scale/machines.sh net --leaves 12 --processes 4 --hubs 5,12 --groups 4,12
test/scale/machines.sh up
test/scale/machines.sh drive home    # and the other scenarios, as above
test/scale/machines.sh check         # every machine's measuring lines reached the first
test/scale/machines.sh report        # out/multi/m0/report.md
test/scale/machines.sh reset         # removes the containers, volumes, Docker network and out/multi/
```

### On Exoscale

`exo.sh` does it all from here, with `vm.sh` running the test on the first server (`MACHINES`, the servers'
addresses, first one first; it reaches the others over ssh with a key made for the run):

```sh
test/scale/exo.sh create 3 standard.large   # the servers (prints what they cost an hour); about 3 minutes
test/scale/exo.sh push                      # this worker/ to each
SCALE_NET="--leaves 12 --processes 4 --hubs 5,12 --groups 4,12" test/scale/exo.sh run smoke
test/scale/exo.sh log smoke                 # how it's going; it carries on if this computer sleeps
test/scale/exo.sh fetch smoke               # out/exoscale-multi/smoke/report.md
test/scale/exo.sh delete                    # the servers and their security group; then shows what's left
```

- Private networks aren't enabled on the account, so the servers talk over their public addresses. Their security
  group (`afterwrd-scale-multi`, made by `create`, removed by `delete`) lets in ssh from this computer's address only,
  and the test's ports (8081–8299, 9300, 9400–9499, and ssh) only from servers in the group.
- Give the network at least as many processes as servers (`--processes`), about 125 sites a process, and a core for
  each process on its server. The hubs and groups all go in the first process, on the first server.
- Each server powers itself off after 4 hours (`cloud-init.yaml`), but only `delete` stops the charges.

## A network like Facebook's (`--model social`)

`net.mjs --model social` makes a network shaped like Facebook's (social.mjs, the same for the same `--seed`): friend
counts with a median of about 200 and an average of about 300 (Pew Research, 2014), 15% over 500 and a few in the
thousands; most friendships within overlapping circles (families, workplaces, towns), so friends share friends; groups
of up to 2,000 grown out of circles, one owned by the biggest outlier. The ten with most friends are the hubs.

`vm.sh social` runs it: set up (with `warm`: everyone opens Home once, so the day starts from made copies), then
`social_day`, a waking day squeezed `--squeeze` times (8: 16 hours in 2), with time-of-day busyness, mostly-reading,
regular and busy people, and photos that start flurries of comments among friends who share circles; then Home for the
three biggest outliers, one post to all of the biggest's friends, the groups' runs and closing them; then a census of
every site's data. `SCALE_NET` sets the size, e.g. a rehearsal:
`SCALE_NET="--model social --people 80 --processes 3 --groups 15,30,60 --outliers 3 --squeeze 96" test/scale/vm.sh social`.

The test squeezes time, so the app's own short windows shrink by the same factor on the test's sites (TEST_SQUEEZE:
rate limits' ten-minute and hourly windows, how long Home's copies count as fresh, and the "nothing new" wait). Daily
limits don't: the test's day is one real day.

What's kept for working through afterwards: every object run (stats.log: rows, calls, statements, status), every action
the day took (results/social-day.jsonl, with what each Home visit showed of friends' new posts), each machine's memory
and CPU every 30 seconds (resources.log) and each site's data at the end (census-*.json). On Exoscale,
`exo.sh sync social` copies them home every 10 minutes while it runs; `EXO_HOURS` sets when the servers power off.

## When a run ends, the servers power off

A run on rented servers must never sit there billed with nobody watching (on 19 Nov 2026 a run failed at 01:49 and
eight servers stayed up, idle, until their time ran out at 06:31). So, with `SCALE_POWER_OFF=1` (`exo.sh run` sets it):

- **However the run ends** (finished, failed, or stopped), vm.sh's `finish` uploads the results one last time
  (`upload.sh … once`) and then powers off every server.
- **If it's stuck** (nothing in the run's log or the day's action log for `SCALE_WATCHDOG_MINUTES`, default 30),
  `watchdog.sh` stops it, so `finish` runs; if it still won't stop, the watchdog runs `vm.sh halt <mode>` itself.
- **If all that fails**, each server powers itself off after `EXO_MINUTES` (set it to the run's expected length and a
  little more). Powered off isn't deleted: `exo.sh delete` when the results are safe.

Rehearse it on a Mac with `SCALE_POWER_OFF=test` (it says what it would power off): a scenario that fails
(`SCENARIOS=nope`), one that hangs (`SCENARIOS=stall SCALE_WATCHDOG_MINUTES=2`), and a clean finish.
