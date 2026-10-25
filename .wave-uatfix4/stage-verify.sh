#!/bin/sh
# Stage the repinned uatfix4 backup-verify adapter, then verify immediately.
# Usage: ssh -t prodesk-home sudo sh /home/quoc/kaneo-wave-uatfix4/stage-verify.sh
set -eu

SRC=/home/quoc/kaneo-wave-uatfix4/backup-verify.uatfix4.sh
DST=/usr/local/lib/home-server-recovery/kaneo-backup-verify
EXPECTED_SRC_SHA256=3db9cd065cfd6b25cf33fb03d98fe8fe06fa2d561064e25e1fd439f5603de642

fail() { printf '%s\n' "STAGE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run via sudo'
[ "$(sha256sum "$SRC" | awk '{print $1}')" = "$EXPECTED_SRC_SHA256" ] || fail 'bundle hash mismatch'
install -o root -g root -m 0555 "$SRC" "$DST"
printf '%s\n' "staged $(sha256sum "$DST" | awk '{print $1}')"
sh "$DST"
