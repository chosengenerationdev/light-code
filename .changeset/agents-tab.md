---
'light-code-vscode': minor
---

Settings → Agents: a team, not one expert

The Expert tab is now Agents. Five roles — expert, programmer, reviewer, tester
and librarian — each answered by a model you assign. Claude is still detected and
is still the default expert where it exists, but it is a default now: any role can
go to any provider you have configured, the expert included.

Every role has a system prompt you can read and edit, because a role is mostly its
prompt — the difference between a useful reviewer and a flattering one is a few
sentences about what to look for. An edited prompt is stored only when it differs
from the default, so improvements to the defaults still reach you.

A checkbox says whether what consultations cost is worth managing. With it off
there is no budget shown at all, because only a Claude consultation reports a
price and a cap over an unmetered gateway would look like protection without being
any.

Junior mode is now Agent team. The assistant consults specialists on its own
without being asked, and the judgement it uses about when that is worth it is
editable in the same tab — the list of who exists is added automatically, so
editing the advice never leaves it naming somebody who is no longer assigned.

Each role gets a colour in Appearance, for the reason the expert had one: a review
and a test plan arriving in the same colour are two voices presented as one.
