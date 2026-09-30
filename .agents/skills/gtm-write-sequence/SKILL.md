---
name: gtm-write-sequence
description: Write, self-critique and finalize candidate-specific multichannel outreach sequences for VOIDRIP, using verified evidence as the hook, then save inert drafts through the configured execution adapter. Use during the daily loop or when the user asks to write, draft, rewrite or improve outreach sequences.
---

# Write sequences

Call `gtm_get_drafting_queue` (limit 8). Every lead comes with:
- signal evidence;
- its classification (tier, persona, intent, route, angle);
- the seller profile, the playbook and the route template;
- winning examples from past replies;
- any current draft and its lint results.

## For each lead

### 1. Draft
Follow the lead's **`channel_plan`**:
- The first message must be on `first_channel`. The lint blocks it otherwise; a `linkedin_visit` before it is fine.
- The email steps say what `channel_plan.email.content` describes.
- The LinkedIn steps say what `channel_plan.linkedin.content` describes.
- A channel with role `none` gets no steps.

Then follow the route template for the lead's `route`. The route decides which step types you may use:
- `email`: `email` steps only.
- `linkedin`: `linkedin_visit`, `linkedin_invite` and `linkedin_message` only.
- `both`: must mix both channels.

Step shapes:
- `{"type":"email","delay_days":0,"subject":"…","body":"…"}`: plain text, with blank lines between paragraphs.
- `{"type":"linkedin_visit","delay_days":0}`
- `{"type":"linkedin_invite","delay_days":1,"note":"…"}`: 300 characters or fewer, with no pitch and no link.
- `{"type":"linkedin_message","delay_days":3,"message":"…"}`

`delay_days` is the wait *after the previous step*.

### 2. Self-critique
Check the draft against this rubric and fix anything that fails:
1. **Signal hook:** does the first touch reference what this person did or what happened, using only facts from the lead data?
2. **Only-them test:** could this opener be sent to anyone else unchanged? If so, rewrite it.
3. **Bridge:** is the link from the signal to the seller's value made in one plain sentence?
4. **CTA:** is there one low-friction question, with no calendar link in email 1?
5. **Length and tone:** does it respect the playbook limits? It must have no clichés, no hype, no exclamation marks in subjects, and no signature.
6. **Follow-ups:** does each follow-up add something new (an insight, a proof point from the seller profile, or a new angle)?
7. **Truth:** is every claim in the seller profile or the lead data? No made-up numbers, customers or mutual connections.

### 3. Save
Call `gtm_save_sequence` with `{ lead_id, angle, hook_type, steps, critique, status: "final" }`.
- `hook_type` is one of `signal_reference`, `company_trigger`, `role_pain`, `peer_proof`, `competitor_context`, `question`, `other`. Tag it truthfully, because the learning loop compares hooks.
- Put a one-line summary of what you checked or changed in `critique`.
- If the response has lint **errors**, fix them and save again. **Warnings** are judgment calls: fix them unless you have a reason not to.

Repeat until the queue is empty.

## Style
- Write like a sharp peer, not a vendor. Use short sentences and specifics.
- Match the prospect's language when their location makes it obvious.
- Use the seller profile's `primary_cta`, `tone` and `do_not_say`.
- If the seller profile lacks a value proposition or proof points, keep claims generic and truthful. Also tell the user which facts to add.
