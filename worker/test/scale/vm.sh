#!/bin/sh
# The whole scale test on a rented Linux server with Docker (test/scale/README.md, "On a rented server"), from worker/,
# as root:
#   test/scale/vm.sh smoke   a small network end to end, a few minutes: proves this box runs everything
#   test/scale/vm.sh mid     1,000 sites (about 26 GB): hubs of 150, 500 and 1,000 friends, groups of 150 and 300
#   test/scale/vm.sh full    2,000 sites (about 55 GB): hubs of 150, 500, 1,000 and 2,000 friends, groups of 150 and 300
#   test/scale/vm.sh social  the social model (net.mjs --model social): a network shaped like Facebook's, a realistic
#                            day (social_day), then Home for the outliers, one post to all of an outlier's friends, the
#                            groups' runs and closing them; SCALE_NET sets its size (the default is 3,000 people)
#   test/scale/vm.sh halt <mode>  the end of a stuck run (watchdog.sh): the last upload, then the servers power off
#   test/scale/vm.sh local   300 sites (about 8 GB, fits Docker on a Mac): a day in groups of 150 and 300, Home, the
#                            groups' runs and a day; for comparing two versions of the code (run each in its own copy)
# Each step is marked done in test/scale/out/<mode>/, so running it again carries on after the last step that worked.
# Everything is logged to test/scale/out/<mode>/run.log; the report and data end up in test/scale/out/<mode>.tgz.
# SCALE_NET gives the network's net.mjs options instead of the mode's.
#
# On several servers (README.md, "On several machines"; exo.sh sets them up): MACHINES="<address> <address> …",
# the servers' addresses, this one first (only the test's servers may reach them on the test's ports). Each has its own copy of worker/; this one runs the hubs, the groups and
# drive.mjs, and reaches the others as ubuntu over ssh with SCALE_SSH_KEY. Their measuring lines and logs are copied
# into out/machines/<address>/ at the end, and checked against this one's stats.log.
set -eu
# On a Mac (a rehearsal), kept awake while it runs: asleep, Docker stops, and the test's timings with it.
if [ -z "${SCALE_AWAKE:-}" ] && command -v caffeinate >/dev/null 2>&1; then SCALE_AWAKE=1 exec caffeinate -i "$0" "$@"; fi
cd "$(dirname "$0")/../.."
OUT="$PWD/test/scale/out"
IMAGE="${SCALE_IMAGE:-afterwrd-scale}"
MACHINES="$(echo "${MACHINES:-}" | tr ',' ' ')"
FIRST="${MACHINES%% *}"
KEY="${SCALE_SSH_KEY:-/root/.ssh/afterwrd-scale-internal}"
# Node from the image (the server needn't have its own), as root so it can write here.
node_() { docker run --rm -u 0 -v "$PWD:/w" -w /w --entrypoint node "$IMAGE" "$@"; }
# The sites run as the image's user (10001), so it must be able to write the build (each process's config) and out/.
mine() { if [ "$(id -u)" = 0 ]; then chown -R 10001:10001 "$OUT"; fi; }

# What each server does for itself: here, and on the others through ssh (vm.sh part <name>, with SCALE_MACHINE set).
part() {
  mkdir -p "$OUT"
  case "$1" in
    image) docker build -q -f selfhost/Dockerfile -t "$IMAGE" . ;;
    build) rm -rf "$OUT/build"; docker run --rm -u 0 -v "$OUT:/out" --entrypoint cp "$IMAGE" -r /app/build /out/build ;;
    fresh) test/scale/scale.sh down 2>/dev/null || true; test/scale/scale.sh reset 2>/dev/null || true
           rm -rf "$OUT/results" "$OUT"/stats.log "$OUT"/resources.log "$OUT"/census-*.json "$OUT"/workerd-*.log "$OUT/machines" ;;
    # Each site's data: sizes and row counts, with the sites stopped (census.mjs).
    census) docker run --rm -u 0 -v "${SCALE_VOLUME:-afterwrd-scale-data}:/data" -v "$OUT:/out" -v "$PWD/test/scale:/scale:ro" \
              --entrypoint node "$IMAGE" /scale/census.mjs "${SCALE_MACHINE:-127.0.0.1}" ;;
    up) mine; test/scale/scale.sh up >/dev/null ;;
    down) test/scale/scale.sh down 2>/dev/null || true ;;
    memory) echo "$(hostname): $(free -g 2>/dev/null | sed -n 2p)"
            docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' || true ;;
    *) echo "No such part: $1" >&2; exit 1 ;;
  esac
}
if [ "${1:-}" = part ]; then part "$2"; exit; fi
# vm.sh halt <mode>: the end of a run that won't stop by itself (watchdog.sh): the last upload, then power off.
HALT=""
if [ "${1:-}" = halt ]; then HALT=1; shift; fi

MODE="${1:-}"
case "$MODE" in
  smoke) NET="--leaves 12 --processes 2 --hubs 5,12 --groups 4,12"; DAY=3 ;;
  mid) NET="--leaves 1000 --processes 10 --hubs 150,500,1000 --groups 150,300"; DAY=60 ;;
  full) NET="--leaves 2000 --processes 16 --hubs 150,500,1000,2000 --groups 150,300"; DAY=60 ;;
  local) NET="--leaves 300 --processes 3 --hubs 300 --groups 150,300"; DAY=30; SCENARIOS="group_day home groups_run day" ;;
  social) NET="--model social --people 3000 --processes 24 --squeeze 8"; DAY=120; SCENARIOS="${SCENARIOS:-social_day home fanout groups_run close}"; WARM=warm ;;
  *) echo "Usage: test/scale/vm.sh smoke|mid|full|local|social" >&2; exit 1 ;;
esac
NET="${SCALE_NET:-$NET}"
WARM="${WARM:-}"
SCENARIOS="${SCENARIOS:-group_day home fanout groups_run day close}"
DONE="$OUT/$MODE"
mkdir -p "$DONE"
exec >>"$DONE/run.log" 2>&1
say() { echo "== $* $(date -u +%H:%M:%S)"; }
# The watchdog asks a stuck run to stop by leaving this (watchdog.sh): checked before and after every step, as a
# command it interrupts can still end as if it had worked.
STOP="$DONE/stop"
stopped() { if [ -e "$STOP" ]; then say "stopped by the watchdog"; exit 1; fi; }
# A step done before is skipped; one that fails returns its failure, which ends the run unless the caller carries on
# (`step … || …`: each scenario does, so one failing doesn't lose the rest).
step() {
  name="$1"; shift
  stopped
  if [ -e "$DONE/$name.done" ]; then say "$name (done before)"; return 0; fi
  say "$name"
  if "$@"; then
    stopped
    touch "$DONE/$name.done"
  else
    failed=$?
    stopped
    say "$name failed (exit $failed)"
    return "$failed"
  fi
}

# The other servers, and running things on them.
others() { for m in $MACHINES; do if [ "$m" != "$FIRST" ]; then echo "$m"; fi; done; }
on() { # on <address> <command>
  m="$1"; shift
  ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts_scale \
    -o ConnectTimeout=10 "ubuntu@$m" "$@"
}
# A part on every server at once; fails if it fails on any.
everywhere() {
  if [ -n "$FIRST" ]; then export SCALE_MACHINE="$FIRST"; fi
  part "$1" &
  pids="$!"
  for m in $(others); do
    on "$m" "cd worker && sudo SCALE_MACHINE=$m SCALE_IMAGE=$IMAGE test/scale/vm.sh part $1" &
    pids="$pids $!"
  done
  failed=0
  for p in $pids; do wait "$p" || failed=1; done
  if [ "$failed" = 1 ]; then echo "$1 failed on a server" >&2; return 1; fi
}

start() { # no-delays | delays
  everywhere down
  machines=""
  if [ -n "$MACHINES" ]; then machines="--machines $(echo $MACHINES | tr ' ' ,)"; fi
  # shellcheck disable=SC2086
  if [ "$1" = no-delays ]; then node_ test/scale/net.mjs $NET $machines --no-delays; else node_ test/scale/net.mjs $NET $machines; fi
  for m in $(others); do on "$m" "sudo tee worker/test/scale/out/net.json >/dev/null" <"$OUT/net.json"; done
  everywhere up
  say "up ($1)"
}
memory() { everywhere memory || true; }

say "start $MODE: $NET, day $DAY minutes${MACHINES:+, on $MACHINES}"
# Results go to object storage as they come (upload.sh), when this server has the key for it: under a name for this
# run, kept so a run carried on later uploads to the same place.
UPLOADING=""
if [ -s /root/afterwrd-scale-sos.env ] && [ -z "${SCALE_NO_UPLOAD:-}" ]; then
  [ -s "$DONE/run-name" ] || echo "$MODE-$(date -u +%Y%m%d-%H%M)" >"$DONE/run-name"
  if [ -z "$HALT" ] && ! pgrep -f "upload.sh $MODE" >/dev/null; then nohup test/scale/upload.sh "$MODE" "$(cat "$DONE/run-name")" </dev/null >/dev/null 2>&1 & fi
  UPLOADING=1
  say "uploading to sos://afterwrd-scale-results/$(cat "$DONE/run-name")/"
fi

# The end, however it comes (finished, failed, or stopped by the watchdog): the results go up one last time, then
# every server powers off, so none sits there billed with nobody watching (a run that failed at 01:49 left eight
# servers idle until their time ran out at 06:31). SCALE_POWER_OFF=1 powers them off (exo.sh run sets it); "test" only
# says it would (a rehearsal on a Mac); unset, nothing.
FINISHED=""
# A command that can't run for ever: `limit <seconds> <command…>` (coreutils timeout; on a Mac, a rehearsal, as is).
limit() { s="$1"; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi; }
# Every server at once, each given at most 30 seconds: `all_servers <shell command>`. Says which didn't take it. (ssh
# itself under the limit: timeout runs a program, not one of this script's functions such as `on`.)
# Waits for those calls only: a bare `wait` would wait for the watchdog and the uploader too, which run until this ends.
all_servers() {
  calls=""
  for m in $(others); do
    (limit 30 ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts_scale \
      -o ConnectTimeout=10 "ubuntu@$m" "$1" </dev/null >/dev/null 2>&1 || say "couldn't reach $m to: $1") &
    calls="$calls $!"
  done
  for c in $calls; do wait "$c"; done
}
finish() {
  status=$?
  # Nothing in here may stop it part way: not a full disk making a log line fail, nor a server that won't answer.
  set +e
  trap - EXIT
  if [ -z "$FINISHED" ]; then say "stopped before finishing (exit $status)"; fi
  if [ "${SCALE_POWER_OFF:-}" = 1 ]; then
    # First, a backstop: whatever happens below (an upload that hangs), every server powers off within 20 minutes.
    all_servers "sudo shutdown -h +20 'afterwrd scale test: the run has ended'"
    shutdown -h +20 "afterwrd scale test: the run has ended" 2>/dev/null
  fi
  if [ -n "$UPLOADING" ]; then
    # The 5-minute uploader finishes the round it's in and stops; then the last one (upload.sh holds a lock).
    touch "$OUT/upload/last" 2>/dev/null
    say "last upload"
    limit 900 test/scale/upload.sh "$MODE" "$(cat "$DONE/run-name")" once || say "the last upload failed (the results are still on this server)"
  fi
  case "${SCALE_POWER_OFF:-}" in
    1) say "powering off every server"
       all_servers "sudo shutdown -h now"
       pkill -f "watchdog.sh $MODE" 2>/dev/null
       shutdown -h now ;;
    test) say "would power off: $(others | tr '\n' ' ')and this one"
          pkill -f "watchdog.sh $MODE" 2>/dev/null ;;
    *) pkill -f "watchdog.sh $MODE" 2>/dev/null ;;
  esac
  exit "$status"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP
if [ -n "$HALT" ]; then say "halting: the run wouldn't stop"; exit 1; fi
rm -f "$STOP" # a run carried on after the watchdog stopped it
# If nothing's been logged for a while, something's stuck: the watchdog stops this run (and so powers off).
if ! pgrep -f "watchdog.sh $MODE" >/dev/null; then
  nohup test/scale/watchdog.sh "$MODE" "${SCALE_WATCHDOG_MINUTES:-30}" </dev/null >>"$DONE/run.log" 2>&1 &
fi
step image everywhere image
step build everywhere build
step fresh everywhere fresh

# Setting up, with no delays between sites (done once its last step is: the warm-up, if there is one).
if [ ! -e "$DONE/${WARM:-groups}.done" ]; then
  start no-delays
  for s in owners posts friends groups $WARM; do step "$s" test/scale/scale.sh drive "$s"; memory; done
fi

# The scenarios, with Cloudflare's delays.
start delays
# Each scenario on its own: one failing is noted, and the next goes ahead.
for s in $SCENARIOS; do
  case "$s" in
    day) step day test/scale/scale.sh drive day "$DAY" || say "carrying on without day" ;;
    group_day) step group_day test/scale/scale.sh drive group_day 20 || say "carrying on without group_day" ;;
    close) step close test/scale/scale.sh drive groups_run close || say "carrying on without close" ;;
    *) step "$s" test/scale/scale.sh drive "$s" || say "carrying on without $s" ;;
  esac
  memory
done
# Then the ending: none of it may stop the rest, or the last upload (finish).
everywhere down || say "stopping the sites failed somewhere: carrying on"
step census everywhere census || say "carrying on without the census"
# The other servers' measuring lines and logs, beside this one's; every line they made must be in stats.log here.
collect() {
  for m in $(others); do
    mkdir -p "$OUT/machines/$m"
    on "$m" "cd worker/test/scale/out && sudo tar cf - stats.log \$(ls resources.log census-*.json workerd-*.log 2>/dev/null)" | tar xf - -C "$OUT/machines/$m" ||
      say "couldn't collect from $m"
  done
  # shellcheck disable=SC2046
  if [ -n "$(others)" ]; then node_ test/scale/check.mjs test/scale/out/stats.log $(ls test/scale/out/machines/*/stats.log) || say "the check found lines missing"; fi
  # Their lines are all in stats.log here: their own copies, only for the check, go.
  rm -f "$OUT"/machines/*/stats.log
}
step collect collect || say "carrying on without collecting"
report() { node_ test/scale/analyse.mjs >/dev/null; }
step report report || say "carrying on without the report"
pack() {
  # The measuring lines are already in object storage, in parts (upload.sh), when uploading: not packed again.
  lines="stats.log"
  if [ -n "$UPLOADING" ]; then lines=""; fi
  # shellcheck disable=SC2046
  tar czf "$OUT/$MODE.tgz" -C "$OUT" $(cd "$OUT" && ls -d report.md results net.json "$MODE/run.log" $lines workerd-*.log resources.log census-*.json machines 2>/dev/null)
}
step pack pack || say "carrying on without packing"
FINISHED=1
say "finished $MODE"
