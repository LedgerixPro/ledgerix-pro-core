<!-- Overwritten at every session close. Single source of truth for session start. Paste `cat docs/SESSION-HANDOFF.md` as the first message of a new session. -->

SESSION HANDOFF — 2026-05-31
HEAD: 1314d6b5   tree: clean (1 untracked: scripts/smoke-r2-archive.ts, intentional)
Phase: Phase 6 audit retention — R2 production storage wiring (operational, 6c-infra beta-grade slice)
Last shipped: R2 wiring complete at config level (Railway env). Public DB proxy removed (security). Smoke test NOT yet run.

NEXT ACTIONS (in order):
  1. ROTATE PROD POSTGRES PASSWORD (proper rotation). It leaked into chat 2026-05-30. Public networking is now OFF (mitigation done — proxy removed, so it's no longer internet-reachable), but the role password is still the leaked value and must be changed. Railway managed PG: editing POSTGRES_PASSWORD var alone does NOT re-key the role. Correct path: re-enable a temp public proxy (Postgres service → Settings → Networking → Generate Domain) OR use `railway connect`, then run `ALTER USER postgres WITH PASSWORD '<new>';` against the DB, then update POSTGRES_PASSWORD var to match, confirm app reconnects (it uses internal postgres.railway.internal), then remove the temp proxy again.
  2. RUN R2 SMOKE TEST (the one unproven link — R2 config is verified, round-trip is not).
     - Re-enable public proxy first (Networking → Generate Domain) to get a fresh turntable host:port; re-check with \conninfo (host/port change per session).
     - Terminal 1: `railway connect Postgres` (leave open).
     - Terminal 2: railway run --service ledgerix-pro-core -- bash -c 'export PGPASSWORD="<NEW_PASSWORD>"; export DATABASE_URL="postgresql://postgres@<PROXY_HOST>:<PORT>/railway"; exec server/node_modules/.bin/tsx scripts/smoke-r2-archive.ts'
     - The script's env-block MUST show DATABASE_URL host = the proxy host (NOT postgres.railway.internal) before proceeding.
     - Script: scripts/smoke-r2-archive.ts (untracked). Seeds throwaway company + 1 activity row → companyService.remove() → R2 archive write → asserts audit_archives manifest → retrieveAuditTrail asserts source:"archived". Self-cleans on failure; leaves R2 object + manifest as evidence on PASS.
     - tsx at server/node_modules/.bin/tsx (no global/npx). DB user=postgres db=railway. Password is plain (no special chars).
     - If PUT fails with 400/501 re x-amz-sdk-checksum-algorithm → R2 CRC32 quirk; one-line fix s3-provider.ts:73-77 (requestChecksumCalculation/responseChecksumValidation "WHEN_REQUIRED"). Don't pre-apply.
  3. After smoke PASS: remove the temp public proxy again (keep DB internal-only).

CONFIRMED WORKING THIS SESSION:
  - R2 bucket ledgerixpro-audit-archive (Standard, public access DISABLED).
  - Railway ledgerix-pro-core env set: PAPERCLIP_STORAGE_PROVIDER=s3, _S3_BUCKET=ledgerixpro-audit-archive, _S3_REGION=auto, _S3_FORCE_PATH_STYLE=true, _S3_ENDPOINT=https://8857290ac017f81920d47c805bfb4794.r2.cloudflarestorage.com, AWS_ACCESS_KEY_ID/SECRET (Account token, Object R&W, this bucket only), PAPERCLIP_ARCHIVE_MASTER_KEY (fresh, vault).
  - App redeployed healthy (api.ledgerixpro.com); every smoke attempt's env-block confirmed R2 wiring correct.
  - Storage flip is GLOBAL (one StorageService singleton) — all 10 consumers moved to R2 atomically. assets=0 rows, issue_attachments=0 rows confirmed pre-flip → ZERO collateral.
  - s3-provider.ts verified R2-compatible as-is (PUT/GET/HEAD/DELETE only; no ACL/StorageClass/multipart).

CREDENTIAL HYGIENE (6c-infra checklist seeds):
  - CONFIRM the AWS_ACCESS_KEY_ID/SECRET in Railway are from the REPLACEMENT R2 token, not the first one whose cfat_ value leaked in a screenshot. Re-issue if unsure.
  - Archive key + DB password both leaked once and are being handled; rule going forward: secrets generate-once, store-direct-to-vault, never transit chat/screenshot/terminal-echo.

DEFERRED (not this arc): full 6c-infra ceremony (7-yr archive-key escrow + no-rotate custody) → pre-EXTERNAL-paying-client gate. Beta-grade floor (durable R2 backend + real key) is in place pending smoke proof.

Test baseline: 2167/2169 pass via `pnpm test` (full monorepo, 334 files; 1 skipped). Known-red: cli/worktree.test.ts (pre-existing, not Phase 6). ~3 server tests flake under parallel load.
Open decisions: none blocking. Cleanup tickets: fix cli/worktree.test.ts; vitest projects-mode config bug (adapter-utils isolation).
