# APPLY-RECEIPT — glanceable-progress-r1 (SPEC-2026-11-18)

- Deployed: 2026-11-18 on prodesk-home, owner-approved (`deploy`).
- Image: ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7a8dc20e-glanceable-progress@sha256:8818eb60d14fdd15dedf8af57622b58f3c96fd7584e11cf3e912ff0ae1356b61
- Compose pin after flip: sha256 0835ee222befc5a5f1a30a4020096ca20dcf382dc93abb1d4dab09aeb1c4f99f
- Rollback pin: R10 ab61b5e07d903ef88bea0b797a8cdc72e0915192bea7eae7d92dfae311eece8f
- Steps: repin wrapper -> pre-flip guard PASS -> compose flip -> recovery metadata sync PASS (source_revision 7a8dc20e) -> pre snapshot kaneo-20261118T135202Z -> pull/up -> healthy -> migration/schema PASS (59 migrations, 62/62 columns, 7/7 constraints, 5/5 indexes, marker_counts_valid=0) -> post guard PASS -> post snapshot kaneo-20261118T135500Z.
- Live UAT right after deploy: subtask tick (status=final) + marker-only redCircle patch both succeeded (previously 400); GET returns per-subtask workMarkerCounts.
- Pin reconciliation: host preset d7f912c4, laptop preset 8d940fed, wrapper pairs r10<->glanceable.
- Notes: first run-all attempt failed at snapshot (metadata not yet synced — expected; fixed by running reviewed metadata sync between flip and snapshot, per wave pattern). R2 mirror remains a separate reviewed gate (outbox holds both snapshots).
