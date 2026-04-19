---
name: Team Room — no failing tests before moving on, ever
description: Any test failure is a hard stop on all downstream work, including milestone close, brainstorms, and next-phase planning. Failing tests are the only work until they pass
type: feedback
---

Any failing test is a hard stop on all downstream work. Do not propose, tee up, or begin any next-phase activity — including milestone close, retrospectives, brainstorms, or planning the next milestone — until every test passes. If tests are failing, fixing them is the only work.

This stands even when the failures look "environmental" or "unrelated to what we were just doing." The discipline is: investigate before categorising. A test that's supposed to pass and doesn't is telling you something, and the category ("the real service is down," "my changes broke an unrelated flow," "the test is wrong," "production is broken") is only known after investigation — not before.

**Why.** Failing tests that are waved off as environmental are almost always one of three things, none benign: (a) a real regression the rationalisation is hiding, (b) a test bug that should be fixed so the suite is trustworthy again, or (c) a pre-existing failure that's been normalised into the background. All three compound. Treating failures as advisory signals that tests are advisory — and at that point the suite stops being a safety net.

Concrete M2 incident: after the Phase-3 cleanup batch landed, the test suite reported 138/140 passing with two LM Studio integration failures. I declared the milestone close-out done and teed up the M3 brainstorm, dismissing the failures as "needs LM Studio running locally." LM Studio was running. Investigating the failures took ~3 minutes and revealed two real bugs: (1) `isLmStudioReachable` used `fetch().ok` which only accepts 2xx, failing when LM Studio returned a legitimate 401 from `/v1/models`; (2) integration tests capped `max_tokens: 30` which is below the reasoning budget for `qwen/qwen3.5-9b` — the model would exhaust the cap mid-thought and return empty `content`. Both would have blocked the smoke test when someone actually ran it.

**How to apply.**
- When `npm test` reports *any* failure, do not propose next steps. The response is always "investigate the failure first."
- Resist the urge to categorise a failure as environmental before reading it. "I think LM Studio might not be running" is a hypothesis to verify (run the curl, ask the user), not an explanation to accept.
- When reporting a test run to the user, never soften "N failing" to "looks good except for N environmental failures." State the failure count and investigate.
- This rule compounds with `feedback_teamroom_no_skipped_tests`: together they say "every test runs every time, and every failure gets fixed before we move on."
