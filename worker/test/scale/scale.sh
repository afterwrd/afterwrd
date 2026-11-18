#!/bin/sh
# The scale test (docs/scale-test-plan.md), from worker/:
#   test/scale/scale.sh build         builds the release into test/scale/out/build (selfhost/build.mjs)
#   test/scale/scale.sh up            starts the network's container (after net.mjs has written out/net.json)
#   test/scale/scale.sh drive <args>  runs drive.mjs inside it
#   test/scale/scale.sh down          stops it (the data volume stays; `reset` removes it)
#   test/scale/scale.sh snapshot      saves the (stopped) network's data to out/snapshot.tar; `restore` puts it back
set -eu
cd "$(dirname "$0")/../.."
NAME=afterwrd-scale-net
IMAGE=afterwrd-scale
VOLUME=afterwrd-scale-data
OUT="$PWD/test/scale/out"
mkdir -p "$OUT"
case "${1:-}" in
  build)
    node selfhost/build.mjs "$OUT/build" ;;
  up)
    docker run -d --name "$NAME" --init -v "$VOLUME:/data" -v "$OUT/build:/build" -v "$PWD/selfhost:/selfhost:ro" \
      -v "$PWD/test/scale:/scale:ro" -v "$OUT:/out" --entrypoint node "$IMAGE" /scale/start.mjs ;;
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
