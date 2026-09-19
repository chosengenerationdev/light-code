---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

Share settings with the team, reference files in skills, Excel authoring, and Auto mode

- **Export and import settings by section.** Both buttons now open a chooser: on the way out it
  says what each section holds ("3 providers", "2 MCP servers") and who will have to enter which
  credentials; on the way in it shows what a colleague's file contains before anything changes.
  Approvals and per-project overrides are never shared.
- **A skill can carry reference files** — a spreadsheet template, a starting config — kept beside
  it and described in it. `use_skill_file` copies one into the workspace to work on, leaving the
  skill's original untouched. The files themselves are never indexed.
- **Excel can create and save workbooks, and manage sheets**: `excel_create_workbook`,
  `excel_save_workbook` and `excel_sheets` (list, add, rename, delete, copy, move). All three
  always ask, and deleting a sheet shows what is on it first.
- **Auto mode**: the assistant works through the terminal by preference — reading, searching and
  making mechanical changes with commands — keeping the file tools for edits worth reading as a
  diff. Its shell edits are covered by the task checkpoint like any other.
- Fixes a bug where writing the first skill with pictures into an empty skills folder failed.
