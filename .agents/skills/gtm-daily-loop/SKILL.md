---
name: gtm-daily-loop
description: Run the VOIDRIP daily Market Map loop toward a 20-prospect human-review buffer. Use for today's GTM, buffer preparation, signal refresh, or the scheduled daily run.
---

# VOIDRIP GTM — daily loop V1

Codex orchestrates a persistent Market Map. Drive remains the governed operational map; SQLite provides deterministic deduplication, qualification state, signals, activation, drafting and safety.

## Non-negotiable safety

- `SEND_MODE` stays `locked`.
- The unattended loop may not approve, import leads into HeyReach, start, resume, or launch a campaign.
- Adding leads to HeyReach requires a first explicit authorization from Jen.
- Starting the campaign requires a second, distinct explicit authorization from Jen.
- The target is 20 prospects ready for human review, never 20 contacts obtained by weakening the Boundary or intent evidence.

## Daily target

`gtm_get_daily_buffer` is the source of truth:

- target: 20;
- quality floor: `PASS_OUTBOUND_V1` + named visible Person + Project + current/recent public signal + Tier A/B + clean LinkedIn sequence;
- if fewer than 20 satisfy the floor, report the exact deficit and continue sourcing or signal research. Do not promote Tier C or `PASS_MARKET_ONLY`.

## Steps

### 0. Preflight

- Run `gtm_doctor`, `gtm_status`, `gtm_verify_heyreach`, `gtm_get_activation_readiness`, then `gtm_get_daily_buffer`.
- HeyReach must remain the configured campaign, `DRAFT`, with no outreach in progress.
- The configured lead list, official sequence and active assigned LinkedIn account must pass readiness before the system can be enabled.
- A provider outage does not authorize a fallback provider or a new campaign.

### 1. Sync results and replies

- Only after a campaign has previously run: call `gtm_sync_heyreach_results` and `gtm_sync_heyreach_replies`.
- Replies always take priority over new sourcing.
- Never send a reply automatically.

### 2. Refresh the persistent Market Map

- Read the governed Drive Market Map and its SourceLane evidence.
- Normalize each changed Person + Project into `gtm_sync_market_map_snapshot`.
- Preserve external candidate, project, observation and qualification IDs.
- Do not replace the map with a fresh daily list.

### 3. Resolve and qualify new records

- Use `gtm_get_resolution_queue` and save the real Person + Project.
- Use `gtm_get_boundary_queue` and apply `GTM_BOUNDARY_V1` conservatively.
- FIT and INTENT remain separate.
- Missing evidence becomes `HOLD_EVIDENCE`, not an invented PASS or automatic FAIL.

### 4. Refresh public signals

- Use `gtm_get_signal_queue`.
- Research only observable, attributable, dated public events relevant to the named project.
- Save them with `gtm_save_signal_events`, including strength and whether the signal may be mentioned.
- Fit alone is Tier C and is not contact-ready.

### 5. Prioritize

- Use `gtm_get_priority_queue` and `gtm_save_activation_scores`.
- Tier A requires intent 4–5 and current/recent evidence.
- Tier B requires intent 2–3 and current/recent evidence.
- Tier C remains in the Market Map with route `none`.
- Outbound V1 route is LinkedIn.

### 6. Draft

- Use `gtm_get_market_drafting_queue` and the approved Activation Playbook.
- Save with `gtm_save_candidate_sequence` only after lint is clean.
- Copy remains grounded in the prospect's public evidence and official M1–M5 sequence.

### 7. Fill the human-review buffer

- Run `gtm_get_daily_buffer` again.
- Export at most 20 ready records to the Google review sheet.
- The sheet is the human approval surface; engine status is not approval.
- Stop at review. Perform no HeyReach write.

### 8. Learning readiness

- Read `gtm_get_market_performance` only from real outcomes.
- A learning iteration creates `gtm_save_market_learning_proposal`; it never applies itself.
- `gtm_review_market_learning` is a separate human-only action and is not available unattended.
- Never change the Boundary automatically.

### 9. Report

Report the ready count / 20, the exact deficit, the blocking stage, new qualifications, signals, clean drafts, HOLD reasons, and HeyReach read-only state. Confirm that no lead was imported and no campaign was started.

Do not install the OS schedule until Jen explicitly decides to enable the finished system.

## Quality bar

Every row must name the actual project, show why this person has strategic authority, cite current/recent public evidence, and support a message that would make no sense sent to someone else. If the system cannot reach 20 at that standard, the correct output is a measured deficit followed by more source or signal work.
