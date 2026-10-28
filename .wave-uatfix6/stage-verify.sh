#!/bin/sh
# Stage the repinned uatfix6 backup-verify adapter, then verify immediately.
# Usage: ssh -t prodesk-home sudo sh /home/quoc/kaneo-wave-uatfix6/stage-verify.sh
set -eu

SRC=/home/quoc/kaneo-wave-uatfix6/backup-verify.uatfix6.sh
DST=/usr/local/lib/home-server-recovery/kaneo-backup-verify
EXPECTED_SRC_SHA256=caab1488157c9f5e40760267688571b584e16ead86dcb998e4740a81549eb450

fail() { printf '%s\n' "STAGE BLOCKED: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || fail 'run via sudo'
[ "$(sha256sum "$SRC" | awk '{print $1}')" = "$EXPECTED_SRC_SHA256" ] || fail 'bundle hash mismatch'
install -o root -g root -m 0555 "$SRC" "$DST"
printf '%s\n' "staged $(sha256sum "$DST" | awk '{print $1}')"
sh "$DST"
