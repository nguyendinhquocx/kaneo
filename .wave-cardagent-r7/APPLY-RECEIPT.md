# Kaneo card-agent collaboration R7 production wave receipt

Status: APPLIED 2026-11-16 — production wave PASS.

- SPEC: SPEC-2026-11-10-kaneo-card-agent-collaboration (UAT Revision 7)
- Source commit: `1e800ab2fef42e647aa1a832f693ccde696cfc07` (`kaneo/prodesk-production`)
- Previous image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-6edc3bce-card-agent-collab-r5@sha256:d1623209cd2bcc57f3fbe304923f0ae0913de40185a96b5ff0ae19fb4ff588a2`
- Candidate image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-1e800ab2-card-agent-collab-r7@sha256:993a79ffcf87f0a90a9acc6dfcec1b74874063e9ecfe4eeb53f0530fed305188`
- Candidate digest: `sha256:993a79ffcf87f0a90a9acc6dfcec1b74874063e9ecfe4eeb53f0530fed305188`
- Candidate Compose SHA256: `3f5e0989241b5d73df9e29d7fc2fba30e9f1e0b2afece97b82be78434ce5993c`
- Migration head: unchanged 0056 (id 59/count 59); R7 adds no migrations.
- Pre/post encrypted snapshot IDs, private R2 mirror receipts, exact image identity and health checks: fill after apply.
- Root cause: relation create CAS used a placeholder query returning undefined, falling back to parent contentRevision 1; plus Add stayed enabled while relation write was pending, permitting duplicate child creation.
- Fix: real parent task fetch before relation CAS, duplicate-submit guard, best-effort orphan cleanup only after checking relation commit.
