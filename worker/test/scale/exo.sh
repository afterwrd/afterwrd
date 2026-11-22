#!/bin/sh
# The scale test on several Exoscale servers, driven from this computer (README.md, "On several machines"), from worker/:
#   test/scale/exo.sh create <n> [type]   n servers (default standard.large), in a security group of their own
#   test/scale/exo.sh push                copies this worker/ to each
#   test/scale/exo.sh run <mode>          starts vm.sh <mode> on the first, over all of them; it carries on if this
#                                         computer sleeps or disconnects (SCALE_NET passes other net.mjs options)
#   test/scale/exo.sh resume <mode>       starts stopped servers again (swap on, a new power-off after EXO_HOURS), copies
#                                         worker/ again and carries the run on from its last finished step
#   test/scale/exo.sh log <mode>          the end of the run's log
#   test/scale/exo.sh fetch <mode>        copies <mode>.tgz back, into out/exoscale-multi/<mode>/
#   test/scale/exo.sh sync <mode> [min]   while it runs: copies what it's measured so far into out/exoscale-multi/<mode>/live/
#                                         every <min> minutes (default 10), only what's new each time, until it's finished
#   test/scale/exo.sh results [run]       a run's results from object storage (upload.sh), into out/exoscale-multi/<run>/
#                                         with stats.log put back together; with no run, lists them
#   test/scale/exo.sh delete              deletes the servers and their security group, then shows what's left
#   test/scale/exo.sh status              the servers, and what they cost an hour
# Uses what the single-server runs made: the exo CLI signed in and the ssh key afterwrd-scale (~/.ssh/afterwrd-exoscale).
# With ~/.config/afterwrd-scale/sos.env (a key that reaches only the bucket afterwrd-scale-results: EXOSCALE_API_KEY,
# EXOSCALE_API_SECRET), create puts it and exo on the first server, and the run uploads its results as it goes.
# The servers talk over their public addresses (private networks aren't enabled on the account), where the test's
# routers and tools listen with no sign-in, so their security group (afterwrd-scale-multi) lets in only ssh from this
# computer's address, and the test's ports only from the servers in the group. Each server powers itself off after
# EXO_MINUTES minutes (or EXO_HOURS; default 4 hours; cloud-init.yaml), and every server powers off when the run ends,
# however it ends (vm.sh finish, and watchdog.sh if it's stuck); only `delete` stops the charges for good.
set -eu
cd "$(dirname "$0")/../.."
ZONE="${EXO_ZONE:-ch-gva-2}"
PREFIX=afterwrd-scale-m
GROUP=afterwrd-scale-multi
TEMPLATE="Linux Ubuntu 24.04 LTS 64-bit"
KEY="$HOME/.ssh/afterwrd-exoscale"
HOSTS="$HOME/.ssh/known_hosts_afterwrd_scale"
STATE="$PWD/test/scale/out/exoscale-multi"
LIST="$STATE/machines" # one line per server: name, address
mkdir -p "$STATE"

say() { echo "== $* $(date -u +%H:%M:%S)"; }
on() { # on <public address> <command>
  h="$1"; shift
  ssh -i "$KEY" -o UserKnownHostsFile="$HOSTS" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 \
    -o ServerAliveInterval=30 "ubuntu@$h" "$@"
}
# Every server of the test's on Exoscale (by name), whether or not the list here knows it.
ours() { exo compute instance list -z "$ZONE" -O json 2>/dev/null | python3 -I -c 'import json, sys; [print(i["name"]) for i in json.load(sys.stdin) if i["name"].startswith(sys.argv[1])]' "$PREFIX"; }
# Whether vm.sh <mode> is already running on the first server. ([v]: so pgrep doesn't find the shell running it, whose
# own command line has "vm.sh <mode>" in it.)
running() { [ -n "$(on "$(first)" "pgrep -f '[v]m.sh $1' || true" </dev/null 2>/dev/null)" ]; }
need_list() { if [ ! -s "$LIST" ]; then echo "No servers: run create first." >&2; exit 1; fi; }
publics() { awk '{print $2}' "$LIST"; }
addresses() { publics | tr '\n' ' ' | sed 's/ $//'; }
first() { awk 'NR==1 {print $2}' "$LIST"; }
price() { # CHF an hour for an instance type, from Exoscale's public price list
  curl -fsS https://portal.exoscale.com/api/pricing/opencompute 2>/dev/null | python3 -I -c '
import json, sys
t = sys.argv[1]
family, size = t.split(".") if "." in t else ("standard", t)
key = "running_" + (size if family == "standard" else family + "_" + size).replace("-", "_")
print(json.load(sys.stdin)["chf"].get(key, "?"))' "$1" || echo "?"
}

case "${1:-}" in
  create)
    n="${2:?How many servers?}"
    type="${3:-standard.large}"
    if [ -s "$LIST" ] || [ -n "$(ours)" ]; then echo "Servers already made ($(ours | tr '\n' ' ')): delete them first." >&2; exit 1; fi
    say "creating $n × $type in $ZONE ($(price "$type") CHF an hour each)"
    if ! exo -Q compute security-group show "$GROUP" >/dev/null 2>&1; then
      me="$(curl -fsS -4 https://ifconfig.me)"
      exo -Q compute security-group create "$GROUP" --description "afterwrd scale test, several servers" >/dev/null
      exo -Q compute security-group rule add "$GROUP" --network "$me/32" --port 22 --description "ssh from this computer" >/dev/null
      # Between the servers only: ssh (the first drives the others), routers, measuring lines, tools.
      for port in 22 8081-8299 9300 9400-9499; do
        exo -Q compute security-group rule add "$GROUP" --security-group "$GROUP" --port "$port" --description "between the test servers" >/dev/null
      done
    fi
    # Each powers off after EXO_MINUTES (or EXO_HOURS): a forgotten server stops costing compute. Set it to the run's
    # expected length and a little more: the run powers them off itself when it ends (vm.sh finish), so this is only
    # for when everything else has failed.
    minutes="${EXO_MINUTES:-$((${EXO_HOURS:-4} * 60))}"
    sed "s/shutdown -h +[0-9]* \"[^\"]*\"/shutdown -h +$minutes \"afterwrd scale test, $minutes-minute cap\"/" test/scale/cloud-init.yaml >"$STATE/cloud-init.yaml"
    grep -q "shutdown -h +$minutes " "$STATE/cloud-init.yaml" || { echo "Couldn't set the power-off time in cloud-init.yaml." >&2; exit 1; }
    say "each powers off after $minutes minutes"
    i=0
    pids=""
    while [ "$i" -lt "$n" ]; do
      exo -Q compute instance create "$PREFIX$i" -z "$ZONE" --instance-type "$type" --template "$TEMPLATE" \
        --ssh-key afterwrd-scale --security-group "$GROUP" --cloud-init "$STATE/cloud-init.yaml" \
        --label purpose=afterwrd-scale >/dev/null &
      pids="$pids $!"
      i=$((i + 1))
    done
    made_all=1
    for p in $pids; do wait "$p" || made_all=""; done
    # Any that couldn't be made: those that were go again at once (delete finds them by name), rather than wait.
    if [ -z "$made_all" ]; then echo "Not every server could be made: deleting the ones that were." >&2; "$0" delete; exit 1; fi
    : >"$LIST.new"
    i=0
    while [ "$i" -lt "$n" ]; do
      # Asked for afterwards: create's own output can be empty with -Q.
      exo compute instance show "$PREFIX$i" -z "$ZONE" -O json >"$STATE/m$i.json"
      public="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["ip_address"])' "$STATE/m$i.json")"
      ssh-keygen -R "$public" -f "$HOSTS" >/dev/null 2>&1 || true
      echo "$PREFIX$i $public" >>"$LIST.new"
      i=$((i + 1))
    done
    mv "$LIST.new" "$LIST"
    cat "$LIST"
    say "waiting for them to start (cloud-init: Docker, settings)"
    for h in $(publics); do
      tries=0
      until on "$h" "test -e /var/lib/cloud/instance/boot-finished && sudo test -e /root/ready" 2>/dev/null; do
        tries=$((tries + 1))
        if [ "$tries" -gt 90 ]; then echo "$h didn't finish starting in 15 minutes." >&2; exit 1; fi
        sleep 10
      done
    done
    # The test listens on each server's address, so it must be on the server itself (not translated on the way).
    while read -r name h; do
      if [ -z "$(on "$h" "ip -4 -o addr show | grep -o ' $h/' || true" </dev/null)" ]; then echo "$name doesn't have $h on an interface." >&2; exit 1; fi
    done <"$LIST"
    say "a key for the first server to reach the others"
    f="$(first)"
    on "$f" "sudo test -e /root/.ssh/afterwrd-scale-internal || sudo ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/afterwrd-scale-internal -C afterwrd-scale-internal"
    pub="$(on "$f" "sudo cat /root/.ssh/afterwrd-scale-internal.pub")"
    for h in $(publics); do
      if [ "$h" != "$f" ]; then on "$h" "grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >>~/.ssh/authorized_keys"; fi
    done
    for p in $(addresses); do
      if [ "$p" = "$f" ]; then continue; fi
      on "$f" "sudo ssh -i /root/.ssh/afterwrd-scale-internal -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts_scale -o ConnectTimeout=10 ubuntu@$p hostname" |
        sed "s/^/$p: /"
    done
    sos="$HOME/.config/afterwrd-scale/sos.env"
    if [ -s "$sos" ]; then
      say "the results key and exo on the first server: the run uploads its results as it goes"
      on "$f" "sudo install -m 600 /dev/stdin /root/afterwrd-scale-sos.env" <"$sos"
      on "$f" 'set -e; cd /tmp; curl -fsSLo exo.tgz https://github.com/exoscale/cli/releases/download/v1.102.1/exoscale-cli_1.102.1_linux_amd64.tar.gz
        echo "15ce3784444dffaf911073361957678fbdd1009fdccfdcb8aa294cd473201975  exo.tgz" | sha256sum -c - >/dev/null
        mkdir -p exo-cli && tar xzf exo.tgz -C exo-cli && sudo install -m 755 exo-cli/exo /usr/local/bin/exo && exo version'
    else
      say "no results key ($sos): results come back only with sync and fetch"
    fi
    say "ready: $n servers, $(addresses)" ;;
  push)
    need_list
    for h in $(publics); do
      rsync -az --delete -e "ssh -i $KEY -o UserKnownHostsFile=$HOSTS -o BatchMode=yes" --exclude node_modules --exclude .wrangler \
        --exclude test/scale/out --exclude test/e2e/out --exclude test/e2e/chrome --exclude release --exclude generated --exclude '.dev.vars*' \
        --exclude '.env*' ./ "ubuntu@$h:worker/" &
      pids="${pids:-} $!"
    done
    for p in $pids; do wait "$p"; done
    say "copied worker/ to $(publics | tr '\n' ' ')" ;;
  run)
    need_list
    mode="${2:?Which mode?}"
    if running "$mode"; then echo "vm.sh $mode is already running on $(first): not starting another." >&2; exit 1; fi
    net=""
    if [ -n "${SCALE_NET:-}" ]; then net="SCALE_NET='$SCALE_NET'"; fi
    if [ -n "${SCALE_DAY:-}" ]; then net="$net SCALE_DAY='$SCALE_DAY'"; fi
    if [ -n "${SCALE_FRESH:-}" ]; then net="$net SCALE_FRESH=1"; fi
    if [ -n "${SCALE_REBUILD:-}" ]; then net="$net SCALE_REBUILD=1"; fi
    if [ -n "${SCALE_FROM:-}" ]; then net="$net SCALE_FROM='$SCALE_FROM'"; fi
    # SCALE_POWER_OFF: when the run ends, however it ends, every server powers off (vm.sh finish).
    on "$(first)" "cd worker && sudo MACHINES='$(addresses)' SCALE_POWER_OFF=1 $net sh -c 'nohup test/scale/vm.sh $mode >/dev/null 2>&1 </dev/null &'"
    sleep 3
    on "$(first)" "sudo tail -n 5 worker/test/scale/out/$mode/run.log" ;;
  resume)
    need_list
    mode="${2:?Which mode?}"
    minutes="${EXO_MINUTES:-$((${EXO_HOURS:-4} * 60))}"
    # Started servers have no power-off time until it's set below (cloud-init's is for the first boot only): if
    # anything goes wrong before then, they're all stopped again.
    stop_all() { for name in $(awk '{print $1}' "$LIST"); do exo -Q compute instance stop "$name" -z "$ZONE" -f >/dev/null 2>&1 & done; wait; }
    trap 'echo "resume stopped part way: stopping the servers again" >&2; stop_all' EXIT
    for name in $(awk '{print $1}' "$LIST"); do exo -Q compute instance start "$name" -z "$ZONE" -f >/dev/null 2>&1 & done
    wait
    if running "$mode"; then trap - EXIT; echo "vm.sh $mode is already running on $(first): not starting another." >&2; exit 1; fi
    # Their addresses stay theirs while they exist; checked all the same, as the run is set up with them.
    while read -r name h; do
      now="$(exo compute instance show "$name" -z "$ZONE" -O json | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["ip_address"])')"
      if [ "$now" != "$h" ]; then echo "$name is now at $now, not $h: the run can't carry on as it was." >&2; exit 1; fi
    done <"$LIST"
    for h in $(publics); do
      tries=0
      until on "$h" true 2>/dev/null; do tries=$((tries + 1)); if [ "$tries" -gt 60 ]; then echo "$h didn't come back." >&2; exit 1; fi; sleep 5; done
      # Only the first boot runs cloud-init's commands: swap, and a power-off time, again.
      on "$h" "sudo swapon /swapfile 2>/dev/null || true; sudo shutdown -c 2>/dev/null; sudo shutdown -h +$minutes 'afterwrd scale test, $minutes-minute cap' && echo \"\$(hostname): swap \$(free -g | awk '/Swap/{print \$2}')G, off in $minutes minutes\""
    done
    trap - EXIT # each has its power-off time now
    "$0" push
    "$0" run "$mode" ;;
  log)
    need_list
    on "$(first)" "sudo tail -n ${LINES:-30} worker/test/scale/out/${2:?Which mode?}/run.log" ;;
  fetch)
    need_list
    mode="${2:?Which mode?}"
    mkdir -p "$STATE/$mode"
    on "$(first)" "sudo cat worker/test/scale/out/$mode.tgz" >"$STATE/$mode.tgz"
    tar xzf "$STATE/$mode.tgz" -C "$STATE/$mode"
    say "results in $STATE/$mode (report.md)" ;;
  sync)
    need_list
    mode="${2:?Which mode?}"
    every="${3:-10}"
    live="$STATE/$mode/live"
    mkdir -p "$live/machines"
    copy() { # copy <address> <files…> <to>: only what's new (logs only grow)
      h="$1"; to="$2"; shift 2
      rsync -a --append -e "ssh -i $KEY -o UserKnownHostsFile=$HOSTS -o BatchMode=yes -o ConnectTimeout=20" \
        $(for f in "$@"; do printf ' ubuntu@%s:worker/test/scale/out/%s' "$h" "$f"; done) "$to/" 2>/dev/null || true
    }
    while :; do
      copy "$(first)" "$live" stats.log resources.log net.json results "$mode/run.log"
      for h in $(publics); do
        if [ "$h" != "$(first)" ]; then mkdir -p "$live/machines/$h"; copy "$h" "$live/machines/$h" resources.log; fi
      done
      say "copied: $(du -sh "$live" | cut -f1) so far; $(tail -n 1 "$live/run.log" 2>/dev/null)"
      if grep -q "^== finished $mode" "$live/run.log" 2>/dev/null; then break; fi
      sleep $((every * 60))
    done ;;
  results)
    sos="$HOME/.config/afterwrd-scale/sos.env"
    if [ ! -s "$sos" ]; then echo "No results key ($sos)." >&2; exit 1; fi
    set -a; . "$sos"; set +a
    export EXOSCALE_ZONE="$ZONE"
    if [ -z "${2:-}" ]; then exo storage list sos://afterwrd-scale-results/; exit; fi
    to="$STATE/$2"
    mkdir -p "$to"
    exo -Q storage download -r -f "sos://afterwrd-scale-results/$2/" "$to/"
    (cd "$to" && tar xzf latest.tgz && if [ -s "$(ls -d *.tgz 2>/dev/null | grep -v latest | head -1)" ]; then tar xzf "$(ls *.tgz | grep -v latest | head -1)"; fi
      cat $(ls stats/stats.log.*.gz | sort) | gunzip >stats.log)
    say "results in $to ($(du -sh "$to" | cut -f1)); stats.log $(wc -l <"$to/stats.log") lines" ;;
  delete)
    # Every server of the test's, by name: also any a create that went wrong made without listing.
    for name in $( (awk '{print $1}' "$LIST" 2>/dev/null; ours) | sort -u); do exo -Q compute instance delete "$name" -z "$ZONE" -f >/dev/null & done
    wait
    exo -Q compute security-group delete "$GROUP" -f >/dev/null 2>&1 || true
    rm -f "$LIST"
    say "left on Exoscale:"
    exo -Q compute instance list -z "$ZONE" 2>&1
    exo -Q compute security-group list 2>&1
    exo -Q compute block-storage list -z "$ZONE" 2>&1 | head -5 ;;
  status)
    exo -Q compute instance list -z "$ZONE" 2>&1
    if [ -s "$LIST" ]; then cat "$LIST"; fi ;;
  *)
    echo "Usage: test/scale/exo.sh create|push|run|log|fetch|sync|results|delete|status" >&2; exit 1 ;;
esac
