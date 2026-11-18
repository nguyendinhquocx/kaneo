#!/bin/sh
# Finish the glanceable deploy: install new migration-verify pins, run it,
# post-flip backup guard, post-apply snapshot, final state. Run: sudo sh run-finish.sh
set -eu
exec >> /tmp/kaneo-deploy-glanceable/run.log 2>&1

BUNDLE=/tmp/kaneo-deploy-glanceable

printf '%s\n' '== 9/8 install + run migration/schema verifier (glanceable pins)'
install -o root -g root -m 0555 "$BUNDLE/kaneo-migration-verify.next" /usr/local/lib/home-server-recovery/kaneo-migration-verify
/usr/local/lib/home-server-recovery/kaneo-migration-verify

printf '%s\n' '== 10/8 backup wrapper --plan (NEW release pair)'
/srv/kaneo/recovery/backup-kaneo.sh --plan

printf '%s\n' '== 11/8 post-apply encrypted snapshot'
/srv/kaneo/recovery/backup-kaneo.sh --snapshot --yes

printf '%s\n' '== 12/8 final state'
docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep '^kaneo|'
grep -n "image: ghcr.io" /srv/kaneo/compose.yml
printf '%s\n' 'KANEO DEPLOY COMPLETE'
