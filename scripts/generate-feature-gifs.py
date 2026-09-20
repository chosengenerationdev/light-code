#!/usr/bin/env python3
"""Draws the seven feature animations in `docs/gifs/`.

    pip install Pillow
    python scripts/generate-feature-gifs.py

Run by hand, not in CI and not part of `pnpm build`, so nobody installing this repository gains a
Python dependency. Shared drawing lives in `gifkit.py`.

## The rule these have to keep

**Every caption is a claim about the product, and each one was checked against the code before it
was drawn.** A diagram that overstates is worse than no diagram: it is believed, it is shown to
other people, and nothing fails when it stops being true. Three of these needed correcting from
what was first described, and the corrections are the interesting part:

- **Filling a form is not something Light Code does.** There is no browser tool and §18 says there
  never will be — browser access is a user-configured MCP server. So the skill holds the
  *procedure*, an MCP server does the acting, and the thing worth showing is `deny`: the rule that
  a final submit is never clicked. It is declared and never inferred, because a heuristic trying to
  recognise a submit button would be wrong often enough to be dangerous while sounding certain.
- **Light Code ships no log shipper.** `search_opensearch` is read-only by construction — no model
  action can create, modify or delete an index. So a scheduled run's output reaches the cluster
  through a tool that was configured to put it there, and what is drawn on the Light Code side is
  the *reading*.
- **A skill's reference files are not embedded.** Only its text is. That distinction is the whole
  reason `use_skill_file` copies rather than reads, and a picture implying otherwise would teach
  the opposite.

Names, hostnames and sample data here are invented and must stay invented.
"""

from __future__ import annotations

from pathlib import Path

from gifkit import (
    AMBER,
    BG,
    BLUE,
    BORDER,
    Canvas,
    F_BODY,
    F_CHIP,
    F_MINI,
    F_MONO,
    F_MONO_S,
    F_NAME,
    F_SMALL,
    FAINT,
    GREEN,
    HEIGHT,
    MUTED,
    ORANGE,
    PANEL,
    PURPLE,
    RED,
    SUNKEN,
    TEXT,
    WIDTH,
    blend,
    ease,
    latest,
    pulse,
    ramp,
    write_gif,
)

OUT = Path(__file__).resolve().parent.parent / "docs" / "gifs"


# =============================================================================================
# 1. Teaching the agent from a wiki page
# =============================================================================================

WIKI_LINES = [
    ("Known issue: nightly export stalls", True),
    ("Symptom - job sits at 'queued' past 03:30.", False),
    ("Cause - the staging lock is not released", False),
    ("when the previous run is cancelled.", False),
    ("Fix - clear the lock row, then re-queue.", False),
    ("Escalate to the platform rota if it recurs", False),
    ("twice in one week.", False),
]

SKILL_CAPTIONS = (
    (0, "Paste a wiki page, a ticket, anything you were told once"),
    (26, "The assistant writes it up as a skill - you approve the exact text"),
    (52, "It is embedded into the vector store you configured"),
    (78, "Weeks later, somebody asks in their own words"),
    (104, "Semantic search finds it - no one had to remember it existed"),
)

SKILL_NOTES = (
    (0, "a wiki page, a runbook, a post-mortem"),
    (26, "write_skill  -  approval shows the exact markdown"),
    (52, "embedder  ->  vector store"),
    (78, "search_docs  -  by meaning, not by file name"),
)


def scene_skills_from_wiki(frame: int):
    c = Canvas(
        "Teach it once, and it remembers",
        latest(SKILL_CAPTIONS, frame),
        latest(SKILL_NOTES, frame),
    )

    # --- the source page
    c.panel(48, 110, 300, 210, title="Confluence page", subtitle="what the team already knows")
    for index, (line, heading) in enumerate(WIKI_LINES):
        alpha = ramp(frame, 1 + index * 2, 4)
        if alpha <= 0.01:
            continue
        c.label(
            62,
            166 + index * 20,
            line,
            font=F_BODY if heading else F_SMALL,
            fill=blend(PANEL, TEXT if heading else MUTED, alpha),
        )

    # --- the skill it becomes
    born = ramp(frame, 28, 10)
    c.panel(388, 110, 264, 210, title="Skill" if born > 0.4 else None,
            subtitle="nightly-export-stall" if born > 0.4 else None, accent=GREEN, alpha=born)
    if born > 0.4:
        for index, text in enumerate(
            (
                "description: why the nightly",
                "export stalls, and the fix",
                "",
                "## Symptom",
                "## Cause",
                "## Fix",
                "## When to escalate",
            )
        ):
            alpha = ramp(frame, 32 + index * 2, 4)
            c.label(402, 178 + index * 19, text, font=F_SMALL, fill=blend(PANEL, MUTED, alpha))

    c.arrow(352, 215, 384, 215, ramp(frame, 26, 6), blend(BG, GREEN, 0.7))
    c.travellers(352, 215, 384, 215, frame, 27, 8, GREEN, count=2)

    # --- the store
    c.panel(688, 110, 224, 210, title="Vector store", subtitle="OpenSearch / Qdrant / Chroma",
            tone=SUNKEN, accent=BLUE if frame >= 60 else None)
    stored = ramp(frame, 58, 12)
    if stored > 0:
        c.chip(702, 178, 196, 26, "nightly-export-stall", GREEN, over=SUNKEN, alpha=stored)
        for index, label in enumerate(("release-checklist", "vat-rules", "risk-model")):
            c.chip(702, 212 + index * 30, 196, 24, label, BLUE, solid=False,
                   over=SUNKEN, alpha=ramp(frame, 62 + index * 3, 8))

    c.arrow(656, 215, 684, 215, ramp(frame, 52, 6), blend(BG, BLUE, 0.7))
    c.travellers(656, 215, 684, 215, frame, 54, 10, BLUE, count=3)

    # --- asking, later
    asking = ramp(frame, 80, 8)
    if asking > 0:
        c.panel(48, 344, 604, 96, tone=SUNKEN, alpha=asking)
        c.label(62, 362, "Three weeks later", font=F_SMALL, fill=blend(SUNKEN, MUTED, asking))
        c.label(
            62,
            386,
            '"the overnight job is stuck again - what do I do?"',
            font=F_BODY,
            fill=blend(SUNKEN, TEXT, asking),
        )

    found = ramp(frame, 100, 10)
    if found > 0:
        c.panel(688, 344, 224, 96, tone=SUNKEN, accent=GREEN, alpha=found)
        c.label(702, 362, "found by meaning", font=F_SMALL, fill=blend(SUNKEN, MUTED, found))
        c.chip(702, 384, 196, 26, "nightly-export-stall", GREEN, over=SUNKEN, alpha=found)
    c.arrow(656, 392, 684, 392, ramp(frame, 94, 6), blend(BG, GREEN, 0.7))

    return c.image


# =============================================================================================
# 2. Dynamic Python tools, and a team that pools them
# =============================================================================================

TOOL_SOURCE = (
    '"""Rows for the weekly margin review."""',
    "# /// script",
    '# dependencies = ["httpx"]',
    "# ///",
    "def run(region: str, weeks: int = 4) -> list[dict]:",
    "    ...",
)

TOOL_CAPTIONS = (
    (0, "A skill says what analysis is needed - the assistant writes the tool for it"),
    (30, "You approve the source. Nothing runs until you have read it"),
    (54, "It is registered, and callable from the next message"),
    (76, "Publish it, and it joins the team's shelf"),
    (100, "Everyone's tools, available to everyone's assistant"),
)

TOOL_NOTES = (
    (0, "create_python_tool"),
    (30, "approval shows the full source  -  hash-pinned once approved"),
    (54, "py__margin_rows"),
    (76, "s3.tools  -  one folder per team, mirrored to each machine"),
)

TEAM_TOOLS = (
    ("py__margin_rows", GREEN, "Ana"),
    ("py__ledger_fetch", BLUE, "Ben"),
    ("py__risk_export", ORANGE, "Cara"),
)


def scene_python_tools(frame: int):
    c = Canvas(
        "Tools the team writes for itself",
        latest(TOOL_CAPTIONS, frame),
        latest(TOOL_NOTES, frame),
    )

    # --- the source, typed out and then approved
    c.panel(48, 110, 372, 196, title="margin_rows.py", subtitle="written to .lightcode/tools/",
            tone=SUNKEN, accent=GREEN if frame >= 30 else None)
    for index, line in enumerate(TOOL_SOURCE):
        alpha = ramp(frame, 2 + index * 3, 5)
        if alpha <= 0.01:
            continue
        c.label(62, 178 + index * 19, line, font=F_MONO_S,
                fill=blend(SUNKEN, TEXT if index >= 4 else MUTED, alpha))

    approved = ramp(frame, 34, 8)
    if approved > 0:
        c.label(62, 292, "approved - source hash pinned", font=F_SMALL,
                fill=blend(SUNKEN, GREEN, approved))

    # --- the registry
    live = ramp(frame, 56, 10)
    c.panel(456, 110, 244, 196, title="Your tools", subtitle="callable from the next message",
            alpha=max(live, 0.25))
    if live > 0:
        c.chip(470, 166, 216, 26, "py__margin_rows", GREEN, alpha=live)
    c.arrow(424, 208, 452, 208, ramp(frame, 52, 6), blend(BG, GREEN, 0.7))

    # --- the shared shelf
    shelf = ramp(frame, 78, 10)
    c.panel(736, 110, 176, 196, title="Team shelf" if shelf > 0.3 else None,
            subtitle="s3.tools" if shelf > 0.3 else None, tone=SUNKEN, accent=PURPLE, alpha=shelf)
    for index, (name, colour, _) in enumerate(TEAM_TOOLS):
        c.chip(750, 166 + index * 32, 148, 26, name, colour, over=SUNKEN,
               alpha=ramp(frame, 82 + index * 5, 8), font=F_MINI)
    c.arrow(704, 208, 732, 208, ramp(frame, 76, 6), blend(BG, PURPLE, 0.7))
    c.travellers(704, 208, 732, 208, frame, 78, 10, PURPLE, count=2)

    # --- everyone ends up with everyone's
    for index, (_, colour, who) in enumerate(TEAM_TOOLS):
        x = 48 + index * 296
        alpha = ramp(frame, 100 + index * 5, 10)
        c.panel(x, 340, 268, 104, alpha=alpha)
        if alpha <= 0.2:
            continue
        c.avatar(x + 14, CARD_AV := 354, who, colour)
        for slot, (name, tone, owner) in enumerate(TEAM_TOOLS):
            sx = x + 14 + (slot % 2) * 128
            sy = 388 + (slot // 2) * 26
            c.chip(sx, sy, 122, 22, name, tone, solid=(owner == who),
                   alpha=ramp(frame, 104 + index * 5 + slot, 8), font=F_MINI)
        c.arrow(x + 134, 336, x + 134, 312, ramp(frame, 98, 8), blend(BG, PURPLE, 0.5), head=False)

    return c.image


# =============================================================================================
# 3. A skill that knows how to fill a form
# =============================================================================================

FORM_FIELDS = (
    ("Requester", "A. Okonkwo"),
    ("Cost centre", "CC-4180"),
    ("Category", "Hardware"),
    ("Justification", "Replacement laptop, 4y old"),
    ("Amount", "1,240.00"),
)

FORM_CAPTIONS = (
    (0, "A skill records the procedure - which field takes what, and where it comes from"),
    (24, "A browser MCP server does the acting. Light Code ships no browser tool"),
    (34, "Fields are filled from the skill"),
    (74, "It may click Next"),
    (88, "It may never click Submit - you review and send"),
)

FORM_NOTES = (
    (0, "skill: raise-hardware-request"),
    (24, "MCP server, configured by you  -  §18: no browser tool ships"),
    (74, 'mcp deny: contains "submit"  -  declared, never inferred'),
)


def scene_form_filling(frame: int):
    c = Canvas("Teach it a form once", latest(FORM_CAPTIONS, frame), latest(FORM_NOTES, frame))

    # --- the skill
    c.panel(48, 110, 268, 232, title="Skill", subtitle="raise-hardware-request", accent=GREEN)
    for index, text in enumerate(
        (
            "1. Requester - the user",
            "2. Cost centre - from the",
            "   team page",
            "3. Category - Hardware",
            "4. Justification - why",
            "5. Amount - the quote",
            "",
            "Stop at review. Never send.",
        )
    ):
        alpha = ramp(frame, 2 + index * 2, 4)
        last = index == 7
        c.label(62, 166 + index * 21, text, font=F_SMALL,
                fill=blend(PANEL, AMBER if last else MUTED, alpha))

    # --- the MCP server in between
    mcp = ramp(frame, 22, 8)
    c.panel(352, 158, 152, 136, title="MCP" if mcp > 0.3 else None,
            subtitle="browser server" if mcp > 0.3 else None, tone=SUNKEN, accent=PURPLE, alpha=mcp)
    if mcp > 0.3:
        c.label(366, 214, "configured by you,", font=F_MINI, fill=blend(SUNKEN, MUTED, mcp))
        c.label(366, 230, "not shipped with", font=F_MINI, fill=blend(SUNKEN, MUTED, mcp))
        c.label(366, 246, "Light Code", font=F_MINI, fill=blend(SUNKEN, MUTED, mcp))
    c.arrow(320, 226, 348, 226, ramp(frame, 20, 5), blend(BG, GREEN, 0.7))

    # --- the form
    c.panel(540, 110, 372, 232, title="Purchase request", subtitle="an internal web form",
            tone=SUNKEN)
    for index, (name, value) in enumerate(FORM_FIELDS):
        y = 158 + index * 34
        c.label(554, y + 10, name, font=F_MINI, fill=MUTED)
        c.d.rounded_rectangle((650, y, 898, y + 24), radius=4, fill=BG, outline=FAINT, width=1)
        typed = ramp(frame, 34 + index * 7, 6)
        if typed > 0:
            shown = value[: max(1, round(len(value) * typed))]
            c.label(660, y + 12, shown, font=F_CHIP, fill=blend(BG, TEXT, 1), anchor="lm")
    c.travellers(508, 226, 536, 226, frame, 32, 10, PURPLE, count=3)

    # --- the two buttons, and the one that is refused
    next_hit = ramp(frame, 76, 6)
    c.d.rounded_rectangle((650, 360, 736, 388), radius=6,
                          fill=blend(SUNKEN, GREEN, 0.25 + 0.4 * next_hit),
                          outline=blend(BORDER, GREEN, 0.4 + 0.5 * next_hit), width=1)
    c.label(693, 374, "Next", font=F_CHIP, fill=TEXT, anchor="mm")

    blocked = ramp(frame, 90, 8)
    c.d.rounded_rectangle((760, 360, 872, 388), radius=6, fill=SUNKEN,
                          outline=blend(BORDER, RED, blocked), width=1)
    c.label(816, 374, "Submit", font=F_CHIP,
            fill=blend(MUTED, blend(RED, TEXT, 0.4), blocked), anchor="mm")
    if blocked > 0.3:
        # Struck through, because "refused" has to be visible in a still frame as well as in motion.
        c.d.line((768, 374, 864, 374), fill=blend(SUNKEN, RED, blocked), width=2)

    c.cursor(700, 366, pulse(frame, 70, 14))

    if blocked > 0.4:
        c.panel(48, 366, 560, 74, tone=SUNKEN, accent=RED, alpha=blocked)
        c.label(62, 384, "Refused before the call left for the server", font=F_BODY,
                fill=blend(SUNKEN, TEXT, blocked))
        c.label(62, 408, 'A deny rule you wrote - not a guess about which button is dangerous.',
                font=F_SMALL, fill=blend(SUNKEN, MUTED, blocked))

    return c.image


# =============================================================================================
# 4. Scheduled runs, their logs, and reading them back
# =============================================================================================

LOG_ROWS = (
    ("02:00", "export.nightly", "ok", GREEN),
    ("02:14", "reconcile", "ok", GREEN),
    ("03:07", "export.nightly", "retry 1", AMBER),
    ("03:12", "export.nightly", "FAILED", RED),
    ("03:30", "reconcile", "ok", GREEN),
)

LOG_CAPTIONS = (
    (0, "A schedule runs while nobody is watching"),
    (22, "Its output is written into your cluster, run after run"),
    (56, "Weeks of runs, indexed and searchable"),
    (70, "Ask a question of them in the morning"),
    (96, "It reads the logs and answers the actual question"),
)

LOG_NOTES = (
    (0, "schedules  -  nightly, read-only unless you grant more"),
    (22, "written by a tool you configured; Light Code ships no log shipper"),
    (70, "search_opensearch  -  read-only by construction"),
)


def scene_scheduled_logs(frame: int):
    c = Canvas("Logs a schedule leaves behind", latest(LOG_CAPTIONS, frame), latest(LOG_NOTES, frame))

    # --- the schedule, ticking
    c.panel(48, 110, 228, 186, title="Schedule", subtitle="every night at 02:00", accent=PURPLE)
    for index in range(3):
        alpha = ramp(frame, 2 + index * 6, 6)
        y = 166 + index * 32
        c.chip(62, y, 200, 26, f"run {index + 1}", PURPLE, alpha=alpha)
    tick = pulse(frame, 4, 40)
    c.d.ellipse((240, 126, 256, 142), outline=blend(PANEL, PURPLE, 0.4 + tick * 0.6), width=2)

    # --- into the cluster
    c.arrow(280, 200, 316, 200, ramp(frame, 20, 6), blend(BG, PURPLE, 0.7))
    c.travellers(280, 200, 316, 200, frame, 22, 12, PURPLE, count=4, spacing=5)

    c.panel(320, 110, 360, 300, title="OpenSearch", subtitle="index: job-logs", tone=SUNKEN,
            accent=BLUE if frame >= 40 else None)
    for index, (when, job, status, colour) in enumerate(LOG_ROWS):
        alpha = ramp(frame, 26 + index * 5, 6)
        if alpha <= 0.01:
            continue
        y = 176 + index * 30
        c.label(334, y + 12, when, font=F_MONO_S, fill=blend(SUNKEN, MUTED, alpha), anchor="lm")
        c.label(386, y + 12, job, font=F_MONO_S, fill=blend(SUNKEN, TEXT, alpha), anchor="lm")
        c.badge(572, y, 94, 24, status, colour, alpha=alpha, over=SUNKEN)

    more = ramp(frame, 58, 8)
    c.label(334, 340, "... 2,410 more runs indexed", font=F_SMALL, fill=blend(SUNKEN, MUTED, more))
    c.label(334, 362, "retained and searchable", font=F_SMALL, fill=blend(SUNKEN, FAINT, more))

    # --- the question
    asking = ramp(frame, 72, 8)
    c.panel(48, 344, 228, 96, tone=SUNKEN, alpha=asking)
    c.label(62, 362, "In the morning", font=F_SMALL, fill=blend(SUNKEN, MUTED, asking))
    c.label(62, 386, '"did the export fail', font=F_BODY, fill=blend(SUNKEN, TEXT, asking))
    c.label(62, 406, ' again, and when?"', font=F_BODY, fill=blend(SUNKEN, TEXT, asking))

    # --- the answer
    answer = ramp(frame, 96, 10)
    c.panel(712, 110, 200, 300, title="Answer" if answer > 0.3 else None, accent=GREEN, alpha=answer)
    if answer > 0.3:
        for index, line in enumerate(
            (
                "Yes - once, at 03:12,",
                "after one retry at 03:07.",
                "",
                "Same clock position as",
                "the four failures last",
                "month: all between",
                "03:05 and 03:15.",
                "",
                "Reconcile was unaffected.",
            )
        ):
            c.label(726, 166 + index * 22, line, font=F_SMALL,
                    fill=blend(PANEL, TEXT if index == 0 else MUTED,
                               ramp(frame, 98 + index * 2, 6)))
    c.arrow(684, 260, 708, 260, ramp(frame, 92, 6), blend(BG, GREEN, 0.7))

    return c.image


# =============================================================================================
# 5. Excel, and a formula nobody can follow
# =============================================================================================

EXCEL_CAPTIONS = (
    (0, "It attaches to the workbook you already have open"),
    (20, "A total reads #DIV/0! and nobody can see why"),
    (38, "It walks the formula back through its precedents"),
    (66, "Across sheets, to the cell that actually caused it"),
    (92, "One cell in two thousand - named, not guessed at"),
)

EXCEL_NOTES = (
    (0, "excel_sessions  -  attaches, never launches"),
    (38, "excel_trace_cell"),
    (66, "precedents followed as blocks, not cell by cell"),
)

TRACE = (
    ("Summary!B12", "=Margin!D40/Margin!D41", RED, "#DIV/0!"),
    ("Margin!D41", "=SUM(Volumes!C2:C2001)", AMBER, "0"),
    ("Volumes!C2:C2001", "2000 cells feeding this", BLUE, "all blank"),
    ("Volumes!A1", "source import - empty", ORANGE, "no rows"),
)


def scene_excel(frame: int):
    c = Canvas("The formula nobody can follow", latest(EXCEL_CAPTIONS, frame),
               latest(EXCEL_NOTES, frame))

    # --- the sheet
    c.panel(48, 110, 386, 214, title="Quarterly.xlsx", subtitle="open in Excel, unsaved edits and all",
            tone=SUNKEN, accent=GREEN if frame >= 8 else None)
    for row in range(5):
        for col in range(4):
            x, y = 62 + col * 92, 176 + row * 30
            broken = row == 2 and col == 1
            lit = broken and ramp(frame, 22, 8) > 0
            if lit:
                # The colour *is* the finding here, so it goes through `badge` rather than the
                # chip wash that rendered every status the same grey.
                c.badge(x, y, 86, 24, "#DIV/0!", RED, over=SUNKEN)
                continue
            c.d.rounded_rectangle((x, y, x + 86, y + 24), radius=3, fill=BG, outline=FAINT, width=1)
            if broken:
                pass
            elif (row + col) % 3 != 0:
                c.label(x + 43, y + 12, "1,284" if col else "Region", font=F_MINI,
                        fill=blend(BG, MUTED, 0.8), anchor="mm")

    # --- the trace
    for index, (where, formula, colour, value) in enumerate(TRACE):
        alpha = ramp(frame, 40 + index * 12, 9)
        if alpha <= 0.01:
            continue
        y = 110 + index * 78
        c.panel(486, y, 426, 64, tone=PANEL, accent=colour, alpha=alpha)
        c.label(500, y + 16, where, font=F_MONO, fill=blend(PANEL, TEXT, alpha))
        c.label(500, y + 38, formula, font=F_MONO_S, fill=blend(PANEL, MUTED, alpha))
        c.badge(800, y + 16, 98, 26, value, colour, alpha=alpha)
        if index < 3:
            c.arrow(699, y + 66, 699, y + 76, ramp(frame, 48 + index * 12, 5),
                    blend(BG, MUTED, 0.5))

    c.arrow(438, 200, 482, 200, ramp(frame, 36, 6), blend(BG, RED, 0.7))

    # --- the conclusion
    done = ramp(frame, 94, 10)
    if done > 0:
        c.panel(48, 344, 386, 96, tone=SUNKEN, accent=ORANGE, alpha=done)
        c.label(62, 364, "Volumes!A1 is empty", font=F_BODY, fill=blend(SUNKEN, TEXT, done))
        c.label(62, 388, "The import brought no rows, so the divisor", font=F_SMALL,
                fill=blend(SUNKEN, MUTED, done))
        c.label(62, 406, "summed to zero. Nothing else is wrong.", font=F_SMALL,
                fill=blend(SUNKEN, MUTED, done))

    return c.image


# =============================================================================================
# 6. Diagrams from something it has read
# =============================================================================================

DIAGRAM_CAPTIONS = (
    (0, "Point it at a wiki page, a repository, or one program"),
    (24, "It reads the thing itself, not a summary of it"),
    (48, "And draws what it found"),
    (98, "A flow you can check against the code, rather than a description of it"),
)

DIAGRAM_NOTES = (
    (0, "read_file  /  search_codebase  /  a wiki page you paste"),
    (48, "show_diagram  -  box, round, diamond, cylinder"),
)

NODES = (
    (556, 132, 150, 40, "Intake API", "round", BLUE),
    (556, 202, 150, 40, "Validate", "box", BLUE),
    (556, 272, 150, 40, "Duplicate?", "diamond", AMBER),
    (400, 342, 150, 40, "Reject queue", "box", RED),
    (712, 342, 150, 40, "Ledger", "cylinder", GREEN),
    (556, 412, 150, 40, "Notify", "round", PURPLE),
)

EDGES = ((0, 1, ""), (1, 2, ""), (2, 3, "yes"), (2, 4, "no"), (4, 5, ""))


def _node(c: Canvas, x, y, w, h, label, shape, colour, alpha):
    if alpha <= 0.01:
        return
    # 0.62 rather than the chip's 0.80: a flow chart's colours are what separate a decision from
    # a store from a failure path, and washed to a tint they all read as the same grey box.
    fill = blend(BG, blend(colour, BG, 0.62), alpha)
    line = blend(BG, colour, alpha)
    if shape == "diamond":
        cx, cy = x + w / 2, y + h / 2
        c.d.polygon([(cx, y - 6), (x + w + 8, cy), (cx, y + h + 6), (x - 8, cy)],
                    fill=fill, outline=line)
    elif shape == "cylinder":
        c.d.rounded_rectangle((x, y, x + w, y + h), radius=4, fill=fill, outline=line, width=1)
        c.d.ellipse((x, y - 6, x + w, y + 10), fill=fill, outline=line)
    else:
        c.d.rounded_rectangle((x, y, x + w, y + h), radius=18 if shape == "round" else 5,
                              fill=fill, outline=line, width=1)
    c.label(x + w / 2, y + h / 2, label, font=F_CHIP, fill=blend(BG, TEXT, alpha), anchor="mm")


def scene_diagrams(frame: int):
    c = Canvas("It draws what it read", latest(DIAGRAM_CAPTIONS, frame),
               latest(DIAGRAM_NOTES, frame))

    # --- the source being read
    c.panel(48, 110, 300, 330, title="What it studied", subtitle="a page, a repo, one program",
            tone=SUNKEN)
    for index, (label, colour) in enumerate(
        (("intake-service/", BLUE), ("  router.ts", MUTED), ("  validate.ts", MUTED),
         ("  dedupe.ts", MUTED), ("  ledger.ts", MUTED), ("wiki: Intake flow", PURPLE))
    ):
        alpha = ramp(frame, 2 + index * 4, 6)
        c.label(62, 180 + index * 26, label, font=F_MONO_S, fill=blend(SUNKEN, colour, alpha))
    # A reading indicator, so "it read the thing" is visible rather than asserted.
    scan = ramp(frame, 26, 22)
    if 0 < scan < 1:
        y = 160 + scan * 170
        c.d.line((56, y, 340, y), fill=blend(SUNKEN, BLUE, 0.5), width=1)
    c.bar(62, 400, 272, 6, ramp(frame, 26, 22), blend(SUNKEN, BLUE, 0.8), over=SUNKEN)
    c.label(62, 416, "reading", font=F_MINI, fill=blend(SUNKEN, MUTED, ramp(frame, 26, 6)))

    c.arrow(352, 275, 384, 275, ramp(frame, 46, 6), blend(BG, BLUE, 0.7))

    # --- the diagram, node by node
    for index, (fx, fy, tx, ty, _) in enumerate(
        (
            (631, 172, 631, 202, 0),
            (631, 242, 631, 272, 0),
            (556, 292, 475, 342, 0),
            (706, 292, 787, 342, 0),
            (787, 382, 631, 412, 0),
        )
    ):
        start, end, _label = EDGES[index]
        c.arrow(fx, fy, tx, ty, ramp(frame, 58 + index * 8, 6), blend(BG, MUTED, 0.45))

    for index, (x, y, w, h, label, shape, colour) in enumerate(NODES):
        _node(c, x, y, w, h, label, shape, colour, ramp(frame, 52 + index * 8, 8))

    yes = ramp(frame, 76, 6)
    c.label(505, 316, "yes", font=F_MINI, fill=blend(BG, MUTED, yes))
    c.label(752, 316, "no", font=F_MINI, fill=blend(BG, MUTED, ramp(frame, 84, 6)))

    return c.image


# =============================================================================================
# 7. Mail, indexed on a timer, answered as a chart
# =============================================================================================

MAIL_CAPTIONS = (
    (0, "Tick the Outlook folders worth indexing"),
    (22, "They are re-read on a timer you set"),
    (46, "Received time, sender and status tag are exact - never approximate"),
    (66, "Ask for the shape of a week"),
    (88, "And get it as a chart, not a paragraph"),
)

MAIL_NOTES = (
    (0, "mail.folders  -  off by default, user-scope only"),
    (22, "mail.syncMinutes"),
    (46, "facts in a local sidecar; meaning in the vector store"),
    (66, "show_chart  -  bar, line, pie"),
)

FOLDERS = (
    ("Inbox / Alerts", True),
    ("Inbox / Batch reports", True),
    ("Inbox / Vendor", False),
    ("Archive / 2026", False),
)

WEEK = (("Mon", 12, 3), ("Tue", 9, 1), ("Wed", 14, 6), ("Thu", 8, 2), ("Fri", 17, 9))


def scene_mail_charts(frame: int):
    c = Canvas("Your mailbox, as numbers", latest(MAIL_CAPTIONS, frame), latest(MAIL_NOTES, frame))

    # --- picking folders
    c.panel(48, 110, 268, 186, title="Outlook folders", subtitle="you choose which", accent=GREEN)
    for index, (name, ticked) in enumerate(FOLDERS):
        y = 176 + index * 30
        alpha = ramp(frame, 2 + index * 4, 5)
        on = ticked and ramp(frame, 8 + index * 5, 5) > 0.5
        c.d.rounded_rectangle((62, y, 76, y + 14), radius=3,
                              fill=blend(PANEL, GREEN, 0.75) if on else PANEL,
                              outline=blend(PANEL, GREEN if on else FAINT, alpha), width=1)
        c.label(86, y + 7, name, font=F_SMALL,
                fill=blend(PANEL, TEXT if on else MUTED, alpha), anchor="lm")

    # --- the timer
    timer = ramp(frame, 24, 8)
    c.panel(48, 312, 268, 128, tone=SUNKEN, alpha=timer)
    c.label(62, 330, "Re-read every", font=F_SMALL, fill=blend(SUNKEN, MUTED, timer))
    c.label(62, 354, "30 minutes", font=F_NAME, fill=blend(SUNKEN, TEXT, timer))
    c.bar(62, 390, 240, 6, (frame % 24) / 24, blend(SUNKEN, GREEN, 0.8), over=SUNKEN)
    c.label(62, 406, "incremental, per folder", font=F_MINI, fill=blend(SUNKEN, MUTED, timer))

    c.travellers(320, 200, 352, 200, frame, 28, 12, GREEN, count=3)

    # --- what is kept
    kept = ramp(frame, 48, 8)
    c.panel(356, 110, 244, 186, title="What is kept" if kept > 0.3 else None, tone=SUNKEN,
            accent=BLUE, alpha=kept)
    for index, (label, exact) in enumerate(
        (("received time", True), ("folder + sender", True), ("[OK] / [ALERT] tag", True),
         ("the words, embedded", False))
    ):
        alpha = ramp(frame, 50 + index * 5, 6)
        c.label(370, 178 + index * 28, ("exact  " if exact else "search  ") + label,
                font=F_MONO_S, fill=blend(SUNKEN, TEXT if exact else BLUE, alpha))
    if kept > 0.5:
        c.label(370, 284, "a range filter is never approximated", font=F_MINI,
                fill=blend(SUNKEN, MUTED, kept))

    # --- the question
    asking = ramp(frame, 68, 8)
    c.panel(356, 312, 244, 128, tone=SUNKEN, alpha=asking)
    c.label(370, 330, "You ask", font=F_SMALL, fill=blend(SUNKEN, MUTED, asking))
    for index, line in enumerate(('"how many alerts', 'this week, and how', 'many were repeats?"')):
        c.label(370, 356 + index * 20, line, font=F_BODY,
                fill=blend(SUNKEN, TEXT, ramp(frame, 70 + index * 3, 6)))

    # --- the chart
    chart = ramp(frame, 90, 10)
    c.panel(640, 110, 272, 330, title="Alerts this week" if chart > 0.3 else None,
            subtitle="by day, repeats shaded" if chart > 0.3 else None, alpha=chart)
    if chart > 0.3:
        base = 400
        for index, (day, total, repeats) in enumerate(WEEK):
            x = 664 + index * 48
            grow = ramp(frame, 94 + index * 4, 9)
            height = total * 11 * grow
            c.d.rounded_rectangle((x, base - height, x + 30, base), radius=3,
                                  fill=blend(PANEL, BLUE, 0.95))
            rep = repeats * 11 * grow
            if rep > 2:
                c.d.rounded_rectangle((x, base - rep, x + 30, base), radius=3,
                                      fill=blend(PANEL, ORANGE, 0.95))
            c.label(x + 15, base + 14, day, font=F_MINI, fill=blend(PANEL, MUTED, grow), anchor="mm")
            c.label(x + 15, base - height - 12, str(total), font=F_MINI,
                    fill=blend(PANEL, TEXT, grow), anchor="mm")
        c.d.line((656, base + 2, 896, base + 2), fill=FAINT, width=1)
        legend = ramp(frame, 112, 8)
        c.d.rounded_rectangle((664, 178, 678, 190), radius=3, fill=blend(PANEL, BLUE, 0.95 * legend))
        c.label(686, 184, "new", font=F_MINI, fill=blend(PANEL, MUTED, legend), anchor="lm")
        c.d.rounded_rectangle((736, 178, 750, 190), radius=3,
                              fill=blend(PANEL, ORANGE, 0.95 * legend))
        c.label(758, 184, "seen before", font=F_MINI, fill=blend(PANEL, MUTED, legend), anchor="lm")

    return c.image


# =============================================================================================

SCENES = (
    ("skills-from-wiki.gif", scene_skills_from_wiki, 126),
    ("python-tools.gif", scene_python_tools, 126),
    ("form-filling.gif", scene_form_filling, 112),
    ("scheduled-logs.gif", scene_scheduled_logs, 122),
    ("excel-investigation.gif", scene_excel, 116),
    ("technical-diagrams.gif", scene_diagrams, 116),
    ("mail-insights.gif", scene_mail_charts, 130),
)


def main() -> None:
    for name, scene, total in SCENES:
        write_gif([scene(frame) for frame in range(total)], OUT / name)


if __name__ == "__main__":
    main()
