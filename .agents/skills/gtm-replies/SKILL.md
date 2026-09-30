---
name: gtm-replies
description: Handle prospect replies for VOIDRIP GTM — detect replies from the execution adapter, fetch their text from an authorized mailbox connector or the user, classify each, draft the answer and apply safe follow-ups. Use during the daily loop or when the user asks about replies, the inbox, or who answered.
---

# Handle replies

Overloop's public API tells us **that** someone replied, through reply counts on the prospect. It does not tell us **what** they said. You close that gap.

1. **Detect.** Call `gtm_sync_results`, which also detects replies, then `gtm_get_reply_queue`.
2. **Fetch missing text.** For each item in `needs_text`:
   - If a mailbox tool is available (Gmail or Outlook MCP), search for the prospect's latest message. For example, Gmail: `from:<prospect email> newer_than:14d`. Pass the body, without quoted history, to `gtm_ingest_reply` with that `reply_id`.
   - For LinkedIn replies, or when there's no mailbox access, list the names for the user and ask them to paste the text. `gtm reply-add --lead <id> --text "…"` also works.
   - Never guess what someone said.
3. **Triage.** For each item in `to_triage`, call `gtm_save_reply_triage` with the following:
   - `category`:
     - `interested`: wants a call or demo, or says "send it over".
     - `question`: asks something before deciding.
     - `objection`: price, timing, "we already use X".
     - `not_now`: set `follow_up_on`.
     - `referral`: fill in `referral`.
     - `not_interested`
     - `unsubscribe`: any "remove me" or "stop" request, however polite.
     - `out_of_office`: set `follow_up_on` to the day after their return.
     - `wrong_person`
     - `other`
   - `sentiment`, `summary` (one line) and `next_action` (a concrete step for the human).
   - `draft_response`. Write it in the prospect's language, short and human, and answer their actual words.
     - For questions, answer only from the seller profile. If the answer isn't there, say you'll confirm, and tell the user what to add.
     - For interested prospects, propose 2 time windows or ask for theirs, and use the seller's `primary_cta`.
     - For objections, acknowledge the point, give one relevant proof point and offer an easy next step. Don't argue.
     - For referrals, thank them and ask permission to mention them.
     - Write no draft for `unsubscribe` or `out_of_office`.
   - `meeting_booked`: true only when a time is confirmed.
4. **Check the safe actions.** The engine runs them automatically:
   - exclusion list for unsubscribe, not interested and wrong person;
   - stop the sequence when a human answered;
   - assign the Overloop conversation for hot replies.

   Read `actions` in the response and report any failures.
5. **Summarize for the user.** List hot replies first, each with its drafted answer, and say what was handled automatically.
   - **Never send an answer yourself.** Humans send replies from Overloop or their mailbox.
   - When the user confirms they handled one, call `gtm_resolve_reply`, using `outcome: "meeting_booked"` if a meeting was booked.
