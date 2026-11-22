#!/bin/sh
# The scale test (docs/scale-test-plan.md), from worker/:
#   test/scale/scale.sh build         builds the release into test/scale/out/build (selfhost/build.mjs)
#   test/scale/scale.sh up            starts the network's container (after net.mjs has written out/net.json)
#   test/scale/scale.sh drive <args>  runs drive.mjs inside it
#   test/scale/scale.sh down          stops it (the data volume stays; `reset` removes it)
#   test/scale/scale.sh snapshot      saves the (stopped) network's data to out/snapshot.tar; `restore` puts it back
# On several machines (net.mjs --machines), each runs `up` with SCALE_MACHINE set to its address, and `drive` runs on
# the first. With SCALE_NETWORK too, the container joins that Docker network at that address (machines.sh, rehearsing
# on one computer); without it, it uses the server's own network (one container per server).
set -eu
cd "$(dirname "$0")/../.."
# Other names can be given, to try things without touching a network that's kept (vm.sh's rehearsal does).
NAME="${SCALE_NAME:-afterwrd-scale-net}"
IMAGE="${SCALE_IMAGE:-afterwrd-scale}"
VOLUME="${SCALE_VOLUME:-afterwrd-scale-data}"
OUT="${SCALE_OUT:-$PWD/test/scale/out}"
mkdir -p "$OUT"
NETWORK=""
if [ -n "${SCALE_MACHINE:-}" ]; then
  if [ -n "${SCALE_NETWORK:-}" ]; then NETWORK="--network $SCALE_NETWORK --ip $SCALE_MACHINE"; else NETWORK="--network host"; fi
  NETWORK="$NETWORK -e SCALE_MACHINE=$SCALE_MACHINE"
fi
case "${1:-}" in
  build)
    node selfhost/build.mjs "$OUT/build" ;;
  up)
    # shellcheck disable=SC2086
    docker run -d --name "$NAME" --init $NETWORK -v "$VOLUME:/data" -v "$OUT/build:/build" -v "$PWD/selfhost:/selfhost:ro" \
      -v "$PWD/test/scale:/scale:ro" -v "$PWD/public/static:/static:ro" -v "$OUT:/out" --entrypoint node "$IMAGE" /scale/start.mjs ;;
  drive)
    shift
    docker exec "$NAME" node /scale/drive.mjs "$@" ;;
  shell)
    docker exec -it "$NAME" sh ;;
  down)
    docker stop "$NAME" >/dev/null && docker rm "$NAME" >/dev/null ;;
  reset)
    docker volume rm "$VOLUME" ;;
  snapshot)
    docker run --rm -v "$VOLUME:/data" -v "$OUT:/out" --entrypoint tar "$IMAGE" cf /out/snapshot.tar -C /data . ;;
  restore)
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    docker run --rm -u 0 -v "$VOLUME:/data" -v "$OUT:/out" --entrypoint tar "$IMAGE" xf /out/snapshot.tar -C /data ;;
  *)
    echo "Usage: test/scale/scale.sh build|up|drive|shell|down|reset|snapshot|restore" >&2; exit 1 ;;
esac
