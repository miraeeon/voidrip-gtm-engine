---
name: gtm-learn
description: Learn from GTM Autopilot outreach results — sync Overloop engagement, analyze reply/positive/meeting rates by signal, tier, persona, route and hook, then feed the intelligence back by updating the playbook, weights and Max signal subscriptions. Use during the daily loop or when the user asks what's working, to analyze results, or to improve targeting and messaging.
---

# Learn from results

1. Call `gtm_sync_results`, then `gtm_get_performance`.
2. Read `data_quality` first.
   - **Simulated outcomes present:** this is a dry run of the learning loop. Label every insight `confidence: "low"` and say so.
   - **Fewer than 20 real outcomes:** make only small, reversible changes.
3. Find what matters. Buckets marked `low_sample` are directional only. Compare:
   - **Signals:** which Max signals produce replies or meetings, and which produce nothing?
   - **Tiers:** do A-tier leads outperform C-tier? If they don't, the classification criteria are off.
   - **Routes:** how do `both`, `linkedin` and `email` compare, per signal type?
   - **Hooks:** does `signal_reference` beat `role_pain` and the others?
   - **Personas:** which titles reply?
   - **Examples:** read `replied_examples` against `no_reply_examples`. What do the winners do differently in the first line, the CTA and the length?
4. Call `gtm_save_learnings` with:
   - **insights:** each has `finding`, `evidence` (the actual numbers), `confidence` and `action`.
   - **weights:** multipliers where 1 is neutral, clamped to 0–3. Move them gradually: at most ±0.3 per day, or ±0.1 when the sample is low.
   - **playbook_markdown:** the *full* updated playbook. Change only what the evidence supports. Update §5 (hypotheses) with confirmed or rejected results and the evidence behind them. Keep it concise.
   - **subscription_changes:** create signals that resemble the winners, and pause signals that have produced more than 30 contacts with zero replies.
     - Set `apply_subscription_changes: true` only when the user has allowed signal changes. Otherwise leave it false and they stay suggestions.
5. Tell the user in 3–5 bullets what changed and why.

Never overfit: one reply is not a pattern. Prefer "keep testing" over reversing a rule on thin data.
