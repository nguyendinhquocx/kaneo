import hashlib, json, subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
old_dir = root/".wave-uatfix7"
new_dir = root/".wave-int1"

OLD_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'
OLD_COMPOSE='5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f'
OLD_REV='d56f1bbae914269fdd3b322fae4cbea19528603c'
U7_WRAPPER='ea1640d65d05b5882b4190318e9dd4371b663bf5b8f7ce6e225a4ae81e98e820'
U7_SYNC='47bab1d8dcfe1ebf7db8fb34ad781eb18dca71d685e13091007f885210d6a083'
U7_MIG='bbb7952722d27216efd491239fef98410da6c7a17ff4dde49a49701a27f4f37b'
U7_BV='eea07a72b35202a61ddcf0eb2aee09facdc4c88a663d727bfd9645e11664c678'
U7_SN='e8798ba8f07ad19c08000396d06ea0a6fb1ac31efaaf0d2ebedadc908eb15f2a'
NEW_REV='d7c142498abadc303e802c4e61338b0b42ed71e3'
NEW_TAG='2.14.0-candidate-d7c14249-calendar-mindmap-int1'
NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:'+NEW_TAG+'@sha256:0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc'
NEW_DIGEST='0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc'
NEW_COMPOSE='70459206ff5117c81ddc74c01f0a73cfed75fad10b357af3ff2b1da01c8a3c25'
NEW_WRAPPER='8ce2b6b3d21dd59aa3325a59cc9eab038ed12d5e31d7cf13eb26d2e08cb1b2aa'
NEW_MIG='916a7627683478fb92979ec6b1d1a85bdfa6ef986e1a60ea18258d6432311513'
NEW_BV='d41cfdda6d8625ecfdf5d13dde44d682ad8bb60451964b204d949cb4a7a5f86f'
NEW_SN='0689423a81639bf47e44065b1efd86ff27a511aee52cceedc54023aec91c3342'
NEW_SY='e940762af40c8583e3c009ad57815439404cc909f0c192b75b37a076f6493ed4'

def rd(p): return Path(p).read_text(encoding="utf-8", newline="")
def wr(p, s): Path(p).write_bytes(s.encode("utf-8"))
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def replace1(s, old, new, label):
    n = s.count(old)
    assert n == 1, f"anchor not unique ({n}) for {label}"
    return s.replace(old, new)

# 1. deploy script from the canonical template
dep = rd(root/"app_presets" if False else old_dir/"deploy-kaneo-uatfix7.sh")
tpl = rd(root.parent/".." .replace("..", "..")/".." if False else Path("D:/pcloud/workspace/code/python/app_presets/home_server/projects/kaneo/infra/host/deploy-kaneo-release.sh"))
dep = replace1(tpl,
  "# Canonical Kaneo release deploy template \u2014 copy per wave, fill the pins.",
  f"# Canonical Kaneo release deploy template \u2014 int1 wave pins\n"
  f"# (SPEC-2026-10-31 calendar/mindmap embedded integrations @ {NEW_REV}).",
  "dep header")
dep = replace1(dep,
  "# Usage (root on ProDesk): sudo sh deploy-kaneo-release.sh",
  "# Usage (root on ProDesk): sudo sh deploy-kaneo-int1.sh",
  "dep usage")
dep = replace1(dep,
  "CURRENT_IMAGE=''   # e.g. ghcr.io/...:candidate-<prev>@sha256:<prev-digest>\n"
  "NEW_IMAGE=''       # e.g. ghcr.io/...:candidate-<wave>@sha256:<new-digest>\n"
  "NEW_SHA=''         # new manifest digest (no sha256: prefix)",
  f"CURRENT_IMAGE='{OLD_IMAGE}'\nNEW_IMAGE='{NEW_IMAGE}'\nNEW_SHA='{NEW_DIGEST}'",
  "dep pins")
wr(new_dir/"deploy-kaneo-int1.sh", dep)

# 2. wave-apply for int1
apply = rd(old_dir/"kaneo-wave-apply.sh")
apply = replace1(apply,
  "# Kaneo wave uatfix7 apply script. Run as root on ProDesk:\n#   sudo sh /home/quoc/kaneo-wave-uatfix7/kaneo-wave-apply.sh\n# Fail-closed: every host-state assumption is re-verified before any\n# mutation. Repins the backup wrapper + recovery adapters for the\n# uatfix6->uatfix7 pair, then deploys the SPEC-2026-10-27 post-UAT\n# revision (commit d56f1bba, migration 0051).",
  "# Kaneo wave int1 apply script. Run as root on ProDesk:\n#   sudo sh /home/quoc/kaneo-wave-int1/kaneo-wave-apply.sh\n# Fail-closed: every host-state assumption is re-verified before any\n# mutation. Repins the backup wrapper + recovery adapters for the\n# uatfix7->int1 pair, takes a fresh encrypted pre-migration snapshot\n# (mirrored to R2) of the uatfix7 release, then deploys the\n# SPEC-2026-10-31 calendar/mindmap integration revision (commit\n# " + NEW_REV + ", migration 0052_secret_maelstrom).",
  "apply header")
apply = replace1(apply, "BUNDLE=/home/quoc/kaneo-wave-uatfix7", "BUNDLE=/home/quoc/kaneo-wave-int1", "apply bundle")
apply = replace1(apply, "DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-uatfix7.sh", "DEPLOY_SCRIPT=$BUNDLE/deploy-kaneo-int1.sh", "apply deploy ref")
apply = replace1(apply,
  "CURRENT_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd'",
  f"CURRENT_IMAGE='{OLD_IMAGE}'", "apply current pin")
apply = replace1(apply,
  "NEW_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'",
  f"NEW_IMAGE='{NEW_IMAGE}'", "apply new pin")
apply = replace1(apply,
  "CURRENT_COMPOSE_SHA256=1e637fa348ddc6d4d53f7d4ff0c0f082ffbd06002218848281ac1c6d88a2e717",
  f"CURRENT_COMPOSE_SHA256={OLD_COMPOSE}", "apply current compose")
apply = replace1(apply,
  f"NEW_WRAPPER_SHA256={U7_WRAPPER}", f"NEW_WRAPPER_SHA256={NEW_WRAPPER}", "apply wrapper pin")
apply = replace1(apply,
  f"NEW_SYNC_SHA256={U7_SYNC}", f"NEW_SYNC_SHA256={NEW_SY}", "apply sync pin")
apply = replace1(apply,
  f"NEW_MIGRATION_SHA256={U7_MIG}", f"NEW_MIGRATION_SHA256={NEW_MIG}", "apply migration pin")
apply = replace1(apply,
  f"NEW_BACKUP_VERIFY_SHA256={U7_BV}", f"NEW_BACKUP_VERIFY_SHA256={NEW_BV}", "apply backup-verify pin")
apply = replace1(apply,
  f"NEW_SNAPSHOT_ADAPTER_SHA256={U7_SN}", f"NEW_SNAPSHOT_ADAPTER_SHA256={NEW_SN}", "apply snapshot pin")
apply = replace1(apply,
  "OLD_WRAPPER_SHA256=e01c070fdfea2f41e39102ee99528bba99771b2aeb45bbadddb2044f659348da", f"OLD_WRAPPER_SHA256={U7_WRAPPER}", "apply old wrapper")
apply = replace1(apply,
  "OLD_SYNC_SHA256=5b1ef1d7d2117ea616eb1dc0185484f7f4bf88df69a4448fa769a56529bf11aa", f"OLD_SYNC_SHA256={U7_SYNC}", "apply old sync")
apply = replace1(apply,
  "OLD_MIGRATION_SHA256=e3cc654f405aeb5935850737e3d3058300b23740f6f6ec0a0461a0bc2d8d34d1", f"OLD_MIGRATION_SHA256={U7_MIG}", "apply old migration")
apply = replace1(apply,
  "OLD_BACKUP_VERIFY_SHA256=caab1488157c9f5e40760267688571b584e16ead86dcb998e4740a81549eb450", f"OLD_BACKUP_VERIFY_SHA256={U7_BV}", "apply old backup-verify")
apply = replace1(apply,
  "OLD_SNAPSHOT_ADAPTER_SHA256=19af4e180e081835b71a36c1f712ddca15bce2ca643eb86a6bfdb55a1a3c78f5", f"OLD_SNAPSHOT_ADAPTER_SHA256={U7_SN}", "apply old snapshot")
apply = replace1(apply,
  "[ \"$sha_state\" = 'dca547b03e876106f709ce7c3cd7d484e2043986' ] || fail 'install metadata source revision is not the surveyed previous candidate'",
  f"[ \"$sha_state\" = '{OLD_REV}' ] || fail 'install metadata source revision is not the surveyed previous candidate'",
  "apply metadata pin")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 2/9 verify candidate bundle integrity\'', 
  'printf \'%s\\n\' \'== 2/11 verify candidate bundle integrity\'', "apply step2 label")
apply = replace1(apply,
  '[ "$(sha256sum "$BUNDLE/backup-kaneo.uatfix7.sh" | awk \'{print $1}\')" = "$NEW_WRAPPER_SHA256" ] || fail \'bundle wrapper hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/sync.uatfix7.sh" | awk \'{print $1}\')" = "$NEW_SYNC_SHA256" ] || fail \'bundle sync-metadata hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/migration-verify.uatfix7.sh" | awk \'{print $1}\')" = "$NEW_MIGRATION_SHA256" ] || fail \'bundle migration-verify hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/backup-verify.uatfix7.sh" | awk \'{print $1}\')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail \'bundle backup-verify hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/snapshot.uatfix7.sh" | awk \'{print $1}\')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail \'bundle snapshot adapter hash mismatch\'',
  '[ "$(sha256sum "$BUNDLE/backup-kaneo.int1.sh" | awk \'{print $1}\')" = "$NEW_WRAPPER_SHA256" ] || fail \'bundle wrapper hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/sync.int1.sh" | awk \'{print $1}\')" = "$NEW_SYNC_SHA256" ] || fail \'bundle sync-metadata hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/migration-verify.int1.sh" | awk \'{print $1}\')" = "$NEW_MIGRATION_SHA256" ] || fail \'bundle migration-verify hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/backup-verify.int1.sh" | awk \'{print $1}\')" = "$NEW_BACKUP_VERIFY_SHA256" ] || fail \'bundle backup-verify hash mismatch\'\n'
  '[ "$(sha256sum "$BUNDLE/snapshot.int1.sh" | awk \'{print $1}\')" = "$NEW_SNAPSHOT_ADAPTER_SHA256" ] || fail \'bundle snapshot adapter hash mismatch\'',
  "apply integrity checks")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 3/9 stage repinned wrapper + recovery adapters (atomic, runtime unchanged)\'',
  'printf \'%s\\n\' \'== 3/11 stage repinned wrapper + recovery adapters (atomic, runtime unchanged)\'', "apply step3 label")
apply = replace1(apply,
  'install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.uatfix7.sh" "$WRAPPER_TARGET"\n'
  'install -o root -g root -m 0555 "$BUNDLE/migration-verify.uatfix7.sh" "$MIGRATION_TARGET"\n'
  'install -o root -g root -m 0555 "$BUNDLE/sync.uatfix7.sh" "$SYNC_TARGET"\n'
  'install -o root -g root -m 0555 "$BUNDLE/snapshot.uatfix7.sh" "$SNAPSHOT_ADAPTER"\n'
  'install -o root -g root -m 0555 "$BUNDLE/backup-verify.uatfix7.sh" "$BACKUP_VERIFY_TARGET"',
  'install -o root -g root -m 0555 "$BUNDLE/backup-kaneo.int1.sh" "$WRAPPER_TARGET"\n'
  'install -o root -g root -m 0555 "$BUNDLE/migration-verify.int1.sh" "$MIGRATION_TARGET"\n'
  'install -o root -g root -m 0555 "$BUNDLE/sync.int1.sh" "$SYNC_TARGET"\n'
  'install -o root -g root -m 0555 "$BUNDLE/snapshot.int1.sh" "$SNAPSHOT_ADAPTER"\n'
  'install -o root -g root -m 0555 "$BUNDLE/backup-verify.int1.sh" "$BACKUP_VERIFY_TARGET"',
  "apply staging")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 4/9 guarded deploy (backup guard, compose flip, pull, health, migration)\'\nsh "$DEPLOY_SCRIPT"',
  'printf \'%s\\n\' \'== 4/11 fresh encrypted pre-migration snapshot of the CURRENT uatfix7 release\'\n'
  'pre_snapshot_output=$(sh "$WRAPPER_TARGET" --snapshot --yes)\n'
  'printf \'%s\\n\' "$pre_snapshot_output"\n'
  'pre_backup_id=$(printf \'%s\\n\' "$pre_snapshot_output" | grep -oE \'kaneo-[0-9]{8}T[0-9]{6}Z\' | tail -n 1)\n'
  '[ -n "$pre_backup_id" ] || fail \'could not determine the pre-migration backup id from snapshot output\'\n'
  '\n'
  'printf \'%s\\n\' \'== 5/11 mirror the pre-migration pair to the private R2 backup bucket\'\n'
  'sh "$MIRROR_SCRIPT" --mirror --yes --backup-id "$pre_backup_id"\n'
  '\n'
  'printf \'%s\\n\' \'== 6/11 guarded deploy (backup guard, compose flip, pull, health, migration 0052)\'\n'
  'sh "$DEPLOY_SCRIPT"',
  "apply pre-migration snapshot + deploy")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 5/9 rebind recovery metadata to the new wave\'\nsh "$SYNC_TARGET"',
  'printf \'%s\\n\' \'== 7/11 rebind recovery metadata to the new wave\'\nsh "$SYNC_TARGET"', "apply step rebind")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 6/9 read-only post-deploy checks\'',
  'printf \'%s\\n\' \'== 8/11 read-only post-deploy checks\'', "apply step checks label")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 7/9 fresh encrypted snapshot of the new release\'',
  'printf \'%s\\n\' \'== 9/11 fresh encrypted snapshot of the new release\'', "apply step snapshot label")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 8/9 mirror the fresh pair to the private R2 backup bucket\'',
  'printf \'%s\\n\' \'== 10/11 mirror the fresh pair to the private R2 backup bucket\'', "apply step mirror label")
apply = replace1(apply,
  'printf \'%s\\n\' \'== 9/9 wave receipt\'\n'
  'printf \'%s\\n\' "KANEO WAVE APPLY PASS: uatfix7"',
  'printf \'%s\\n\' \'== 11/11 wave receipt\'\n'
  'printf \'%s\\n\' "KANEO WAVE APPLY PASS: int1"', "apply receipt label")
apply = replace1(apply,
  'printf \'%s\\n\' "backup_id=$backup_id"',
  'printf \'%s\\n\' "pre_migration_backup_id=$pre_backup_id"\nprintf \'%s\\n\' "backup_id=$backup_id"', "apply receipt backups")
wr(new_dir/"kaneo-wave-apply.sh", apply)

# 3. stage-verify.sh for int1 backup-verify
sv = rd(old_dir/"stage-verify.sh")
sv = sv.replace("uatfix7", "int1")
sv = replace1(sv, f"EXPECTED_SRC_SHA256={U7_BV}", f"EXPECTED_SRC_SHA256={NEW_BV}", "sv hash")
sv = sv.replace("/home/quoc/kaneo-wave-int1/backup-verify.int1.sh", "/home/quoc/kaneo-wave-int1/backup-verify.int1.sh")
wr(new_dir/"stage-verify.sh", sv)

# 4. .pins.json
pins = {
  "CURRENT_IMAGE": OLD_IMAGE,
  "NEW_IMAGE": NEW_IMAGE,
  "CURRENT_COMPOSE_SHA256": OLD_COMPOSE,
  "NEW_COMPOSE_SHA256": NEW_COMPOSE,
  "CURRENT_SOURCE_REVISION": OLD_REV,
  "SOURCE_REVISION": NEW_REV,
  "WRAPPER_SHA256": NEW_WRAPPER,
  "SYNC_SHA256": NEW_SY,
  "MIGRATION_SHA256": NEW_MIG,
  "BACKUP_VERIFY_SHA256": NEW_BV,
  "SNAPSHOT_ADAPTER_SHA256": NEW_SN,
  "MIGRATION_HEAD_EXPECTED": {"id": 55, "count": 55, "hash": "f8f8a5bd7a6f547285b27f57b960dde03576dc936293303d931a823002277f9d"},
}
wr(new_dir/".pins.json", json.dumps(pins, indent=2) + "\n")

# 5. CANDIDATE-PROVENANCE.json
delta = subprocess.run(["git","diff","d56f1bbae914269fdd3b322fae4cbea19528603c",NEW_REV],
                       capture_output=True,check=True,cwd=root).stdout.decode("utf-8", "surrogateescape")
delta_sha = hashlib.sha256(delta.encode("utf-8", "surrogateescape")).hexdigest()
files = subprocess.run(["git","diff","--name-only","d56f1bbae914269fdd3b322fae4cbea19528603c",NEW_REV],
                       capture_output=True,check=True,cwd=root).stdout.decode("utf-8").split()
prov = {
  "schema_version": 2,
  "spec": "SPEC-2026-10-31 kaneo calendar/mindmap embedded integrations (direct production UAT)",
  "source_sha": NEW_REV,
  "upstream_sha": NEW_REV,
  "base_source_sha": OLD_REV,
  "dirty_state": "clean-tracked",
  "dirty_paths": [],
  "dirty_manifest_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "delta_manifest_sha256": delta_sha,
  "delta_manifest_note": "sha256 of git diff base_source_sha..source_sha; replaces the unreproducible patch_manifest/output_tree fields of schema v1",
  "committed_files": sorted(files),
}
wr(new_dir/"CANDIDATE-PROVENANCE.json", json.dumps(prov, indent=2) + "\n")

for f in ["deploy-kaneo-int1.sh","kaneo-wave-apply.sh","stage-verify.sh"]:
    print(f, sha(new_dir/f))
print("files:", sorted(p.name for p in new_dir.iterdir()))
