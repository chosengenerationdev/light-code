# Feature animations

Eight looping diagrams, one per capability. Generated, never hand-drawn — see
`scripts/generate-feature-gifs.py` and `scripts/generate-team-skills-gif.py`, which share
`scripts/gifkit.py`. Regenerate with:

```bash
pip install Pillow
python scripts/generate-feature-gifs.py
python scripts/generate-team-skills-gif.py
```

They are **not** built by `pnpm build` and not checked in CI, so nobody installing this repository
gains a Python dependency.

## The rule

Every caption is a claim about the product, and each was checked against the code before it was
drawn. A diagram that overstates is worse than none: it gets believed, it gets shown to other
people, and nothing fails when it stops being true. When a mechanism changes, edit the generator —
the diff then shows what the picture now claims, which a replaced binary never could.

| File | What it claims | Where that lives |
|---|---|---|
| `skills-from-wiki.gif` | A wiki page becomes a skill; the skill is embedded; semantic search finds it later | `write_skill`, `embedder`, `search_docs` |
| `team-skills.gif` | Everyone writes their own skills and one alias spans them, plus the three ways skills reach a team | §12g, `skills.paths`, `s3.skills`, `embedder.skillsAlias` |
| `python-tools.gif` | A Python tool is written, approved, published, and reviewed by each colleague before it runs | §13, `create_python_tool`, `s3.tools` |
| `form-filling.gif` | A skill holds the procedure, an MCP server acts, and a deny rule stops the final submit | `mcp` `deny`, §18 |
| `scheduled-logs.gif` | Scheduled runs leave logs in a cluster, and they are read back and answered | §9b, `search_opensearch` |
| `excel-investigation.gif` | It attaches to an open workbook and traces a formula to the cell that broke it | §12c, `excel_trace_cell` |
| `technical-diagrams.gif` | It reads a page or a repository and draws the flow it found | `show_diagram` |
| `mail-insights.gif` | Chosen Outlook folders are indexed on a timer, and questions are answered as charts | §12f, `mail.syncMinutes`, `show_chart` |

## Presenting them

A GIF cannot be paused — PowerPoint plays one start to finish with no scrub bar and no stop. So
`slides/` holds each animation cut into its own beats: every segment plays once, stops on its last
frame, and waits there while you talk. See [slides/README.md](slides/README.md).

## Both sharing animations end on a comparison

Because "the team's tools appear" and "the team's skills appear" look identical from the outside
whichever route produced them, and the routes are not equivalent.

`python-tools.gif` ends on **bucket vs shared folder**. Both make the tools available. A bucket
copies the `.py` files to your own disk, so the approval registry beside them is yours and each
person approves for themselves. A shared folder is the same folder for everyone, registry
included — the maintainer's approval is already in the file you read, so nobody else is asked, and
two people writing at once race that one file. Neither is wrong; one has a checkpoint and the
other is shared trust.

`team-skills.gif` ends on **shared folder vs bucket vs shared pool**, and the honest news there is
that all three work. The first two put the *files* in your skill search path (`skills.paths` and
`s3.skills`); the third puts the *meaning* in an index and hands back the body
(`embedder.skillsAlias`). None of them asks you to approve anything — a skill is prose, not code —
which is a fact about skills rather than about those routes being safer, and it is why a shared
skill is worth reading in git.

## Three claims that were corrected before being drawn

These are the interesting ones, because the first description of each was wrong in a way that
would have been believed:

- **Light Code does not fill forms.** There is no browser tool and §18 says there never will be —
  browser access is a user-configured MCP server. So the skill holds the *procedure*, the MCP
  server does the acting, and the thing worth showing is the `deny` rule: a final submit is never
  clicked. It is declared and never inferred, because a heuristic that tried to *recognise* a
  submit button would be wrong often enough to be dangerous while sounding certain.
- **Light Code ships no log shipper.** `search_opensearch` is read-only by construction; no model
  action can create, modify or delete an index. A scheduled run's output reaches the cluster
  through a tool configured to put it there, and what the diagram shows on the Light Code side is
  the *reading*.
- **Python tools were not shared across a team, and the animation said they were.** That one got
  past the check and shipped. `s3.tools` synced the `.py` files down and the panel reported where
  they landed, but `PythonManager` read one folder and nothing loaded them. It is built now, and
  the scene's last beat is deliberately *not* "everyone has everyone's": a colleague's tool arrives
  **unapproved**, because each folder carries its own `.registry.json` and approval is per machine.
  Drawing it as instantly available would overstate it in the direction that matters most — this is
  executable code arriving from a bucket.
- **A skill's reference files are not embedded.** Only its text is. That is the whole reason
  `use_skill_file` copies a file rather than reading it, and a picture implying otherwise would
  teach the opposite of how it works.

Names, hostnames and sample data are invented, and must stay invented.
