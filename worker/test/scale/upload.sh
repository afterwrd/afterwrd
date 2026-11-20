#!/bin/sh
# Copies a run's results to Exoscale object storage as it goes (README.md, "Keeping the results"), so nothing depends on
# the computer that started it. On the first server, as root, from worker/ (vm.sh starts it when the key is there):
#   test/scale/upload.sh <mode> <run>        every 5 minutes while vm.sh <mode> runs, then once more when it's stopped
#   test/scale/upload.sh <mode> <run> once   everything now, once (vm.sh's last step, before the servers power off)
# The key (/root/afterwrd-scale-sos.env: EXOSCALE_API_KEY, EXOSCALE_API_SECRET) reaches one bucket and nothing else.
# Under sos://afterwrd-scale-results/<run>/:
#   stats/stats.log.NNNN.gz   the measuring lines, a part each round: what was added since the one before (put the
#                             parts together in order, unzipped, and it's stats.log; a part can end mid-line)
#   latest.tgz                the rest, small enough to send whole each round: results/ (the day's actions), resources,
#                             the run's log, net.json, census-*.json, and the other servers' files once collected
#   <mode>.tgz                at the end: what vm.sh packs
set -eu
cd "$(dirname "$0")/../.."
MODE="${1:?Which mode?}"
RUN="${2:?Which run?}"
BUCKET=afterwrd-scale-results
OUT="$PWD/test/scale/out"
UP="$OUT/upload"
KEYS=/root/afterwrd-scale-sos.env
mkdir -p "$UP"
exec >>"$UP/upload.log" 2>&1
set -a
. "$KEYS"
set +a
export EXOSCALE_ZONE=ch-gva-2
say() { echo "== $* $(date -u +%H:%M:%S)"; }
# Each upload given at most 10 minutes: one that hangs mustn't hold up the end of a run.
put() { timeout 600 exo -Q storage upload "$1" "sos://$BUCKET/$RUN/$2" >/dev/null; }

exo -Q storage mb "sos://$BUCKET" -z ch-gva-2 >/dev/null 2>&1 || true # there already is fine

# One round at a time (flock): the 5-minute loop's and vm.sh's last one never write the same files at once.
round() { flock -w 900 "$UP/lock" sh -c '. "$0"; send' "$UP/round.sh"; }
cat >"$UP/round.sh" <<ROUND
OUT='$OUT' UP='$UP' MODE='$MODE' BUCKET='$BUCKET' RUN='$RUN'
say() { echo "== \$* \$(date -u +%H:%M:%S)"; }
put() { timeout 600 exo -Q storage upload "\$1" "sos://\$BUCKET/\$RUN/\$2" >/dev/null; }
send() {
  # The measuring lines added since the last part. A part counts as sent only once it's up: one that failed is cut
  # again, with whatever's been added since, next time.
  size=\$(stat -c %s "\$OUT/stats.log" 2>/dev/null || echo 0)
  sent=\$(cat "\$UP/stats.sent" 2>/dev/null || echo 0)
  if [ "\$size" -lt "\$sent" ]; then sent=0; fi # started again from nothing
  if [ "\$size" -gt "\$sent" ]; then
    n=\$((\$(cat "\$UP/stats.parts" 2>/dev/null || echo 0) + 1))
    part="\$(printf 'stats.log.%04d.gz' "\$n")"
    tail -c +\$((sent + 1)) "\$OUT/stats.log" | head -c \$((size - sent)) | gzip -1 >"\$UP/\$part" || return 1
    put "\$UP/\$part" "stats/\$part" || { rm -f "\$UP/\$part"; return 1; }
    # The part's number first: if this stops between the two, the next part repeats some lines rather than missing them.
    echo "\$n" >"\$UP/stats.parts"
    echo "\$size" >"\$UP/stats.sent"
    rm -f "\$UP/\$part"
  fi
  # Everything else, whole. (The other servers' own copies of their measuring lines, collected for vm.sh's check,
  # are already in stats.log.)
  (cd "\$OUT" && tar czf "\$UP/latest.tgz" --ignore-failed-read --exclude 'machines/*/stats.log' \
    \$(ls -d results resources.log net.json census-*.json machines "\$MODE/run.log" 2>/dev/null)) || return 1
  put "\$UP/latest.tgz" latest.tgz || return 1
  say "sent: stats.log to \$size bytes (\$(cat "\$UP/stats.parts" 2>/dev/null || echo 0) parts), latest.tgz \$(stat -c %s "\$UP/latest.tgz") bytes"
}
ROUND
last() {
  round || say "the last round failed"
  if [ -s "$OUT/$MODE.tgz" ]; then put "$OUT/$MODE.tgz" "$MODE.tgz" && say "sent $MODE.tgz" || say "sending $MODE.tgz failed"; fi
}

if [ "${3:-}" = once ]; then
  last
  say "done (once)"
  exit 0
fi
say "uploading $MODE to sos://$BUCKET/$RUN/"
rm -f "$UP/last"
# Every 5 minutes while the run goes, until vm.sh says it's taking over for the last one (upload/last).
while pgrep -f "vm.sh $MODE" >/dev/null && [ ! -e "$UP/last" ]; do
  round || say "that round failed: trying again next time"
  for i in $(seq 1 30); do
    if [ -e "$UP/last" ] || ! pgrep -f "vm.sh $MODE" >/dev/null; then break; fi
    sleep 10
  done
done
if [ -e "$UP/last" ]; then say "vm.sh is sending the last round"; exit 0; fi
# vm.sh stopped without taking over (killed): everything once more, and what it packed.
last
say "done"
