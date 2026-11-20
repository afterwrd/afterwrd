#!/bin/sh
# The scale test on several machines, rehearsed on this computer (test/scale/README.md, "On several machines"): each
# machine is a container on its own private Docker network, with its own data volume and out/ folder, as separate
# servers would have. From worker/:
#   test/scale/machines.sh build              the image and the code under test, for every machine
#   test/scale/machines.sh net <net.mjs args> the network over the machines (adds --machines), copied to each
#   test/scale/machines.sh up                 starts every machine
#   test/scale/machines.sh drive <args>       runs drive.mjs on the first machine
#   test/scale/machines.sh check              every machine's measuring lines reached the first machine's stats.log
#   test/scale/machines.sh report             analyse.mjs on the first machine's results (out/multi/m0/report.md)
#   test/scale/machines.sh down | reset       stops them | removes their data and the Docker network too
# MACHINES (default 3) says how many. Names, volumes and folders are all its own (afterwrd-multi-*, out/multi/), so a
# network that's kept is left alone.
set -eu
cd "$(dirname "$0")/../.."
MACHINES="${MACHINES:-3}"
PREFIX=afterwrd-multi
IMAGE="$PREFIX"
NETWORK="$PREFIX-net"
SUBNET=172.30.0
OUT="$PWD/test/scale/out/multi"
mkdir -p "$OUT"
addr() { echo "$SUBNET.$((10 + $1))"; }
each() { i=0; while [ "$i" -lt "$MACHINES" ]; do "$@" "$i"; i=$((i + 1)); done; }
on() { # on <machine> <scale.sh args...>
  m="$1"; shift
  SCALE_NAME="$PREFIX-m$m" SCALE_IMAGE="$IMAGE" SCALE_VOLUME="$PREFIX-data-m$m" SCALE_OUT="$OUT/m$m" \
    SCALE_MACHINE="$(addr "$m")" SCALE_NETWORK="$NETWORK" test/scale/scale.sh "$@"
}
addresses() { a=""; i=0; while [ "$i" -lt "$MACHINES" ]; do a="$a${a:+,}$(addr "$i")"; i=$((i + 1)); done; echo "$a"; }

case "${1:-}" in
  build)
    docker build -q -f selfhost/Dockerfile -t "$IMAGE" .
    rm -rf "$OUT/build"
    docker run --rm -v "$OUT:/out" --entrypoint cp "$IMAGE" -r /app/build /out/build
    copy() { mkdir -p "$OUT/m$1"; rm -rf "$OUT/m$1/build"; cp -R "$OUT/build" "$OUT/m$1/build"; }
    each copy ;;
  net)
    shift
    node test/scale/net.mjs "$@" --machines "$(addresses)"
    put() { mkdir -p "$OUT/m$1"; cp test/scale/out/net.json "$OUT/m$1/net.json"; }
    each put ;;
  up)
    docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create --subnet "$SUBNET.0/24" "$NETWORK" >/dev/null
    start() { on "$1" up >/dev/null && echo "machine $1 up at $(addr "$1")"; }
    each start ;;
  drive)
    shift
    on 0 drive "$@" ;;
  check)
    others=""; i=1; while [ "$i" -lt "$MACHINES" ]; do others="$others $OUT/m$i/stats.log"; i=$((i + 1)); done
    # shellcheck disable=SC2086
    node test/scale/check.mjs "$OUT/m0/stats.log" $others ;;
  report)
    node test/scale/analyse.mjs "$OUT/m0" ;;
  down)
    stop() { on "$1" down 2>/dev/null || true; }
    each stop ;;
  reset)
    stop() { on "$1" down 2>/dev/null || true; on "$1" reset 2>/dev/null || true; }
    each stop
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    rm -rf "$OUT" ;;
  *)
    echo "Usage: test/scale/machines.sh build|net|up|drive|check|report|down|reset" >&2; exit 1 ;;
esac
