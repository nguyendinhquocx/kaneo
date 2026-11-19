# APPLY-RECEIPT — subtask-order-r1

Status: PREPARED — production apply not yet run.

- Source: `kaneo/prodesk-production` commit `4a4996a3ed680480fedf3c4b17b7850112840d96` (pushed to `github-main`).
- Candidate: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-4a4996a3-subtask-order-r1@sha256:fd6569575a92f76101c5838034a90ad0f9d70d5240575733501c7729837bc282`.
- Current/rollback: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7a8dc20e-glanceable-progress@sha256:8818eb60d14fdd15dedf8af57622b58f3c96fd7584e11cf3e912ff0ae1356b61`.
- Candidate compose SHA-256: `85fe2ccc5f8a31d5a9c83b268ec22992987a4910663e819d95917da1d3e37ecf`.
- Expected DB head: `0056_agent_session_delivery_generation`, id 59/count 59/hash `a4b63b1aadb626ca8c99e033964add7a06094b0d8cc07fb2bccf9d39cf1dca5f`; no migration in this wave.
- Pre-apply baseline (read-only): live image healthy; Compose SHA `0835ee222befc5a5f1a30a4020096ca20dcf382dc93abb1d4dab09aeb1c4f99f`; backup `--plan` PASS; H7 preflight `ready`.
- Backup policy: R10 pre/post encrypted snapshots in local outbox; R2 mirror remains a separate owner gate.
- Planned sequence: wrapper repin → current wrapper plan → atomic Compose flip → recovery metadata sync → pre-snapshot → pull/up/health/digest → migration/schema verification → post guard → post-snapshot → HTTPS health.
- Snapshot IDs, live health, applied Compose SHA, and final status will be appended only after the guarded run actually passes.
