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

The loop has two different counters and must never collapse them:

- Phase G intake target: 20 new unique `BOFU_CANDIDATE` for the Kernel of the day;
- activation target: 20 prospects in `gtm_get_daily_buffer` that passed every downstream gate.

`BOFU_CANDIDATE` is high-recall input, not an outbound-ready prospect. Continue the
governed collection and qualification loop until the review buffer reaches its target;
do not pretend that 20 raw BOFU candidates equal 20 activations.

`gtm_get_daily_buffer` remains the source of truth for activation:

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

### 2. Feed the FIT stock through governed SourceLanes

- Call `gtm_get_source_lane_collection_plan` for the active Kernel. This is the
  executable bridge from Need Territories, Derived Prospecting Persona and
  attractors to the persistent Market Map.
- Execute only the returned V-A, H-A2, R-A2 or M-B work packets through the
  available public or authenticated source connector. Apollo, Clay and
  SocialCrawl are optional expanders, never hard dependencies and never the
  definition of the target profile.
- Resume an unfinished Kernel run before choosing a new Kernel. Do not invent a rotation
  state that is not recorded.
- Need Territories and Query Families guide retrieval; they are not inferred as facts
  about a person.
- Keep a result as a `BOFU_CANDIDATE` only when it has a HOT/WARM public signal,
  active resolution behavior, a real project or credible project hint, a plausible
  Kernel, and a resolvable public person identity.
- A launch, MVP, product update, accelerator page, YC page, or request for product
  feedback alone never passes this gate. A shipped MVP is evidence that a first
  structure already exists; it is not evidence that the person needs VOIDRIP to create
  that structure. Only a distinct, explicit current restructuring need may be evaluated
  on its own evidence.
- Current Y Combinator participation is a hard activation exclusion. Other program
  participation is an attractor only and never establishes outbound intent by itself.
- Ingest kept records with `gtm_ingest_candidates`, grouped by
  `BOFU QUERY FAMILY` as the `source_lane_id`. Preserve queue id, public source URL,
  source date, Need Territory ids, intent evidence, recency, and the raw governed row.
- Deduplicate on Person + Project and record the measured deficit. Use free/public
  surfaces first; a paid collector may only close the measured gap under its governed
  cost gate.
- Never compensate for a missing SourceLane connector by freely searching for people
  one by one. Report the connector or coverage deficit instead.

### 3. Refresh the persistent Market Map

- Read the governed Drive Market Map and its SourceLane evidence.
- Normalize each changed Person + Project into `gtm_sync_market_map_snapshot`.
- Preserve external candidate, project, observation and qualification IDs.
- Do not replace the map with a fresh daily list.

### 4. Resolve and qualify new records

- Use `gtm_get_resolution_queue` and save the real Person + Project.
- Use `gtm_get_boundary_queue` and apply `GTM_BOUNDARY_V1` conservatively.
- FIT and INTENT remain separate.
- Missing evidence becomes `HOLD_EVIDENCE`, not an invented PASS or automatic FAIL.

### 5. Refresh public signals

- Use `gtm_get_signal_collection_plan`. Execute only the candidate-specific queries it
  returns; the plan is built from `gtm_get_signal_queue` and therefore cannot become a
  second person-discovery loop.
- Research only observable, attributable, dated public events relevant to the named project.
- Save them with `gtm_save_signal_events`, including strength and whether the signal may be mentioned.
- Fit alone is Tier C and is not contact-ready.
- If no qualifying signal is found, record the deficit for that Person + Project. Do not
  replace it with an arbitrary newly discovered person.

### 6. Prioritize

- Use `gtm_get_priority_queue` and `gtm_save_activation_scores`.
- Tier A requires intent 4–5 and current/recent evidence.
- Tier B requires intent 2–3 and current/recent evidence.
- Tier C remains in the Market Map with route `none`.
- Outbound V1 route is LinkedIn.

### 7. Draft

- Use `gtm_get_market_drafting_queue` and the approved Activation Playbook.
- Save with `gtm_save_candidate_sequence` only after lint is clean.
- Copy remains grounded in the prospect's public evidence and official M1–M5 sequence.

### 8. Fill the human-review buffer

- Run `gtm_get_daily_buffer` again.
- Export at most 20 ready records to the Google review sheet.
- The sheet is the human approval surface; engine status is not approval.
- Stop at review. Perform no HeyReach write.

### 9. Learning readiness

- Read `gtm_get_market_performance` only from real outcomes.
- A learning iteration creates `gtm_save_market_learning_proposal`; it never applies itself.
- `gtm_review_market_learning` is a separate human-only action and is not available unattended.
- Never change the Boundary automatically.

### 10. Report

Report both counters: new unique BOFU candidates for the active Kernel and ready
prospects / 20. Include the exact deficit, the blocking stage, new qualifications,
signals, clean drafts, HOLD reasons, and HeyReach read-only state. Confirm that no lead
was imported and no campaign was started.

Do not install the OS schedule until Jen explicitly decides to enable the finished system.

## Quality bar

Every row must name the actual project, show why this person has strategic authority, cite current/recent public evidence, and support a message that would make no sense sent to someone else. If the system cannot reach 20 at that standard, the correct output is a measured deficit followed by more source or signal work.
