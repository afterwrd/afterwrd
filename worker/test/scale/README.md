# Scale test

How afterwrd 2 behaves at section 8's sizes (`docs/signed-conversations.md`, "Scale at 1,000", and build step 9b): a
person with 1,000 friends, a group of 1,000 members, and a day of everyone's activity, measured against the free plan's
daily limits. Everything runs in the self-hosted image, on this computer or rented servers, and nothing goes to
Cloudflare.

## What it is

- **Workerd processes in one container,** each running up to about 125 sites (each process runs its JavaScript on one
  core). Calls between sites in different processes go to the other process's router (`selfhost/config.mjs`,
  `elsewhere`), all inside the container.
- **Calls between sites are as slow as on Cloudflare** (`selfhost/outbound.js`, `TEST_NET`): 0.5–0.7 s, 5% take
  1.5 s, 2% hang for 30 s and 1% fail. Nothing else goes out.
- **Each site counts as Cloudflare does** (`src/timing.js`, sites with `TEST_SCALE` set): every run of an object (a
  request, an alarm, a call from another object) has its own 50 calls out, and the 51st fails. Each run logs one line,
  with its calls, the rows it read and wrote, and how long it took. `start.mjs` collects them in `out/stats.log`.
- **A day squeezed** (`--squeeze`, `TEST_SQUEEZE`): rate limits' short windows, the hourly pulls of friends' and groups'
  sites, and the background checks' schedule all shrink by as much (`src/limits.js` `rateWindow`), so 3 hours at 8
  behave like a day. Daily limits stay as they are: the squeezed day is one day.
- **Everyone signs as their browser would** (`drive.mjs`): owners sign in with passkeys made in Node (`lib.mjs`),
  through the real device-link steps, then set up signing as the recovery-code page does (one passkey prompt signs
  their identity and a browser key). Every post, comment, vote, join and approval is a record made with
  `public/static/records.js` (mounted at `/static`) and sent to the routes the pages use. Friends are made with real
  friend links, and the group is claimed with its setup code, its identity signed by its owner's passkey.

The network (`net.mjs`): `h1000.scale.test` (Sam Taylor, 1,000 friends), `h0010…` (Sam Taylor, 10 friends, who owns
the group), `g1000…` (the group: 999 of the others and its owner), and `s0001…s1000` (Ann Example's sites, each
friends with the 10 nearest it round a ring). With `--leaves N`, N in place of 1,000.

## Running it

From `worker/`, with Docker (60 sites take a few GB):

```sh
test/scale/vm.sh rehearse        # 60 sites end to end, a day in 20 minutes; out/report.md
```

Or step by step:

```sh
docker build -f selfhost/Dockerfile -t afterwrd-scale .   # the image (for its workerd and Node)
test/scale/scale.sh build                                 # the code under test, into test/scale/out/build
node test/scale/net.mjs --leaves 60 --processes 2 --squeeze 72 --no-delays   # quick for setting up
test/scale/scale.sh up
for s in owners posts friends groups warm; do test/scale/scale.sh drive $s; done
test/scale/scale.sh down
node test/scale/net.mjs --leaves 60 --processes 2 --squeeze 72              # now with Cloudflare's delays
test/scale/scale.sh up
test/scale/scale.sh drive day 20      # section 8's day, squeezed into 20 minutes (default: a day over the squeeze)
test/scale/scale.sh drive oneoffs     # one post to every friend, an @here, a poll the whole group answers
node test/scale/analyse.mjs           # out/report.md
```

Don't change `src/` or rebuild while a run is going: the processes read `out/build`.

## On a rented server

For networks too big for this computer (1,000 sites take about 95 GB: see Memory, below), `vm.sh` runs everything on a Linux server with
Docker, from a copy of `worker/`, as root: `test/scale/vm.sh rehearse` first (a small network end to end), then
`test/scale/vm.sh section8` (about 1,000 sites, a day squeezed into an hour, on four servers). Each step is marked done, so running it again carries on after a failure. It logs to
`out/<mode>/run.log` and leaves everything in `out/<mode>.tgz`.

- One workerd runs its JavaScript on one thread, so `section8` runs 64 processes of about 16 sites: 16 cores a server.
- Start the server with `cloud-init.yaml` as its user data. It raises `vm.max_map_count` (Linux's usual 65,530 is
  too few for hundreds of isolates in one process; Docker on a Mac allows 262,144) and turns off automatic updates,
  which restarted containerd during a run.
- Memory: the rehearsal (22 Nov) peaked at about 3 GB a workerd process of 32 sites, about 95 MB a site, though each
  site's own heap was 10–15 MB (40 MB for the group's): the rest is workerd and each site's compiled code. So
  `section8`'s 1,000 sites need about 95 GB: four 32 GB servers (below).
- Copy the results back and run `node test/scale/analyse.mjs <dir>` here: the report reads them from any folder.
- To rehearse it here without touching a network that's kept, give other names: `SCALE_NAME`, `SCALE_IMAGE` and
  `SCALE_VOLUME`, and run it in a copy of `worker/`.

## On several machines

One server only goes so far (1,000 sites take about 95 GB), and the biggest sizes have to be switched on by the
provider. Instead, the network can be spread over several: `net.mjs --machines` gives each process a machine (their
addresses, in order), and each machine runs `scale.sh up` with `SCALE_MACHINE` set to its own address, starting only
its own processes.

- **The first machine** runs the hubs and the group, and `drive.mjs`, which reads the measuring lines there. The
  other machines send it their measuring lines (port 9300), so its `stats.log` has
  everything; each also keeps its own, and `check.mjs` checks none went missing.
- **Routers and tools listen on the machine's address** (ports 8081 up and 9400 up), with no sign-in: only the other
  test machines may reach them (a private network, or a firewall that lets in only them).
- **Each machine has its own** data volume, `out/` folder and copy of the build.

### Rehearsing here

`machines.sh` runs each machine as a container on its own Docker network (172.30.0.10 up), with its own names,
volumes and `out/multi/` folder, so a network that's kept is left alone. `MACHINES` (default 3) says how many.

```sh
test/scale/machines.sh build
test/scale/machines.sh net --leaves 12 --processes 4 --squeeze 72 --no-delays
test/scale/machines.sh up
for s in owners posts friends groups warm; do test/scale/machines.sh drive $s; done
test/scale/machines.sh down
test/scale/machines.sh net --leaves 12 --processes 4 --squeeze 72
test/scale/machines.sh up
test/scale/machines.sh drive day 10  # and oneoffs
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
SCALE_NET="--leaves 12 --processes 4 --squeeze 72" test/scale/exo.sh run rehearse
test/scale/exo.sh log rehearse              # how it's going; it carries on if this computer sleeps
test/scale/exo.sh fetch rehearse            # out/exoscale-multi/rehearse/report.md
test/scale/exo.sh delete                    # the servers and their security group; then shows what's left
```

- Private networks aren't enabled on the account, so the servers talk over their public addresses. Their security
  group (`afterwrd-scale-multi`, made by `create`, removed by `delete`) lets in ssh from this computer's address only,
  and the test's ports (8081–8299, 9300, 9400–9499, and ssh) only from servers in the group.
- Give the network at least as many processes as servers (`--processes`), and a core for each process on its server.
  The hubs and the group go in the first server's processes.
- Each server powers itself off after 4 hours (`cloud-init.yaml`), but only `delete` stops the charges.

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
