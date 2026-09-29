# GTM Playbook

> The living rulebook the agent follows to classify, route and write. The learning step rewrites it
> from real results (versioned in the database, v1 = this seed). Keep it short, concrete, testable.

## 1. Who we contact (classification)

| Tier | Meaning | Rule of thumb |
|---|---|---|
| **A** | Strong fit **and** fresh, specific signal | Title matches ICP buyer, company matches ICP, signal < 14 days old and about a problem we solve |
| **B** | Good fit, weaker or indirect signal | ICP title/company, generic engagement (liked a post, ICP-match top-up) |
| **C** | Partial fit | Adjacent title or company outside ICP size/industry, but plausible |
| **DQ** | Do not contact | Competitor, student/job seeker, vendor selling to us, existing customer, no usable channel, excluded company |

- `intent_strength` 1–5: 5 = explicitly asking for what we sell; 4 = engaging with a direct pain; 3 = relevant company trigger (funding, hiring, new role); 2 = generic engagement; 1 = ICP-only.
- Prefer precision over volume: when in doubt between B and C, pick C; between C and DQ, pick DQ.

## 2. Channel routing

| Situation | Route |
|---|---|
| Signal happened **on LinkedIn** (comment, reaction, connection, post) and profile available | `linkedin` or `both` — meet them where the signal happened |
| Tier A with valid email **and** LinkedIn | `both` (multichannel lifts reply rate) |
| Company trigger (funding, hiring, registration, tender) with valid email | `email` |
| No valid email | `linkedin` (engine enforces) |
| No personal LinkedIn profile | `email` (engine enforces) |
| Senior exec (C-level, founder) at 200+ employees | `linkedin` first — email gatekeeping is heavy |

## 3. Writing rules (every sequence)

1. **The signal is the hook.** The first touch names what they did or what happened ("your comment on…", "saw you're hiring 3 SDRs…"). Never invent details that are not in the lead data.
2. **One person, one message.** If the opener could be sent to someone else unchanged, rewrite it.
3. **Relevance bridge in one sentence**: connect the signal to a problem the seller solves, using the seller profile only.
4. **One low-friction CTA**, phrased as a question (offer a resource, a 1-pager, or "worth a look?"). No calendar links in email 1.
5. **Short.** Email 1 ≤ 120 words, follow-ups ≤ 80, LinkedIn note ≤ 300 chars with no pitch, LinkedIn message ≤ 80 words.
6. **Plain, human tone.** No "I hope this finds you well", no hype words, no exclamation marks in subjects, at most one link, no signatures (Overloop adds them).
7. **Subjects:** 2–6 words, lowercase feel, specific ("your post on agency briefs"), never clickbait.
8. **Follow-ups add something new** (insight, proof point, different angle). Never "just bumping this".
9. **Break-up email** (last step): short, gives an easy out, keeps the door open.
10. **Language:** write in the prospect's language when the location makes it obvious (FR/NL/DE/ES), otherwise English.

### Signal sensitivity — what you may say out loud

| Signal | Mention it explicitly? | How to use it |
|---|---|---|
| Public post / comment / social mention | ✅ Yes — quote the topic, not the whole text | Open with their point, add a view |
| Funding, M&A, hiring, job offers, new company, tender | ✅ Yes — it's public news | Congratulate briefly, bridge to the scaling problem it creates |
| Job change (new role) | ✅ Lightly ("congrats on the new role at X") | First-90-days priorities |
| Company-page / influencer engagement (reactions) | ⚠️ Topic only ("you seem to follow X topic") | Lead with the topic, never "I saw you liked…" |
| **Competitor relationships** (connected with a competitor's sales team) | ❌ Never | Timing signal only: they're likely evaluating the category — lead with the role pain + one sharp differentiator |
| **Website visit (radar)** | ❌ Never ("I saw you on our site" is creepy) | Timing signal only: lead with their company context and the most likely reason to look |
| ICP match (atlas-icp) | n/a (no event) | Pure fit — lead with a specific observation about their company |

### Claims discipline (learned 2026-09-28)

- Numbers, multipliers and comparisons ("2x", "double", "far more replies", "35%") are allowed **only** when they appear in the seller's `proof_points`. The lint flags any other claim.
- Prefer a concrete idea for their business ("target companies hiring X") over a performance promise.

### Channel plans (learned 2026-09-28)

- Give each channel a different job: the lead channel carries the argument, the support channel builds familiarity (visit, no-pitch connect) and asks **one** question.
- Senior people (VP+) at 200+ employees and leads without email: LinkedIn-only plans, 3 touches max.

## 4. Sequence templates by route

- **email:** d0 signal-hook email → d3 value/insight email → d7 break-up.
- **linkedin:** d0 profile visit → d1 invite (note references the signal, no pitch) → d3 message (value + question) → d7 short nudge.
- **both:** d0 visit + d0 email (signal hook) → d1 invite (short note) → d3 email (value) → d5 LinkedIn message → d7 break-up email.

## 5. Current weights & hypotheses

- Hypothesis H1: signal-reference hooks beat role-pain hooks by 2×.
- Hypothesis H2: LinkedIn-born signals convert better on LinkedIn than email.
- Hypothesis H3: tier A multichannel (`both`) beats single channel.

(The learning step confirms or rejects these with data and records the evidence here.)

**Status 2026-09-28 (test run, simulated outcomes):** 15 leads contacted in simulation, 0 replies, 6 opens, 1 bounce.
H1–H3 remain **untested** — sample far too small (need ≥ 30 contacted per bucket). Keep all three running.
