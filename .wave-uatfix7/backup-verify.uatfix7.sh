#!/bin/sh
# Verify the newest encrypted Kaneo production backup without decrypting it.
# Acceptable source identity is baseline before activation or candidate after activation.
# Owner-approved 2026-10-28: the latest receipt must also pass a 30-day
# freshness gate (MAX_BACKUP_AGE_SECONDS) so stale backups fail closed.
set -eu

[ "$#" -eq 0 ] || { printf '%s\n' 'Usage: kaneo-backup-verify' >&2; exit 2; }
OUTBOX_ROOT=/var/lib/home-server-recovery/kaneo-outbox
VERIFIER=/usr/local/lib/home-server-recovery/kaneo-verify-backup.py
EXPECTED_VERIFIER_SHA256=d6c27751cc7964317bbbe7e81ce5a81625e616ac3e638dcdf0566083aad6beaf
BASELINE_COMPOSE_SHA256=51c4db490a0b2c8a3af63e36bac3b6c63cb8794ad9c574d4e940950236f82e70
BASELINE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.9.10-r2-url-split@sha256:f57a99b10cf02c3a3a7865b4e7b70d5b3fa96c742e42c47839b7f35d59d3d1b5'
PREVIOUS_CANDIDATE_COMPOSE_SHA256=8584f76e033f4820093470b801fdc3833972c37ada224b91d27acecf4baa6263
PREVIOUS_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-e4c38b85-icon-r2@sha256:5e06e3dc69da3b6dbc702d5271fc7819cbde5d18872fc0a4636811bc93e529c6'
CANDIDATE_COMPOSE_SHA256=38eac3f7085f05d332b7adf818fad54a0c90794f4ea21b987ba340345c651add
CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-34f1a4aa-ui-r4@sha256:536ef5a4b40d2981483a9255303bbff40f526e7455ec69b6d629dda0db1c3fa1'
PRE_REPAIR_CANDIDATE_COMPOSE_SHA256=27f8cc2f151bb28b35d3e94dd8ba66943b525c315b5d6bad8681e8167ec66eea
PRE_REPAIR_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-723d44dc-execution-mvp-a@sha256:66b780d52c28766a9ef07c312e81fd7ccb71b6c5d870433d74995c6278e5125b'
PREVIOUS_CURRENT_CANDIDATE_COMPOSE_SHA256=aa9d2f5e5d0c60ed06fe9ec1e70f9e2eea8bde74f6183a826ed04c52b9e7fca0
PREVIOUS_CURRENT_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-schema-repair-2a9cd25c@sha256:60f9382e71ecd8a0a75d664862128604cceec923aa19d520efb87a6c9fd297da'
CURRENT_CANDIDATE_COMPOSE_SHA256=778200956043efdcf02f74fd551af1b17568801c38ea2292468e440f343b68b1
CURRENT_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-schema-repair-10818365@sha256:4bf0eeaba5434b44da22421d0fee6777483e4e126112a84d3c3a9623f90f891a'
FOLLOWUP_CANDIDATE_COMPOSE_SHA256=1fbd49ce7279bbb06e1b2883a0af3005c927b829c9efb1b3724240b710620974
FOLLOWUP_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-schema-repair-a269c9b7@sha256:5475120091a2be854a6ecb511bd8e7ba3c22f094fba8095b8f25c134224552f6'
NEXT_CANDIDATE_COMPOSE_SHA256=5a29f30fb74f2c707029310f4edfc66fbe4b5d9760444ba2d09886fe6c2bb678
NEXT_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-5b36efc1-task6-r5@sha256:484111ed6abf3be64f81139a7a69923b657fb6794a7ec979f968fd746bb2437c'
VERSION_FIX_CANDIDATE_COMPOSE_SHA256=966b00ab12ff95a0d9804daa917fb236e56320644c00836c2b994500c47cefa2
VERSION_FIX_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-f5e8fa3e-version-fix@sha256:bf18a91c88b1cedc97fa599b8b9f06d7bc3cd51a4dbe607df9e1cff453ee5849'
EXECUTION_FLAGS_CANDIDATE_COMPOSE_SHA256=6b8e11b91894a3f8524afb2e7407b27e3e7b1bd6138610f40c291c7542bd6805
EXECUTION_FLAGS_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-eba7837d-execution-flags-off@sha256:7cc2aa7de1b1d6e061e83115195c4831ab3f6d788a57b431f91ca2ca4fd15140'
EXECUTION_SCHEMA_REPAIR_CANDIDATE_COMPOSE_SHA256=6949d3acf92142e0dee1a4848e7c885eed0b417558832dac5ba2914f49930bc6
EXECUTION_SCHEMA_REPAIR_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-f6a74023-envelope-state-r1@sha256:57c715d9a3a8eff5233212a0c28e371accee00ce77b29fe229313a934aa76af0'
NATIVE_CONTROL_CANDIDATE_COMPOSE_SHA256=09132be8ab49760e0f6c9bbdb45ee52f5dfeb6ef326aea20126dd8ba39c3bab4
NATIVE_CONTROL_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-80790e0b-native-telegram-control-r1@sha256:033809fac2eac452a9bacb8d1e7d8d816668a4c8a9612beb7de569151a5e6e5a'
AUTH_SCOPE_CANDIDATE_COMPOSE_SHA256=3b155c7879175cdb6736c485ba7ac82d7eef6f2214dc50fc801fd66c81edc679
AUTH_SCOPE_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d14fd45a-native-telegram-auth-r1@sha256:be493ca805f0857c292609146e733bef52d57494c62bfa745cf8c00383acbac6'
SUPERVISOR_AUTH_CANDIDATE_COMPOSE_SHA256=fbb3e447b2c073ef58676dbfe260fbe45d6f3a37b01454555b4f6cb97406ae1b
SUPERVISOR_AUTH_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-3b0a3d77-supervisor-auth-r1@sha256:0c4801c4d6b59451c8dd2374183a76efe54f24dfb114726c8c865d97df38e4e4'
SUPERVISOR_PRINCIPAL_CANDIDATE_COMPOSE_SHA256=0e9639d3741da45b8d40bf47aee0aeb8a57fd3a7570bc5ce8f3f574b9358097a
SUPERVISOR_PRINCIPAL_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09bb6464-supervisor-principal-r1@sha256:95fc0fb43b44f874e893e12d913db160ff3e86eb67a9c9fede7b6b6fd5cd0617'
SUPERVISOR_TERMINAL_GUARD_CANDIDATE_COMPOSE_SHA256=021a7626006902db221d4cbcbb0d8bf8cefc5dd37847c206eff82e7880d38c77
SUPERVISOR_TERMINAL_GUARD_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-40f75dc0-supervisor-terminal-guard-r1@sha256:7b08c804acf3f33d98fca80c3de15a0ee881ee5dbff83242ff8f0b6440cb906e'
CONTROL_ACTOR_CANDIDATE_COMPOSE_SHA256=19cde538b89c9f6f89823cb97f3310b33e2dab487abff0c4846a008d4276dcb7
CONTROL_ACTOR_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-bf90bb71-control-actor-r1@sha256:d1c8254fb2423b199cb5454d510dbe6e2f10ac72f31817043b9e8be15df11d87'
RETRY_BUDGET_CANDIDATE_COMPOSE_SHA256=29b2dfdb7e5451930f7972bfc9d1756775c445bd16fb67972494b96d50b57a8c
RETRY_BUDGET_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-458e77dc-retry-budget-r1@sha256:9ee94f1f63def9b61e4fd3023f7468da3d557bef45a9514ddbdcc7d567390019'
RESUME_LINEAGE_CANDIDATE_COMPOSE_SHA256=86d9dca9876ecc4a3f62c988c537e81090e535f1db9aebeead85c7132555d3e0
RESUME_LINEAGE_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7b4eb9d0-resume-lineage-r1@sha256:82a417e2382584ed869bb2121de0ec8558f59fec557288dfb3100342bb0d0c68'
RESUME_DISPATCH_CANDIDATE_COMPOSE_SHA256=506cf755da0f20866672c790bd9eb1730807124666db789bd2e13bb5129a142d
RESUME_DISPATCH_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b46f91d0-resume-dispatch-r1@sha256:1f8c575d5207a81a973c7571af31b728a0035b55a5d3b56ea1eb9a7276fbd9a1'
RESUME_DISPATCH_R2_CANDIDATE_COMPOSE_SHA256=38a8658f3f3433dd41dd4f5c01983a3523f6f6255a847dac23e29da3af7191f7
RESUME_DISPATCH_R2_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b5427cbb-resume-dispatch-r2@sha256:6413f52426dc97584ca0234ebf1270963f13ece0b0f3095340977c33a8a36bc1'
RESUME_BRANCH_CANDIDATE_COMPOSE_SHA256=d3f1207a73d223b2cd96234c7024f5d3680e2b82a7a77e6d2cbb2466a24d7b04
RESUME_BRANCH_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-6a078800-resume-branch-r3@sha256:8ad3cdf41cc3012dc8d78bccb3a65b13130e55c546c4c7d3f5f32f5fbca0e05a'
KANBAN_NOTIFY_CANDIDATE_COMPOSE_SHA256=e8e8cebafdc61dc5e27ae7c9b9c9ad64b0ae776cb2f339671741548a60495b1b
KANBAN_NOTIFY_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-ba31fe4a-kanban-notify-r1@sha256:c4345416b81934d4be131219f74d6d92cd56df3e6b1da06269411326a70a9df7'
WS_COLLAB_CANDIDATE_COMPOSE_SHA256=0258f425814f4d49032ee6c72ff686c1ec35ecc5403b31f3afc2de1f6e5a71e6
WS_COLLAB_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-4ef440e7-review-ws-collab@sha256:cf304246466946f5055511a2c8e06e28739bc1b2c5fd7fa4b5d0050d77d52a6e'
UAT_REPAIR_CANDIDATE_COMPOSE_SHA256=69274263a8e8e852ed59194f1e5effd5bf551a4580f9248f1853374528d42fbc
UAT_REPAIR_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-9ea20c3f-uat-repair@sha256:0857bb42fab0b9ac8ab2793fbf4d0cf83cdf482035bf147d319332224456f710'
UAT_REPAIR_2_CANDIDATE_COMPOSE_SHA256=2c9bfcbbdb4bb85a8ccf7f0060773a93134b8fd9489ba147a45c9a7de998587b
UAT_REPAIR_2_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-5db17094-uat-repair-2@sha256:3e0d5a6116036f3acb4ec801da4d0632f0e19a99e3431ae873be4779ddf83201'
UAT_REPAIR_3_CANDIDATE_COMPOSE_SHA256=5d391625c597c009396c25737783c0b139b9c636c6c520c48e47a8843619e021
UAT_REPAIR_3_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-31bf27be-uat-repair-3@sha256:07dabd10075530092417900c06e205b5a98b8fc7cdfdd9eb59a052403e85f283'
UAT_R4_CANDIDATE_COMPOSE_SHA256=689d4a13b432b474a856734d14c2ae716b0902172d54ebd970065b7d5d926f99
UAT_R4_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-2f4522e4-uat-r4@sha256:f71416fdcd07968fd6ac6eb2ce37c83aebe584200fff3f3bbc0134c2edfbba33'
UAT_R4FIX_CANDIDATE_COMPOSE_SHA256=385c373756297ce14974c80ec6d15ccf2400dda69ba7df5189ac971aeb7fc45f
UAT_R4FIX_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d1884ca4-uat-r4fix@sha256:883db42fec1116361d8e4caad927cba4351e81f72dbb749664d40f7d8325484e'
UAT_R4FIX2_CANDIDATE_COMPOSE_SHA256=1043f99eb01a890f433ad955437da8bb5092c5863a0e942eb1a89320ff5b5fe4
UAT_R4FIX2_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a5125cf5-uat-r4fix2@sha256:a68eb69371ff86be177bb6c08b6400df85fc7e05b0ecfa1134d5c9862cc719a7'
SHARE_ASSETFIX_CANDIDATE_COMPOSE_SHA256=e5fc3c412554402994163822139fcc2c6689c1327845ae7b752005a6580cc5dc
SHARE_ASSETFIX_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7ef486de-share-assetfix@sha256:63b794c187578000cf17d873208551ef4b01b1902b02c657deb9127f601cc139'
SHARE_ORIGINFIX_CANDIDATE_COMPOSE_SHA256=79cd209d157af98f86f89515eb30788f9844859e2e21063ab67cafd28d8425d4
SHARE_ORIGINFIX_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a8cb40f3-share-originfix@sha256:70b01bab43c1db1e8fbf6c8d09ded0e8bc44e9751b53a835826a5d6bea53849a'
FULLSHARE_CANDIDATE_COMPOSE_SHA256=12a5857a1504e4daa43ae0b1d9ee641834052fa1d7f4b0231399e88f467f7195
FULLSHARE_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e'
UATFIX3_CANDIDATE_COMPOSE_SHA256=c57926be993152afb037c69fc594a52584b384b2d140d1c34a1d9bad93843ddb
UATFIX3_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-708d1712-uatfix3@sha256:4e952ebe74c32bdea01c6d306643b811162454ab6f74f8dde63f214b19a7eb88'
UATFIX4_CANDIDATE_COMPOSE_SHA256=314899585bce6cb69f3a09275b41c1f055e40989589edf8d470b5d286f3c6a33
UATFIX4_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b0eb792f-uatfix4@sha256:2d421f5c08accfd93fee04e1e2ea100dcccc51855348d3a15dbea0570864631e'
UATFIX5_CANDIDATE_COMPOSE_SHA256=24aebba06211970e6d4c4115c0c5ffc301672d879cae05215cc07af0e2424a8b
UATFIX5_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c491af97-subtask-board-markers-uatfix5@sha256:809d858b1de14e054cf659da715000e7ce006e5f6703e0e4e2f5263bff33a65d'
UATFIX6_CANDIDATE_COMPOSE_SHA256=1e637fa348ddc6d4d53f7d4ff0c0f082ffbd06002218848281ac1c6d88a2e717
UATFIX6_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd'
UATFIX7_CANDIDATE_COMPOSE_SHA256=5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f
UATFIX7_CANDIDATE_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'

fail() { printf '%s\n' "Kaneo backup verification BLOCKED: $*" >&2; exit 2; }

[ "$(id -u)" -eq 0 ] || fail 'root execution required'
[ -d "$OUTBOX_ROOT" ] && [ ! -L "$OUTBOX_ROOT" ] || fail 'encrypted outbox missing or symlinked'
[ "$(stat -c '%U:%G %a' "$OUTBOX_ROOT")" = 'root:root 700' ] || fail 'encrypted outbox ownership/mode mismatch'
[ -f "$VERIFIER" ] && [ ! -L "$VERIFIER" ] || fail 'strict verifier missing or symlinked'
[ "$(sha256sum "$VERIFIER" | awk '{print $1}')" = "$EXPECTED_VERIFIER_SHA256" ] || fail 'strict verifier hash mismatch'
latest=$(find "$OUTBOX_ROOT" -maxdepth 1 -type f -name 'kaneo-*.receipt.json' -printf '%f\n' | sort | tail -n 1 || true)
[ -n "$latest" ] || fail 'no encrypted receipt exists'
backup_id=${latest%.receipt.json}
printf '%s\n' "$backup_id" | grep -Eq '^kaneo-[0-9]{8}T[0-9]{6}Z$' || fail 'latest backup id is invalid'
cipher="$OUTBOX_ROOT/$backup_id.age"
receipt="$OUTBOX_ROOT/$latest"
[ -f "$cipher" ] && [ ! -L "$cipher" ] || fail 'latest ciphertext missing or symlinked'
[ -f "$receipt" ] && [ ! -L "$receipt" ] || fail 'latest receipt missing or symlinked'
verify_dir=$(mktemp -d "$OUTBOX_ROOT/.verify.XXXXXX")
cleanup() { rm -rf "$verify_dir"; }
trap cleanup EXIT HUP INT TERM
ln "$cipher" "$verify_dir/$backup_id.age"
ln "$receipt" "$verify_dir/$latest"
python3 "$VERIFIER" "$verify_dir" --json >/dev/null || fail 'strict latest-bundle verification failed'
python3 - "$receipt" "$BASELINE_COMPOSE_SHA256" "$BASELINE_IMAGE" "$PREVIOUS_CANDIDATE_COMPOSE_SHA256" "$PREVIOUS_CANDIDATE_IMAGE" "$CANDIDATE_COMPOSE_SHA256" "$CANDIDATE_IMAGE" "$PRE_REPAIR_CANDIDATE_COMPOSE_SHA256" "$PRE_REPAIR_CANDIDATE_IMAGE" "$PREVIOUS_CURRENT_CANDIDATE_COMPOSE_SHA256" "$PREVIOUS_CURRENT_CANDIDATE_IMAGE" "$CURRENT_CANDIDATE_COMPOSE_SHA256" "$CURRENT_CANDIDATE_IMAGE" "$FOLLOWUP_CANDIDATE_COMPOSE_SHA256" "$FOLLOWUP_CANDIDATE_IMAGE" "$NEXT_CANDIDATE_COMPOSE_SHA256" "$NEXT_CANDIDATE_IMAGE" "$VERSION_FIX_CANDIDATE_COMPOSE_SHA256" "$VERSION_FIX_CANDIDATE_IMAGE" "$EXECUTION_FLAGS_CANDIDATE_COMPOSE_SHA256" "$EXECUTION_FLAGS_CANDIDATE_IMAGE" "$EXECUTION_SCHEMA_REPAIR_CANDIDATE_COMPOSE_SHA256" "$EXECUTION_SCHEMA_REPAIR_CANDIDATE_IMAGE" "$NATIVE_CONTROL_CANDIDATE_COMPOSE_SHA256" "$NATIVE_CONTROL_CANDIDATE_IMAGE" "$AUTH_SCOPE_CANDIDATE_COMPOSE_SHA256" "$AUTH_SCOPE_CANDIDATE_IMAGE" "$SUPERVISOR_AUTH_CANDIDATE_COMPOSE_SHA256" "$SUPERVISOR_AUTH_CANDIDATE_IMAGE" "$SUPERVISOR_PRINCIPAL_CANDIDATE_COMPOSE_SHA256" "$SUPERVISOR_PRINCIPAL_CANDIDATE_IMAGE" "$SUPERVISOR_TERMINAL_GUARD_CANDIDATE_COMPOSE_SHA256" "$SUPERVISOR_TERMINAL_GUARD_CANDIDATE_IMAGE" "$CONTROL_ACTOR_CANDIDATE_COMPOSE_SHA256" "$CONTROL_ACTOR_CANDIDATE_IMAGE" "$RETRY_BUDGET_CANDIDATE_COMPOSE_SHA256" "$RETRY_BUDGET_CANDIDATE_IMAGE" "$RESUME_LINEAGE_CANDIDATE_COMPOSE_SHA256" "$RESUME_LINEAGE_CANDIDATE_IMAGE" "$RESUME_DISPATCH_CANDIDATE_COMPOSE_SHA256" "$RESUME_DISPATCH_CANDIDATE_IMAGE" "$RESUME_DISPATCH_R2_CANDIDATE_COMPOSE_SHA256" "$RESUME_DISPATCH_R2_CANDIDATE_IMAGE" "$RESUME_BRANCH_CANDIDATE_COMPOSE_SHA256" "$RESUME_BRANCH_CANDIDATE_IMAGE" "$KANBAN_NOTIFY_CANDIDATE_COMPOSE_SHA256" "$KANBAN_NOTIFY_CANDIDATE_IMAGE" "$WS_COLLAB_CANDIDATE_COMPOSE_SHA256" "$WS_COLLAB_CANDIDATE_IMAGE" "$UAT_REPAIR_CANDIDATE_COMPOSE_SHA256" "$UAT_REPAIR_CANDIDATE_IMAGE" "$UAT_REPAIR_2_CANDIDATE_COMPOSE_SHA256" "$UAT_REPAIR_2_CANDIDATE_IMAGE" "$UAT_REPAIR_3_CANDIDATE_COMPOSE_SHA256" "$UAT_REPAIR_3_CANDIDATE_IMAGE" "$UAT_R4_CANDIDATE_COMPOSE_SHA256" "$UAT_R4_CANDIDATE_IMAGE" "$UAT_R4FIX_CANDIDATE_COMPOSE_SHA256" "$UAT_R4FIX_CANDIDATE_IMAGE" "$UAT_R4FIX2_CANDIDATE_COMPOSE_SHA256" "$UAT_R4FIX2_CANDIDATE_IMAGE" "$SHARE_ASSETFIX_CANDIDATE_COMPOSE_SHA256" "$SHARE_ASSETFIX_CANDIDATE_IMAGE" "$SHARE_ORIGINFIX_CANDIDATE_COMPOSE_SHA256" "$SHARE_ORIGINFIX_CANDIDATE_IMAGE" "$FULLSHARE_CANDIDATE_COMPOSE_SHA256" "$FULLSHARE_CANDIDATE_IMAGE" "$UATFIX3_CANDIDATE_COMPOSE_SHA256" "$UATFIX3_CANDIDATE_IMAGE" "$UATFIX4_CANDIDATE_COMPOSE_SHA256" "$UATFIX4_CANDIDATE_IMAGE" "$UATFIX5_CANDIDATE_COMPOSE_SHA256" "$UATFIX5_CANDIDATE_IMAGE" "$UATFIX6_CANDIDATE_COMPOSE_SHA256" "$UATFIX6_CANDIDATE_IMAGE" "$UATFIX7_CANDIDATE_COMPOSE_SHA256" "$UATFIX7_CANDIDATE_IMAGE" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, baseline_compose, baseline_image, previous_compose, previous_image, candidate_compose, candidate_image, pre_repair_compose, pre_repair_image, previous_current_compose, previous_current_image, current_candidate_compose, current_candidate_image, followup_compose, followup_image, next_compose, next_image, version_fix_compose, version_fix_image, execution_flags_compose, execution_flags_image, execution_schema_repair_compose, execution_schema_repair_image, native_control_compose, native_control_image, auth_scope_compose, auth_scope_image, supervisor_auth_compose, supervisor_auth_image, supervisor_principal_compose, supervisor_principal_image, supervisor_terminal_guard_compose, supervisor_terminal_guard_image, control_actor_compose, control_actor_image, retry_budget_compose, retry_budget_image, resume_lineage_compose, resume_lineage_image, resume_dispatch_compose, resume_dispatch_image, resume_dispatch_r2_compose, resume_dispatch_r2_image, resume_branch_compose, resume_branch_image, kanban_notify_compose, kanban_notify_image, ws_collab_compose, ws_collab_image, uat_repair_compose, uat_repair_image, uat_repair_2_compose, uat_repair_2_image, uat_repair_3_compose, uat_repair_3_image, uat_r4_compose, uat_r4_image, r4fix_compose, r4fix_image, r4fix2_compose, r4fix2_image, share_assetfix_compose, share_assetfix_image, share_originfix_compose, share_originfix_image, fullshare_compose, fullshare_image, uatfix3_compose, uatfix3_image, uatfix4_compose, uatfix4_image, uatfix5_compose, uatfix5_image, uatfix6_compose, uatfix6_image, uatfix7_compose, uatfix7_image = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    receipt = json.load(handle)
identity = (receipt.get("compose_sha256"), receipt.get("image_ref"))
if identity not in {(baseline_compose, baseline_image), (previous_compose, previous_image), (candidate_compose, candidate_image), (pre_repair_compose, pre_repair_image), (previous_current_compose, previous_current_image), (current_candidate_compose, current_candidate_image), (followup_compose, followup_image), (next_compose, next_image), (version_fix_compose, version_fix_image), (execution_flags_compose, execution_flags_image), (execution_schema_repair_compose, execution_schema_repair_image), (native_control_compose, native_control_image), (auth_scope_compose, auth_scope_image), (supervisor_auth_compose, supervisor_auth_image), (supervisor_principal_compose, supervisor_principal_image), (supervisor_terminal_guard_compose, supervisor_terminal_guard_image), (control_actor_compose, control_actor_image), (retry_budget_compose, retry_budget_image), (resume_lineage_compose, resume_lineage_image), (resume_dispatch_compose, resume_dispatch_image), (resume_dispatch_r2_compose, resume_dispatch_r2_image), (resume_branch_compose, resume_branch_image), (kanban_notify_compose, kanban_notify_image), (ws_collab_compose, ws_collab_image), (uat_repair_compose, uat_repair_image), (uat_repair_2_compose, uat_repair_2_image), (uat_repair_3_compose, uat_repair_3_image), (uat_r4_compose, uat_r4_image), (r4fix_compose, r4fix_image), (r4fix2_compose, r4fix2_image), (share_assetfix_compose, share_assetfix_image), (share_originfix_compose, share_originfix_image), (fullshare_compose, fullshare_image), (uatfix3_compose, uatfix3_image), (uatfix4_compose, uatfix4_image), (uatfix5_compose, uatfix5_image), (uatfix6_compose, uatfix6_image), (uatfix7_compose, uatfix7_image)}:
    raise SystemExit("latest receipt source identity is not baseline or candidate")
MAX_BACKUP_AGE_SECONDS = 30 * 24 * 3600
created_at = receipt.get("created_at")
if not isinstance(created_at, str):
    raise SystemExit("latest receipt created_at is missing")
try:
    created = datetime.strptime(created_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
except ValueError:
    raise SystemExit("latest receipt created_at is not the reviewed UTC format")
age_seconds = (datetime.now(timezone.utc) - created).total_seconds()
if age_seconds > MAX_BACKUP_AGE_SECONDS:
    raise SystemExit("latest backup failed the 30-day freshness gate: " + created_at)
if age_seconds < -300:
    raise SystemExit("latest backup receipt timestamp is in the future: " + created_at)
if receipt.get("inner_manifest_decrypt_verified") is not False:
    raise SystemExit("latest receipt is not pre-decrypt")
if receipt.get("plaintext_egress") is not False:
    raise SystemExit("plaintext egress policy mismatch")
PY
cipher_sha256=$(sha256sum "$cipher" | awk '{print $1}')
receipt_sha256=$(sha256sum "$receipt" | awk '{print $1}')
printf '%s\n' "Kaneo backup verification PASS: $backup_id ciphertext_sha256=$cipher_sha256 receipt_sha256=$receipt_sha256; production source identity accepted, 30-day freshness gate enforced, and plaintext egress blocked."
