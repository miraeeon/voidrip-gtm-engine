---
name: gtm-daily-loop
description: Run the full GTM Autopilot daily loop end to end — learn from yesterday's Overloop results, source new signal-based leads from Max (yourmax.ai), classify and route every lead (email / LinkedIn / both), write and finalize lead-specific sequences, push them to Overloop, verify safety and write the daily brief. Use when the user says "run the daily loop", "run today's GTM", "gtm daily", or on the scheduled daily run.
---

# GTM Autopilot — daily loop

You are the brain of GTM Autopilot. Max (yourmax.ai) finds people showing buying signals, Overloop (overloop.ai) runs the email + LinkedIn outreach, and you make every judgment in between. Use the `gtm_*` MCP tools (or `node bin/gtm.mjs tool <name> '<json>'` if MCP is unavailable).

**Safety first:** run `gtm_doctor` and read `send_mode`. In `locked` mode (the default) campaigns are inert drafts and enrollment is blocked in code. Never try to enroll, activate a campaign, or work around the SafetyGuard. Never message anyone yourself.

## Steps

### 0. Preflight
- `gtm_doctor` must show `max.ok` and `overloop.ok`. If a platform is down, stop and report it.
- If `seller_profile` is missing, run `gtm_init` and then fill `gtm_seller_profile` (value_proposition, proof_points, primary_cta) from the business description. Ask the user when facts are unknown; never invent proof points.

### 1. Learn from yesterday (feed intelligence back)
Follow the **gtm-learn** skill:
`gtm_sync_results` → `gtm_get_performance` → `gtm_save_learnings`.
Skip this step when there are no outcomes at all.

### 1b. Replies (the most valuable minutes of the day)
Follow the **gtm-replies** skill:
- `gtm_get_reply_queue`;
- fetch any missing text (mailbox MCP or the user);
- `gtm_save_reply_triage` for each reply.

Hot replies and their drafted answers go at the top of your summary.

### 2. Source
- `gtm_source_leads`.
- If there are 0 new leads, check `gtm_setup`: are any subscriptions active? Suggest (don't silently create) signal subscriptions that fit the ICP, then continue with any leads already queued.

### 3. Classify and route
Follow the **gtm-classify-route** skill. Loop `gtm_get_classification_queue` → `gtm_save_classifications` in batches of about 20 until `remaining_in_queue` is 0.

### 4. Write sequences
Follow the **gtm-write-sequence** skill. Loop `gtm_get_drafting_queue` → for each lead: draft, self-critique, save as `final` with `gtm_save_sequence`. Fix any lint errors.
- For more than 10 leads, dispatch batches to the `sequence-writer` subagent in parallel (5–8 leads each) when your environment supports subagents.

### 5. Push
- `gtm_push_to_overloop`, then `gtm_verify_overloop`.
- In locked mode, `all_inert` must be `true`. If it is false, stop immediately and tell the user.

### 5b. Review gate (never skip)
- New campaigns wait for a human. Point the user to `gtm_review_queue` / `gtm review`.
- Call `gtm_approve` **only** when the user explicitly approves specific campaigns in this session.
- Call `gtm_launch` (confirm "SEND") **only** when the user explicitly asks to send and `SEND_MODE=live`.
- Never approve or launch on a scheduled or unattended run.

### 6. Report
- `gtm_write_report`.
- Then reply to the user with a short summary: leads in / routed / written / pushed, the top 3 sequences (name, tier, route, first line), what the loop learned, and anything that needs a human (replies to handle, missing seller facts, suggested Max signals).

## Quality bar
- Every first touch uses the lead's signal as the hook and would make no sense sent to anyone else.
- Never state facts that are not in the lead data or the seller profile.
- A smaller number of excellent sequences beats a larger number of mediocre ones. Use DQ freely.
