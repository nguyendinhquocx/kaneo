# APPLY-RECEIPT — child-activity-context-r1

Status: APPLIED + LIVE UAT PASS — R10 guarded rollout PASS, 2026-11-19 → 2026-11-20.

## Candidate

- Source: kaneo branch `kaneo/child-activity-context-r1` commit `59d0905b14a50f98aaa7558875f8d43003719a00` (feature commits `2db76827` feat(api) scoped child activity endpoints + `59d0905b` feat(web) Send-to-Pi gating), base = production HEAD `3bd6169e`.
- Python extension commit: `f8787a73` feat(kaneo-mcp) scoped child activity tools with claim context (rebased onto `origin/main` `9a5231c1`, pushed `9a5231c1..f8787a73`).
- Image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-59d0905b-child-activity-context-r1@sha256:089e604ea365212a6525043ea3e59c5284a2c94698110bf3a7a404e74eca3258`.
- Source archive SHA-256: `3683a6c26ba5b5965129be7d8613cf34c68e321f8e4e53f4ddf47f26d2e76fe0` (verified byte-identical on ProDesk before extraction); image label `org.opencontainers.image.revision` = `59d0905b14a50f98aaa7558875f8d43003719a00`; image ID = digest pin (verified post-apply).
- Candidate Compose SHA-256: `d06808c581ffbe7904873a24325eac7239369a4069ec9dd002201b5c02c8fd58`.
- Backup wrapper SHA-256 after repin: `3d06edf6294376e2d5b51e76743805819fade8f814f635e26aec9baaed1f57a6`.
- Recovery metadata adapter SHA-256: `c0adde249b9083ff6eb620bb656fa76ab07bfc1e5466beab86956250dba80c93`.
- Migration verifier SHA-256: `d169659b5251b1c5c0729af00608c98714eabca0e9a0b26d1eeb26916789d2b8` (migration expectations unchanged — no schema change in this wave).
- Rollback image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-4a4996a3-subtask-order-r1@sha256:fd6569575a92f76101c5838034a90ad0f9d70d5240575733501c7729837bc282` + Compose `85fe2ccc5f8a31d5a9c83b268ec22992987a4910663e819d95917da1d3e37ecf`.
- Build: ProDesk native Docker Buildx, `--platform linux/amd64 --no-cache --push` from the committed archive; GitHub Actions remains disabled for the repo (HTTP 422) — unchanged from previous waves; Docker Scout not run.

## Apply evidence

- PLAN PASS (`plan-run.log` SHA-256 `49babe15a7f6913ab99945eab0267e884d6e833abb371cc83aff571c04e0065c`, no normalization needed): baseline Compose `85fe2ccc` + wrapper `7b0b9247` + metadata `4a4996a3` verified; candidate Compose/image pins verified; latest receipt `kaneo-20261119T100244Z` decrypt/identity/freshness PASS.
- APPLY (`deploy-run.log` SHA-256 `cd134d058e83d0f739cdb1ea02fe1af3c5f4a2829aeecdfc407c650357d8b412`): steps 1–5 PASS (wrapper installed `3d06edf6`, Compose flipped to `d06808c5`, metadata synced to `59d0905b`, pre-snapshot `kaneo-20261119T150729Z` created + identity/freshness PASS); step 6 pulled the exact candidate and recreated the container (log ends after "Container kaneo Started"). The SSH-TTY session died mid health-wait — the apply script was killed without executing steps 6-tail/7/8.
- Post-interruption read-only survey: container `kaneo` healthy on the exact pinned candidate image (config image + image ID both = `089e604e…`), Compose `d06808c5` live, local `/api/health` ok.
- RESUME (`run-resume.sh` SHA-256 `f4b1d5640e5505c013bcc6568cba0e7c690c51ed2d44d46c65f0ab6680d0b873`, log `resume-run.log` SHA-256 `f707a123fba3e5bc1b298d062584dad1d17d459b863262afb2dfdadea9c6cc78`): verified production Compose = candidate, running image = candidate + healthy, installed wrapper hash matches, image ID pin match; installed candidate migration verifier (`d169659b`) and re-ran schema verification PASS; wrapper `--plan` PASS on candidate pair; post-snapshot `kaneo-20261119T150956Z` + identity/freshness PASS; HTTPS `https://kaneo.quoc.app/api/health` → `{"status":"ok","executionMetrics":{}}`; `KANEO R10 CHILD-ACTIVITY-CONTEXT RESUME PASS` logged.
- Cosmetic defect (post-PASS, harmless): the resume pipeline emitted `run-resume.sh: 1: cleanup_verify: not found` from an EXIT trap inside a pipeline subshell after the final PASS line; all checks had already printed PASS. Recorded, not fixed.
- Snapshots: pre `kaneo-20261119T150729Z` (ciphertext `5e69271b3535dbd0f4bd00e6a5472b0fdc4f57cdf5d2cd393e005d157f138afa`, receipt `cd7076d668b1e59b98e4b93752d4a63922d21870068086a797d472595bfaf3a0`), post `kaneo-20261119T150956Z` (ciphertext `06e5bffa25e57dc8ad35a55e6fa33a011beb058e3e15fc9dc3b2a1aa1a77b6a9`, receipt `e39ff9e0042f8eccb73b6963f0013e4974b8ff90d4e0af99fd4c1c7bc9ccc441`). Both passed the pinned low-level verifier + identity/freshness checks against the candidate pins.
- Migration/schema: PASS; head remains `0056_agent_session_delivery_generation` id 59/count 59/hash `a4b63b1aadb626ca8c99e033964add7a06094b0d8cc07fb2bccf9d39cf1dca5f`; columns 62/62, constraints 7/7, indexes 5/5, backfill gaps 0 (no migration in this wave).

## Extension runtime sync (deploy order: API first, then extension)

- Laptop runtime `C:\Users\quocn\.pi\agent\extensions\kaneo-mcp\`: 6 files synced from laptop checkout (= python `origin/main` `f8787a73`) — `card-binding-state.ts`, `card-binding.ts`, `card-delivery-poller.ts`, `card-delivery-poller.test.ts`, `kaneo-card-binding.test.ts`, `README.md`; pre-sync backups saved with suffix `.pre-child-activity-20261119T151157`; post-copy SHA-256 all MATCH.
- Mixed-version protection exercised by design: old poller + new API ignores extra claim fields; new poller + old API fails closed (`failed_before_send`). Owner restarted the Pi session after sync; the three scoped tools verified registered via tool search, and restart rehydration of the binding (#227) PASS.

## Live UAT (agent, throwaway cards, owner-approved deploy)

PASS — 2026-11-20, on the live production bundle (owner's Brave, logged-in session):

- Throwaway root TOD-235 `uneu82801bigv2tm6jctyhed` "zz-UAT child-activity-context r1" + child TOD-237 `uvhvfbhoz49djupj1l64gaio` "zz-UAT sub A" created through the real UI (plus an accidental duplicate TOD-236 `mgpkh7yxo7b6x0ghz29wujqu` from a retried composer flow — deleted in cleanup).
- Session rebind `/kaneo-card uneu82801bigv2tm6jctyhed` PASS; binding rehydrate across Pi restart PASS (still bound #227 after restart).
- Scoped tools live: `kaneo_card_get_subtask(child)` → 200 full fields; `kaneo_card_list_subtask_comments(child)` → 200; `kaneo_card_create_subtask_comment(child)` → comment `usrvzij9c53w81axgx3l48sj` persisted with author "Bound session 01a1e419"; `kaneo_card_delete_subtask(child)` → PASS with CAS parent revision 2→3.
- Fail-closed live: root ID → HTTP 400 ("use the root card tools for the bound card itself"); out-of-tree subtask (#217 `cy8qxa9ez26xi1kaurbv4htn`, same project) → HTTP 404; cross-project task (`hxlxwen65wh3gsybwaww7wrg`, project "đọc") → HTTP 404 on get/list/create.
- UI gating: agent-binding comment shows NO Send-to-Pi; user comment shows the action with accessible name "Gửi cho Pi — Gửi tới phiên 01a1e419… trên pi-laptop" (target included).
- Delivery (real UI button click): child comment `elvw4o9ut1xvrjdv1f6qymrh` → poller claimed → message carried `Bound parent` + `Comment task` lines (IDs + titles) + Comment ID + untrusted guard; agent replied on the bound root card (`cy51ewuu6kg4rrnf2jtvax9e`). Root comment `tj3gtneg43waew3ukaebd6id` → single `Task:` line (no child label); reply posted (`re1ubwzuda8foyozyiuxioqg`).
- Cleanup: sub deleted via scoped tool, both throwaway roots deleted through the real UI (right-click → "Xoá..." → confirm); board shows no zz-UAT tasks; binding returned to #227 `/kaneo-card nkjo5fv2v9e28bxs9ueo6mwb` PASS.
- Real cards untouched: #217 and #227 not modified during UAT (all writes scoped to throwaway cards).

## Gates and remaining checks

- R2 mirror was not run; it remains a separate owner gate.
- ProDesk Pi kaneo-mcp runtime parity sync not yet run (laptop runtime is the UAT host); follow-up per pi-agent-parity OPERATIONS.md.
- Review evidence: 2 independent GLM reviews (adversarial full-diff + scope/security lens) — 2 P3 cursor findings fixed (BIGINT range guard + legacy ISO regression test), API 31/31 + API tsc PASS after fix; scope lens APPROVED; 0 P1/P2.

- Build log (`build.log` original SHA-256 `b950752ddbb6400f87812dc3bef04b7ccb0728a917213c8428e973b61953a6d4`; committed copy `42a933f6c70f6e81402eaff61f20df0bc38c1d8999a5fe6af5963535886b82d9` removes only 31 trailing blank lines).
- Log integrity note: all four committed logs (`plan-run.log`, `deploy-run.log`, `resume-run.log`, `build.log`) are committed copies; original ProDesk SHA-256 values are listed above per file. Whitespace normalization (trailing blanks only) applied where needed for the commit policy; original hashes preserved in this receipt.
