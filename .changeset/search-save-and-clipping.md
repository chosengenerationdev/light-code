---
'light-code-vscode': patch
---

Fix OpenSearch settings appearing not to save, and explain truncated log results.

**A failed save looked exactly like a successful one.** The connection form closed the
instant Save was pressed, before the host had written anything, and any error was routed to
a banner that only the chat view rendered — so a rejected save closed the form, discarded
what you typed, and said nothing. Three fixes: errors now render in every view, the form
stays open until the host confirms the write reached disk, and the numeric limits show their
allowed range and flag an out-of-range value in place. The most likely trigger was raising
"Maximum results" past its ceiling of 100, which failed validation invisibly.

**Truncated log messages are now explained and adjustable.** Long field values were cut at
500 characters with a bare `…`, which reads as "the message ends here" — so the model
reported the logs as truncated without being able to say why or do anything about it. The
cut is now labelled with the full length, the result names which fields were affected and
what to do, and **Longest field value** in Settings → Search makes the limit configurable
(50–20,000). Worth raising for a log index whose messages carry stack traces: unlike the
overall result cap, this cut cannot be recovered with `read_tool_result`.

Every query limit also has a tooltip explaining what it protects against and what raising or
lowering it costs.
