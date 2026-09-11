---
'light-code-vscode': minor
---

Set a plan for a conversation

A button under the input field takes a plan for the chat you are in — what this
conversation is for. It sits in the assistant's prompt for the whole task, so it
is exactly as present at step twenty as at step one, where a first message has
long since been buried under tool results.

It does more than state the goal. The assistant is told to check each step against
the plan before taking it, to report an unrelated improvement rather than make it,
to say so rather than quietly substitute a better plan of its own, and to account
for the plan when it reports completion — what is done, what is not, and anything
it did that the plan did not ask for.

The plan belongs to the conversation: it is saved with it, comes back when you
reopen it from history, and a new chat starts without one.
