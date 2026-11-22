#!/bin/sh
# Stops a scale test that's stuck, so it can't sit on rented servers with nobody watching (vm.sh starts it):
#   test/scale/watchdog.sh <mode> <minutes>
# If neither the run's log nor the day's action log has changed for <minutes>, it stops vm.sh and whatever vm.sh is
# waiting on (a stuck drive.mjs, an ssh to another server), and vm.sh's end (finish) uploads the results and powers
# every server off. If vm.sh still hasn't ended two minutes later, it does that itself (vm.sh halt). It ends when
# vm.sh does. Every step of a run logs at least every few minutes, so a long quiet means stuck.
set -u
cd "$(dirname "$0")/../.."
MODE="${1:?Which mode?}"
MINUTES="${2:-30}"
OUT="$PWD/test/scale/out"
say() { echo "== watchdog: $* $(date -u +%H:%M:%S)"; }
changed() { # when the newest of the run's logs last changed (seconds since 1970), on Linux or a Mac
  for f in "$OUT/$MODE/run.log" "$OUT/results-day.jsonl"; do
    if [ -e "$f" ]; then stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"; fi
  done | sort -n | tail -n 1
}

say "watching vm.sh $MODE: it's stopped if nothing's logged for $MINUTES minutes"
while pgrep -f "vm.sh $MODE" >/dev/null; do
  sleep 60
  last="$(changed)"
  quiet=$(($(date +%s) - ${last:-$(date +%s)}))
  if [ "$quiet" -gt $((MINUTES * 60)) ]; then
    say "nothing logged for $((quiet / 60)) minutes: stopping the run"
    touch "$OUT/$MODE/stop" # vm.sh checks for it between steps, and ends (finish: upload, power off)
    pkill -TERM -f "vm.sh $MODE" 2>/dev/null
    # What it's waiting on: dash runs a trap only once the command it's waiting for ends.
    pkill -TERM -f "docker exec" 2>/dev/null
    pkill -TERM -f "afterwrd-scale-internal" 2>/dev/null
    for i in $(seq 1 24); do
      if ! pgrep -f "vm.sh $MODE" >/dev/null; then exit 0; fi
      sleep 5
    done
    say "the run didn't stop: ending it from here"
    pkill -KILL -f "vm.sh $MODE" 2>/dev/null
    exec test/scale/vm.sh halt "$MODE"
  fi
done
