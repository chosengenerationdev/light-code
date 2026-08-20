## Let it write tools, and teach it your codebase

Two separate things, both off by default.

**Python tools** — *Settings → Python*

The assistant can write a small Python tool that then becomes callable as `py__<name>`. Useful
for anything awkward in a shell command: parsing, data transformation, anything needing a
library.

- Dependencies go in a PEP 723 block and are installed with `uv`, from your own index if you
  configure one.
- Each tool is **pinned to a hash of the source you approved**. A file that changes on disk is
  refused and reported, never quietly reloaded.
- Tools live in `.lightcode/tools/` in your workspace, so changes land in git and get reviewed.
- Creating or updating one **always asks**, whatever else you have auto-approved.

**Skills** — *Settings → Skills*

Markdown notes about *your* codebase — conventions, where things live, how to do the thing
everyone gets wrong. Only the name and one line cost context; the body is read when needed, so
a skill can be as long as it deserves.

Explain something durable in chat and the assistant will offer to write it down.
