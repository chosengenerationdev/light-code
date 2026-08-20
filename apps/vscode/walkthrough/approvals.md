## Nothing happens without you

Before Light Code writes a file or runs a command, it asks — and it shows you **exactly**
what will happen, never its own description of it:

- a command appears as the literal string that will be executed;
- an edit appears as a real diff against the file on disk;
- a new file appears as the file itself.

**Deny is a real answer.** The model is told you refused and carries on with something else,
rather than stopping dead.

If you get tired of approving the same thing, use **Always allow** on the prompt. Two things
worth knowing about that:

- Commands match **byte for byte**. Allowing `npm test` allows exactly that — `npm test && rm -rf /`
  is a different string and still prompts.
- Everything you have allowed is listed in **Settings → Approvals**, with a Revoke button.
  That tab is the undo for standing grants; it is worth a look now and then.

Writing a Python tool or a skill always asks, whatever you have allowed — those install code
that runs later, which is not the same as changing a file.

Made a mess? **Undo** in the chat rolls the whole task back, using a snapshot taken before the
first edit. Your own git history is never touched.
