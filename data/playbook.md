# VOIDRIP Activation Playbook V1

> Operational rules for turning one qualified `Person + Project` into a reviewed LinkedIn sequence. This playbook never changes the GTM Boundary and never authorizes import, enrollment, activation, or sending.

## 1. Entry gate

A candidate reaches activation review only when every condition is true:

- the latest Boundary status is `PASS_OUTBOUND_V1`;
- the project is named, real, visible, and supported by verifiable evidence;
- the project is aligned with the person's professional LinkedIn identity;
- the person's strategic authority is sufficient;
- all personalization variables are grounded in public evidence;
- no exclusion, previous reply, or no-contact rule applies;
- Jen explicitly marked the prospect as validated in the review sheet.

If one condition is missing: no final draft, no HeyReach import, and no contact. `PASS_MARKET_ONLY`, `HOLD_EVIDENCE`, and `FAIL_BOUNDARY` never enter activation.

## 2. Priority and intent

| Tier | Meaning | Action |
|---|---|---|
| **A** | `PASS_OUTBOUND_V1` plus explicit current evidence of an unresolved structural need; intent 4–5 | First calibration cohort after human approval |
| **B** | `PASS_OUTBOUND_V1` plus explicit but weaker or incomplete evidence of an unresolved structural need; intent 2–3 | Small, manually selected calibration batch only |
| **C** | Outbound FIT is valid but activation timing is stale, unknown, or fit-only; intent 1 | Keep in the Market Map until a stronger signal appears |
| **DQ** | Excluded, already replied, unusable channel, identity conflict, or human no-contact decision | Route `none`; never draft or contact |

Intent scale: 5 = explicit search for a structural answer; 4 = active visible structural tension; 3 = explicit structural phase transition; 2 = explicit but incomplete evidence of a current unresolved structural need; 1 = FIT only. Freshness remains separate: `CURRENT`, `RECENT`, `STALE`, or `UNKNOWN`. MVP activity, product launch, product feedback, company pages and Y Combinator pages are Market Map evidence only and never raise intent by themselves. Current Y Combinator participants are excluded from activation.

## 3. Channel rules

- V1 is LinkedIn-only through HeyReach.
- The only campaign target is `623081 — VOIDRIP — BOFU — Invitation + M1–M5`.
- The engine never creates a replacement campaign or list.
- Without a usable personal LinkedIn profile aligned with the project, route `none` for Outbound V1.
- Sender and schedule must be verified before any launch approval.
- Email and multichannel routes are outside this first cohort.

## 4. Official cadence

- Connection request: no pitch. If not accepted, end after 30 days.
- M1, 3 hours after acceptance: precise project, platform, and first public observation.
- M2, 1 day later: a distinct second observation and one question about why the project started.
- M3, 2 days later: VOIDRIP founder story, value proposition, and relevance question.
- M4, 4 days later: free System Scan with one link.
- M5, 3 days later: Crash Test #1, a discount offer without an invented amount, and an easy out.
- End the sequence 1 day after M5 when there is no reply.

`SEQUENCE MESSAGES LINKEDIN V2` is the copy authority. Do not rewrite M1–M5 without explicit approval.

## 5. Required personalization

- `firstname`: verified first name;
- `specific_project`: public project name;
- `platform`: the public source actually observed;
- `specific_observation`: factual M1 observation;
- `specific_observation_2`: a distinct factual M2 observation.

Need Territories guide market understanding; they are never presented as observed facts about a person. No unresolved placeholder may reach HeyReach.

## 6. Claims discipline

Allowed in the exact official context:

- VOIDRIP connects project vision, structure, and technical specifications usable by AI agents;
- the System Scan is free and reads how a person handles complexity;
- Crash Test #1 is VOIDRIP's first deep structural audit;
- a discount may be offered without an amount only while the commercial offer is still true.

Forbidden without approved proof: performance figures, multipliers, customer claims, guaranteed outcomes, personal diagnosis, urgency, scarcity, invented mutual connections, or unconfirmed product capability.

## 7. Mentionable signals

Mentionable:

- a publicly identified project, product, research program, or artistic universe;
- a public post, comment, launch, milestone, or recent description;
- an observation directly verifiable on the named platform.

Never mention:

- FIT score, tier, Market Map status, or internal reasoning;
- a Need Territory as if it personally describes the prospect;
- website visits, private data, scraping method, or technical source provenance;
- competitor relationships, unverified inference, or internal-only evidence.

## 8. Kernel rules

- **Venture:** project structure, ambition, dependencies, and next milestone.
- **Hardware:** system integration, physical constraints, and prototype-to-execution transition.
- **Research:** translation between research, operating system, and implementation.
- **Media:** start from the visible project or artistic universe; observe coherence, world, formats, and production complexity.

M1–M5 remains common to all four Kernels. Only the verified angle and observations vary until real results justify a separate sequence.

## 9. Stops and approvals

- Any reply stops automation and moves the prospect to human review.
- Connection acceptance is not a positive reply and does not change FIT.
- Preparation always runs with `SEND_MODE=locked`.
- Adding leads to HeyReach requires a distinct explicit approval in the current session.
- Starting or resuming the campaign requires a second distinct explicit approval in the current session.
- Even in live mode, every `SEND_CAPABLE` call requires `allowSend=true` for that call.
- Return to locked mode after an authorized action.

## 10. Results and learning

Measure acceptance, reply, positive reply, System Scan start, and sale separately. Compare results by SourceLane, Kernel, tier, intent, freshness, angle, and message. Simulated outcomes never count as real learning. Results may update activation rules and copy, but never rewrite the Boundary automatically.
