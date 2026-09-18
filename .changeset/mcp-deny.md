---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

Calls an MCP server may never make

Asked for in these terms: the assistant may fill a web form and click Next, but must not click the
final submit — the person reviews and submits.

Guidance alone cannot promise that, and a heuristic that tried to *recognise* a submit button would
be wrong often enough to be dangerous while sounding certain: plenty of forms submit from a `div`,
or a button labelled Confirm, or the Enter key. So the rule is **declared, never inferred** — the
same reasoning as the exact-match command allowlist and `--allow-host`. Where being wrong is
expensive, the product does not get to be clever.

On any MCP server:

    "deny": [{ "tools": ["click"], "contains": "submit", "reason": "You review and submit." }]

Matched against the call's arguments as JSON, so it catches a selector, a visible label, an element
id or a URL without the rule knowing which field that server uses. Substrings rather than patterns,
because a regular expression typed into a settings box fails *open* when it is subtly wrong and
nothing says so.

**Checked where the call leaves for the server** — not in the loop, and not in the approval gate.
Both of those can be auto-approved, and a rule written to mean "never" must not be satisfiable by
ticking a box. Read at call time, so an edit applies to the next call rather than after a restart.

What it honestly is: a reliable guard against what the model would ordinarily do. What it is not: a
defence against an adversary, since a determined model could phrase a call the rule does not match.
The approval gate remains the thing that cannot be talked past, and this is written into the module
rather than left for somebody to discover.
