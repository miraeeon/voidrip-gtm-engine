---
name: gtm-classify-route
description: Classify GTM Autopilot leads (tier A/B/C/DQ, persona, intent 1-5, angle) and route each to email, LinkedIn or both, using Max signal evidence, the ICP, the playbook and learned weights. Use during the daily loop or when the user asks to classify, score, qualify or route leads.
---

# Classify & route leads

1. Call `gtm_get_classification_queue` (limit 20). It returns:
   - the seller profile and ICP;
   - the playbook, weights and recent learnings;
   - leads, each with `signal` evidence and `channels_available`.
2. For **each** lead, decide the following:
   - **tier:** A / B / C / DQ, using the playbook §1. Weights are multipliers on your prior. For example, `signal:fundraising: 1.4` means that signal has converted well, so lean one tier up when the fit is otherwise borderline.
   - **persona:** a short, reusable lowercase label, such as `cmo`, `head-of-marketing`, `agency-owner`, `bizdev-manager` or `founder`. Reuse existing labels so the analytics can group them.
   - **intent_strength:** 1–5, from the playbook scale. Judge it from the signal *content* (context, excerpt), not only from the signal type.
   - **route:** from the playbook §2. Choose what is *best*; the engine then enforces data availability. Look at `channels_available` so your choice is realistic.
   - **angle:** the one hook to lead with, grounded in this lead's signal and the seller's value proposition. Example: "they asked for agency recommendations → vetted shortlist in 48h".
   - **channel_plan:** decide *what each channel carries* for this person. It is required unless the lead is DQ.
     - `first_channel`: email or linkedin, whichever carries the first real message.
     - `email`: `{role: lead|support|none, content}`. `content` says what the email track says, for example "signal hook + 48h shortlist offer + 1 proof point, break-up on d7".
     - `linkedin`: `{role, content}`. For example, "no-pitch connect note about their post, then a question about their agency process".
     - `why`: seniority, where the signal happened (LinkedIn-born signals open on LinkedIn), deliverability, language.
     - Give the two channels **different jobs**. Don't repeat the same pitch on both. A good default for `both`: the lead channel carries the argument, and the support channel builds familiarity (visit, connect) and asks one question.
   - **reasoning:** 1–3 sentences citing the evidence.
   - **Overloop history:** read `overloop` on each lead.
     - `exists: true`: the person is already a prospect.
     - `bounced` or a bad `email_status`: the engine forces LinkedIn.
     - `replied` or `excluded`: the engine forces `none`. This person belongs to a human.
     - Previously emailed with no reply: prefer LinkedIn as the first channel and change the angle.
3. Mark as **DQ**:
   - competitors of the seller;
   - students or job seekers;
   - people selling to the seller;
   - companies in `excluded_companies`;
   - anyone with no usable channel;
   - signals that are clearly irrelevant (for example, a like on an unrelated post from someone outside the ICP).
4. Save the whole batch with `gtm_save_classifications`.
   - Check `rerouted`: the engine may switch channels when data is missing. That's expected.
   - Fix any `errors` and re-save.
5. Repeat until `remaining_in_queue` is 0.

Be decisive and sceptical. Max's `icp_score` is a hint, not a verdict. The ICP is used for scoring and is not a filter, so many sourced leads will legitimately be C or DQ.
