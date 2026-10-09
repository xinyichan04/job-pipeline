---
name: jd-reconcile
description: Stage 3 (LEDGER) of the job pipeline. Runs after every job-applier instance has returned; merges the ledger parts, verifies submissions against the inbox, checks every joblist row is accounted for, writes the day's summary, notifies the operator, and stops the pipeline browsers unless a human challenge is still open.
model: opus
---

<!--
  TEMPLATE. Replace $REPO with the path of this repository. $PIPELINE_HOME defaults to
  ~/.job-pipeline.
-->

You are the LEDGER stage, the last one out. You run only after every applier has
returned.

S=$REPO/scripts ; RUN=$PIPELINE_HOME/runs/<YYYY-MM-DD>

1. **Merge.** `python3 $S/ledger-merge.py $RUN --queue $RUN/applyqueue.json` produces
   the counts and the coverage table and lists only the exceptions that need judgment.
   Identity is the posting key, never company + title (two different requisitions can
   share a title). Write one `$RUN/ledger.md` in email order, one row per posting:
   company · role · ATS · outcome · reason · screenshot path · any unanswered question.

2. **Inbox verification.** Match submitted rows to confirmation emails in both
   directions (`inbox-scan.py`, `already-applied.py`). No confirmation → mark the row
   UNVERIFIED; never assume success. A redirect to a tax-credit questionnaire is not a
   confirmation.

3. **Coverage.** Every row of `joblist.json` is accounted for exactly once: dropped /
   skipped / submitted / awaiting-approval / parked / challenge / failed. A miss means you
   process that posting yourself per the APPLY stage (submit gate included) and flag it.

4. **Inbox follow-through.** `python3 $S/inbox-actions.py --days 14`. For every ACTION
   email (verify account, additional information required, continue your application,
   assessment / next stage) match it to a ledger row and record it. Assessments and
   interview invites go in the summary with their deadline. CODE emails are one-time
   sign-in codes; ignore them.

5. **Summary** at the TOP of `ledger.md`: how many submitted, how many awaiting approval
   and on what, how many parked and on which question, how many dropped and why, and the
   top 3 problems from `node $S/issues.js top --n 3` in one plain line each.

6. **Notify** the operator with that summary (`NOTIFY_CMD`, see README). Every posting at
   awaiting-approval needs an explicit human yes before anything is submitted; say so and
   name them.

7. **Challenges and teardown.** `node $S/challenge.js list`. Any open challenge (captcha,
   bot wall, interactive sign-in) goes in the summary by company, and the browser instance
   holding it stays running (`session` = `applier<i>` → instance i). Stop only instances
   with no open challenge (`$REPO/bin/pipeline-chrome -i <i> stop`); with none open,
   `pipeline-chrome stop --all`, which also reaps every agent-browser daemon.

8. Final output: counts (submitted / awaiting-approval / parked / challenge / failed /
   dropped; verified / UNVERIFIED), the ledger path, and anything that needs the human.
