---
name: gtm-learn
description: Learn from VOIDRIP GTM results — sync execution outcomes, analyze reply, positive and meeting rates by source, signal, tier, persona, route and hook, then feed the intelligence back into the playbook and weights. Use during the daily loop or when the user asks what's working, to analyze results, or to improve targeting and messaging.
---

# Learn from results

1. Call `gtm_sync_heyreach_results`, then `gtm_get_market_performance`.
2. Read `data_quality` first.
   - **Simulated outcomes present:** this is a dry run of the learning loop. Label every insight `confidence: "low"` and say so.
   - **Fewer than 20 real outcomes:** make only small, reversible changes.
3. Find what matters. Buckets marked `low_sample` are directional only. Compare:
   - **Signals:** which public project signals produce replies, Scans, meetings or sales?
   - **Tiers:** compare Tier A and Tier B without promoting Tier C into activation.
   - **Kernels:** compare Venture, Hardware, Research and Media only when sample sizes are sufficient.
   - **Routes:** V1 uses LinkedIn; route learning stays proposal-only until another route is approved.
   - **Hooks:** does `signal_reference` beat `role_pain` and the others?
   - **Intent:** compare the observed intent-strength bands.
4. Call `gtm_save_market_learning_proposal` with:
   - **insights:** each has `finding`, `evidence` (the actual numbers), `confidence` and `action`.
   - **weight_changes:** proposal-only multipliers where 1 is neutral, clamped to 0–3. Move them gradually: at most ±0.3 per cycle, or ±0.1 when the sample is low.
   - **playbook_markdown:** the *full* updated playbook. Change only what the evidence supports. Update §5 (hypotheses) with confirmed or rejected results and the evidence behind them. Keep it concise.
   - No source subscription or Boundary change is applied by this proposal.
   - Applying the proposal requires a separate human call to `gtm_review_market_learning`.
5. Tell the user in 3–5 bullets what changed and why.

Never overfit: one reply is not a pattern. Prefer "keep testing" over reversing a rule on thin data.
