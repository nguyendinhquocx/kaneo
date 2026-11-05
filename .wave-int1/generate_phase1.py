import hashlib, json, subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
old_dir = root/".wave-uatfix7"
new_dir = root/".wave-int1"
new_dir.mkdir(exist_ok=True)

OLD_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'
OLD_PREV_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd'
OLD_COMPOSE='5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f'
OLD_REV='d56f1bbae914269fdd3b322fae4cbea19528603c'
NEW_DIGEST='0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc'
NEW_REV=subprocess.run(["git","rev-parse","HEAD"],capture_output=True,text=True,check=True,cwd=root).stdout.strip()
SHORT=NEW_REV[:8]
NEW_TAG=f'2.14.0-candidate-{SHORT}-calendar-mindmap-int1'
NEW_IMAGE=f'ghcr.io/nguyendinhquocx/kaneo-vi-mcp:{NEW_TAG}@sha256:{NEW_DIGEST}'

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def rd(p): return Path(p).read_text(encoding="utf-8", newline="")
def wr(p, s): Path(p).write_bytes(s.encode("utf-8"))
def replace1(s, old, new, label):
    n = s.count(old)
    assert n == 1, f"anchor not unique ({n}) for {label}"
    return s.replace(old, new)

# 1. compose
compose = rd(old_dir/"compose.uatfix7.yml").replace(OLD_IMAGE, NEW_IMAGE)
assert OLD_IMAGE not in compose and NEW_IMAGE in compose
wr(new_dir/"compose.int1.yml", compose)
NEW_COMPOSE = sha(new_dir/"compose.int1.yml")

# 2. backup wrapper pair pins
wrapper = rd(old_dir/"backup-kaneo.uatfix7.sh")
wrapper = replace1(wrapper,
  "PREVIOUS_COMPOSE_SHA256=1e637fa348ddc6d4d53f7d4ff0c0f082ffbd06002218848281ac1c6d88a2e717\n"
  f"PREVIOUS_IMAGE_REF='{OLD_PREV_IMAGE}'\n"
  f"CANDIDATE_COMPOSE_SHA256={OLD_COMPOSE}\n"
  f"CANDIDATE_IMAGE_REF='{OLD_IMAGE}'",
  f"PREVIOUS_COMPOSE_SHA256={OLD_COMPOSE}\n"
  f"PREVIOUS_IMAGE_REF='{OLD_IMAGE}'\n"
  f"CANDIDATE_COMPOSE_SHA256={NEW_COMPOSE}\n"
  f"CANDIDATE_IMAGE_REF='{NEW_IMAGE}'",
  "wrapper pair pins")
wr(new_dir/"backup-kaneo.int1.sh", wrapper)
NEW_WRAPPER = sha(new_dir/"backup-kaneo.int1.sh")

# 3. migration-verify
mig = rd(old_dir/"migration-verify.uatfix7.sh")
mig = mig.replace(
  "# Fixed read-only Kaneo migration-head and schema verifier \u2014 uatfix7 wave pins.",
  "# Fixed read-only Kaneo migration-head and schema verifier \u2014 int1 wave pins.")
mig = replace1(mig, f"EXPECTED_COMPOSE_SHA256={OLD_COMPOSE}", f"EXPECTED_COMPOSE_SHA256={NEW_COMPOSE}", "mig compose")
mig = replace1(mig, f"EXPECTED_IMAGE='{OLD_IMAGE}'", f"EXPECTED_IMAGE='{NEW_IMAGE}'", "mig image")
mig = replace1(mig, "EXPECTED_HEAD_ID=54", "EXPECTED_HEAD_ID=55", "mig head id")
mig = replace1(mig, "EXPECTED_HEAD_HASH=73246bf88aefd1634df1df1312489cf0b2aa89899efe5cd5345d75f4cd66a2f4",
                   "EXPECTED_HEAD_HASH=f8f8a5bd7a6f547285b27f57b960dde03576dc936293303d931a823002277f9d", "mig head hash")
mig = replace1(mig, "EXPECTED_MIGRATION_COUNT=54", "EXPECTED_MIGRATION_COUNT=55", "mig count")
mig = replace1(mig, "EXPECTED_REQUIRED_COLUMNS=27", "EXPECTED_REQUIRED_COLUMNS=32", "mig columns")
mig = replace1(mig,
  "('project','show_priority_by_default')) SELECT count(*)::text",
  "('project','show_priority_by_default'),"
  "('workspace_integration_settings','workspace_id'),"
  "('workspace_integration_settings','mitra_enabled'),"
  "('workspace_integration_settings','wisemapping_enabled'),"
  "('workspace_integration_settings','created_at'),"
  "('workspace_integration_settings','updated_at')) SELECT count(*)::text",
  "mig column VALUES")
fk_block = (
  'required_integration_fk=$(run_sql "SELECT count(*)::text FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid '
  "WHERE t.relname='workspace_integration_settings' AND c.contype='f' "
  "AND c.conname='workspace_integration_settings_workspace_id_workspace_id_fk';\") || fail 'could not inspect workspace integration FK'\n"
  '[ "$required_integration_fk" = "1" ] || fail "workspace integration FK present: $required_integration_fk/1"\n'
)
mig = replace1(mig,
  '[ "$required_constraints" = "$EXPECTED_REQUIRED_CONSTRAINTS" ] || fail "GitHub compatibility constraints present: $required_constraints/$EXPECTED_REQUIRED_CONSTRAINTS"\n',
  '[ "$required_constraints" = "$EXPECTED_REQUIRED_CONSTRAINTS" ] || fail "GitHub compatibility constraints present: $required_constraints/$EXPECTED_REQUIRED_CONSTRAINTS"\n'
  + fk_block,
  "mig fk insert")
mig = replace1(mig,
  "head=0051_fuzzy_harry_osborn id=$head_id migrations=$migration_count hash=$head_hash required_columns=$required_columns/$EXPECTED_REQUIRED_COLUMNS github_constraints=$required_constraints/$EXPECTED_REQUIRED_CONSTRAINTS backfill_gaps=$backfill_gaps",
  "head=0052_secret_maelstrom id=$head_id migrations=$migration_count hash=$head_hash required_columns=$required_columns/$EXPECTED_REQUIRED_COLUMNS github_constraints=$required_constraints/$EXPECTED_REQUIRED_CONSTRAINTS integration_fk=$required_integration_fk backfill_gaps=$backfill_gaps",
  "mig pass line")
wr(new_dir/"migration-verify.int1.sh", mig)
NEW_MIG = sha(new_dir/"migration-verify.int1.sh")

# 4. backup-verify — append INT1 identity
U7_WRAPPER = "ea1640d65d05b5882b4190318e9dd4371b663bf5b8f7ce6e225a4ae81e98e820"
bv = rd(old_dir/"backup-verify.uatfix7.sh")
bv = replace1(bv,
  f"UATFIX7_CANDIDATE_COMPOSE_SHA256={OLD_COMPOSE}\nUATFIX7_CANDIDATE_IMAGE='{OLD_IMAGE}'\n",
  f"UATFIX7_CANDIDATE_COMPOSE_SHA256={OLD_COMPOSE}\nUATFIX7_CANDIDATE_IMAGE='{OLD_IMAGE}'\n"
  f"INT1_CANDIDATE_COMPOSE_SHA256={NEW_COMPOSE}\nINT1_CANDIDATE_IMAGE='{NEW_IMAGE}'\n",
  "bv pin block")
bv = replace1(bv,
  '"$UATFIX7_CANDIDATE_COMPOSE_SHA256" "$UATFIX7_CANDIDATE_IMAGE" ' + "<<'PY'",
  '"$UATFIX7_CANDIDATE_COMPOSE_SHA256" "$UATFIX7_CANDIDATE_IMAGE" "$INT1_CANDIDATE_COMPOSE_SHA256" "$INT1_CANDIDATE_IMAGE" ' + "<<'PY'",
  "bv argv")
bv = replace1(bv,
  "uatfix7_compose, uatfix7_image = sys.argv[1:]",
  "uatfix7_compose, uatfix7_image, int1_compose, int1_image = sys.argv[1:]",
  "bv params")
bv = replace1(bv,
  "(uatfix7_compose, uatfix7_image)}:",
  "(uatfix7_compose, uatfix7_image), (int1_compose, int1_image)}:",
  "bv identity set")
wr(new_dir/"backup-verify.int1.sh", bv)
NEW_BV = sha(new_dir/"backup-verify.int1.sh")

# 5. snapshot — append INT1 pins + case line
sn = rd(old_dir/"snapshot.uatfix7.sh")
sn = replace1(sn,
  f"UATFIX7_CANDIDATE_BACKUP_SHA256={U7_WRAPPER}\nUATFIX7_CANDIDATE_COMPOSE_SHA256={OLD_COMPOSE}\nUATFIX7_CANDIDATE_IMAGE='{OLD_IMAGE}'\n",
  f"UATFIX7_CANDIDATE_BACKUP_SHA256={U7_WRAPPER}\nUATFIX7_CANDIDATE_COMPOSE_SHA256={OLD_COMPOSE}\nUATFIX7_CANDIDATE_IMAGE='{OLD_IMAGE}'\n"
  f"INT1_CANDIDATE_BACKUP_SHA256={NEW_WRAPPER}\nINT1_CANDIDATE_COMPOSE_SHA256={NEW_COMPOSE}\nINT1_CANDIDATE_IMAGE='{NEW_IMAGE}'\n",
  "sn pin block")
sn = replace1(sn,
  '    "$UATFIX7_CANDIDATE_BACKUP_SHA256") expected_compose=$UATFIX7_CANDIDATE_COMPOSE_SHA256; expected_image=$UATFIX7_CANDIDATE_IMAGE ;;',
  '    "$UATFIX7_CANDIDATE_BACKUP_SHA256") expected_compose=$UATFIX7_CANDIDATE_COMPOSE_SHA256; expected_image=$UATFIX7_CANDIDATE_IMAGE ;;\n'
  '    "$INT1_CANDIDATE_BACKUP_SHA256") expected_compose=$INT1_CANDIDATE_COMPOSE_SHA256; expected_image=$INT1_CANDIDATE_IMAGE ;;',
  "sn case line")
wr(new_dir/"snapshot.int1.sh", sn)
NEW_SN = sha(new_dir/"snapshot.int1.sh")

# 6. sync-metadata
sy = rd(old_dir/"sync.uatfix7.sh")
sy = replace1(sy, f"EXPECTED_SOURCE_REVISION={OLD_REV}", f"EXPECTED_SOURCE_REVISION={NEW_REV}", "sy rev")
sy = replace1(sy, f"EXPECTED_COMPOSE_SHA256={OLD_COMPOSE}", f"EXPECTED_COMPOSE_SHA256={NEW_COMPOSE}", "sy compose")
sy = replace1(sy, f"EXPECTED_IMAGE='{OLD_IMAGE}'", f"EXPECTED_IMAGE='{NEW_IMAGE}'", "sy image")
sy = replace1(sy, f"EXPECTED_PREVIOUS_IMAGE='{OLD_PREV_IMAGE}'", f"EXPECTED_PREVIOUS_IMAGE='{OLD_IMAGE}'", "sy prev")
sy = replace1(sy, f"EXPECTED_BACKUP_WRAPPER_SHA256={U7_WRAPPER}", f"EXPECTED_BACKUP_WRAPPER_SHA256={NEW_WRAPPER}", "sy wrapper")
wr(new_dir/"sync.int1.sh", sy)
NEW_SY = sha(new_dir/"sync.int1.sh")

print(json.dumps({
  "new_rev": NEW_REV, "new_tag": NEW_TAG, "new_image": NEW_IMAGE,
  "new_compose": NEW_COMPOSE, "new_wrapper": NEW_WRAPPER, "new_migration": NEW_MIG,
  "new_backup_verify": NEW_BV, "new_snapshot": NEW_SN, "new_sync": NEW_SY,
}, indent=1))
