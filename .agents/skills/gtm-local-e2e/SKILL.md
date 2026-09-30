---
name: gtm-local-e2e
description: Run the VOIDRIP LOCAL E2E V1 from an imported CSV or JSON candidate batch through Market Map, Person + Project resolution, GTM Boundary V1 qualification, activation priority, local drafting and human review. Use when validating Phase 9 or when the user asks to process a candidate file without a live source or execution provider.
---

# VOIDRIP LOCAL E2E V1

Use only the local `gtm_*` tools. Do not call an execution adapter, push, approve, launch or contact anyone.

1. Ingest normalized records with `gtm_ingest_candidates`. Preserve the supplied SourceLane.
2. Read `gtm_get_resolution_queue`; resolve the actual Person + Project and save it with `gtm_save_project_resolution`.
3. Read `gtm_get_boundary_queue`; qualify conservatively against `GTM_BOUNDARY_V1` with `gtm_save_boundary_qualifications`.
   - `UNKNOWN` is not `FAIL`.
   - Prefer `HOLD_EVIDENCE` to unsupported inference.
   - A project misaligned with the professional identity cannot be `PASS_OUTBOUND_V1`.
4. Read `gtm_get_priority_queue`; only `PASS_OUTBOUND_V1` records may receive `gtm_save_activation_scores`.
   - Boundary FIT must remain unchanged.
   - No current signal means unknown intent, not poor fit.
5. Read `gtm_get_market_drafting_queue`; draft from verified evidence only and save through `gtm_save_candidate_sequence`.
6. Read `gtm_get_market_review_queue` and present the exact final copy for human review.

Stop at review. Phase 9 has no source API dependency, no HeyReach dependency and no sending path.
