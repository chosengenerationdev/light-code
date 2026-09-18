---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

A skill can carry pictures, and they are findable by what they show

Asked for with a concrete use: a screenshot of a form field, with what goes in it, kept so the
assistant can use it later.

`write_skill` takes `images` — a source path, a required `alt`, and an optional `description`. The
files are copied in beside the skill and the skill becomes the `name/SKILL.md` folder layout, which
is the layout §13 already reads and the only one with somewhere to put them. A skill that is
already a folder stays one, and a flat file left over from before is removed after a successful
write — both would load under one name and the search path would silently pick one.

**On indexing, the simpler answer is the better one.** A multimodal embedding would need a second
embedder and a second vector space, and §19 records what happens when vectors from different models
mix: confident, plausible, wrong neighbours with no error anywhere. Describing the image and
embedding the description avoids that — and the cleanest version builds no pipeline at all, because
**the description belongs in the skill's own markdown**. There it is indexed by the machinery that
already exists, found by `search_docs` for free, and read by anyone who opens the skill, including
a colleague whose copy cannot render images.

So: one embedding type, no image index, nothing to keep in sync.

The cost is stated rather than hidden: a description is written once and the picture can change
under it. That is why `alt` is required — something has to stay true when nobody refreshed the
prose — and why the description is ordinary visible markdown, so it can be corrected.

Sources go through the same path check as `read_file`, so the deny list and the workspace boundary
apply; names are reduced to one safe segment; 2 MB and twelve pictures each, because a skill is an
illustrated page and not an asset library.
