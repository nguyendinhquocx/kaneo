#!/bin/sh
# Stage the repinned int1 backup-verify adapter, then verify immediately.
# Usage: ssh -t prodesk-home sudo sh /home/quoc/kaneo-wave-int1/stage-verify.sh
set -eu

SRC=/home/quoc/kaneo-wave-int1/backup-verify.int1.sh
DST=/usr/local/lib/home-server-recovery/kaneo-backup-verify
EXPECTED_SRC_SHA256=d41cfdda6d8625ecfdf5d13dde44d682ad8bb60451964b204d949cb4a7a5f86f

fail() { printf '%s\n' "STAGE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run via sudo'
[ "$(sha256sum "$SRC" | awk '{print $1}')" = "$EXPECTED_SRC_SHA256" ] || fail 'bundle hash mismatch'
install -o root -g root -m 0555 "$SRC" "$DST"
printf '%s\n' "staged $(sha256sum "$DST" | awk '{print $1}')"
sh "$DST"
