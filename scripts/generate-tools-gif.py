#!/usr/bin/env python3
"""Draws `docs/gifs/why-tools.gif`: why Light Code exists at all.

The claim it is built around, in the user's own words: *"the power of an agent is mostly in what
tools it has access to — this is the primary reason for developing Light Code"*.

## What the animation has to argue, and why in this order

A model with no tools can only produce text. Everything an assistant *does* — read the file,
run the build, look in the spreadsheet somebody has open, ask the cluster — is a tool, and the
useful question about any assistant is therefore not how clever it is but what it can reach.
So the animation starts from the bare model, adds the four kinds of reach one at a time, and
only then shows the gate they all pass through.

The gate is not a postscript. A product whose thesis is "more reach" has to answer what stops
that reach being used badly, and Light Code's answer is that every one of these goes through
the same approval, showing ground truth. Leaving it out would make the picture an advertisement
rather than a description.

## Why a generator rather than a hand-made file

The reason `generate-team-skills-gif.py` and `generate-walkthrough-art.mjs` both exist: a
picture of a feature goes stale silently, and a binary dropped into the repository can only be
replaced, never reviewed. When the tool list changes, this file is what gets edited and the diff
says what the picture now claims.

Run by hand, never in CI, so it adds no dependency to anything anyone installs:

    pip install Pillow
    python scripts/generate-tools-gif.py

## What must stay true

Every tool named below is one that actually exists. That is the whole value of the picture, and
it is the thing to check when this is regenerated — a diagram claiming a capability the product
does not have is worse than no diagram, because somebody goes looking for it.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image  # noqa: F401  (imported for the error message below)
except ImportError:  # pragma: no cover - a human running this gets told what to install
    sys.exit("This needs Pillow: pip install Pillow")

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gifkit import (  # noqa: E402
    BG,
    BLUE,
    F_BODY,
    F_MINI,
    F_NAME,
    F_SMALL,
    GREEN,
    HEIGHT,
    MUTED,
    ORANGE,
    PURPLE,
    SUNKEN,
    TEXT,
    WIDTH,
    Canvas,
    blend,
    ease,
    latest,
    ramp,
    write_gif,
)

TITLE = "What an agent can reach is what an agent can do"
FRAME_MS = 70

# --- the four kinds of reach ---------------------------------------------------------------
#
# Grouped by *what they touch*, not by how they are implemented, because that is the distinction
# somebody watching this cares about. The MCP and Python groups are the ones that make the point
# strongest: those are not a fixed list at all, they are however many the user brings.

GROUPS = (
    {
        "name": "This codebase",
        "reach": "files, search, the terminal",
        "colour": GREEN,
        "tools": ("read_file", "apply_diff", "search_files", "execute_command"),
    },
    {
        "name": "This desktop",
        "reach": "the apps already open",
        "colour": BLUE,
        "tools": ("excel_read_range", "excel_trace_cell", "outlook_search", "outlook_create_draft"),
    },
    {
        "name": "Your organisation",
        "reach": "MCP servers, indexes, buckets",
        "colour": ORANGE,
        "tools": ("use_mcp_tool", "search_codebase", "search_docs", "search_team_skills"),
    },
    {
        "name": "Whatever you teach it",
        "reach": "written here, kept in git",
        "colour": PURPLE,
        "tools": ("create_python_tool", "write_skill", "use_skill_file", "schedule_prompt"),
    },
)

CARD_W, CARD_H = 204, 224
# Raised, and the cards shortened, to leave a clear band under the gate for the closing line.
# The first attempt put that line at HEIGHT - 74 and it landed *inside* the gate panel - the
# exact fault `Canvas.body` was written against, and invisible to everything except looking.
CARD_Y = 142
CARD_XS = (48, 282, 516, 750)

# --- timing -------------------------------------------------------------------------------

BARE_START = 0
GROUP_START = 54          # the first group lands
GROUP_STRIDE = 42         # and each one after it
GATE_START = GROUP_START + GROUP_STRIDE * len(GROUPS) + 18
CLOSE_START = GATE_START + 60
TOTAL = CLOSE_START + 96

CAPTIONS = (
    (BARE_START, "A model on its own can produce one thing: text."),
    (GROUP_START, "Every single thing it *does* is a tool call."),
    (GROUP_START + GROUP_STRIDE, "Reach the desktop, and it can answer questions about the file you have open."),
    (GROUP_START + GROUP_STRIDE * 2, "Reach your organisation, and it knows what your team knows."),
    (GROUP_START + GROUP_STRIDE * 3, "Add your own, and the list stops being ours."),
    (GATE_START, "All of it through one gate, showing exactly what will happen."),
    (CLOSE_START, "This is the primary reason Light Code exists."),
)

NOTES = (
    (BARE_START, "a cleverer model with no tools is still only a conversation"),
    (GROUP_START, "tools/ - nine at v1, and more since"),
    (GROUP_START + GROUP_STRIDE * 2, "mcp/ - namespaced, per-tool toggles, one approval path"),
    (GROUP_START + GROUP_STRIDE * 3, "python/ + skills/ - code you wrote, prose you wrote"),
    (GATE_START, "approval/policy.ts - the literal command, the computed diff, the actual source"),
    (CLOSE_START, "not a cleverer model - a better connected one, and one you can watch"),
)


def group_alpha(frame: int, index: int) -> float:
    """How far this group has arrived. Each lands in turn, then stays."""
    return ease(ramp(frame, GROUP_START + index * GROUP_STRIDE, 20))


def render(frame: int):
    canvas = Canvas(TITLE, latest(CAPTIONS, frame), latest(NOTES, frame))
    draw = canvas.d

    # --- the model, always present -----------------------------------------------------
    #
    # It never shrinks or fades. The argument is not that the model does not matter; it is that
    # the model alone is a conversation, and a picture that dimmed it would be making a claim
    # nobody made.
    model_x, model_y, model_w, model_h = 48, 100, WIDTH - 96, 34
    canvas.panel(model_x, model_y, model_w, model_h, tone=SUNKEN)
    draw.text(
        (model_x + 14, model_y + model_h / 2),
        "the model",
        font=F_NAME,
        fill=TEXT,
        anchor="lm",
    )

    bare = 1.0 - ease(ramp(frame, GROUP_START - 8, 16))
    if bare > 0.01:
        draw.text(
            (model_x + model_w - 14, model_y + model_h / 2),
            "text in, text out",
            font=F_SMALL,
            fill=blend(SUNKEN, MUTED, bare),
            anchor="rm",
        )

    for index, group in enumerate(GROUPS):
        alpha = group_alpha(frame, index)
        if alpha <= 0.01:
            # An empty place, so the row does not appear to grow sideways as each one lands.
            canvas.slot(CARD_XS[index], CARD_Y, CARD_W, CARD_H)
            continue

        x = CARD_XS[index]
        colour = group["colour"]
        canvas.panel(
            x, CARD_Y, CARD_W, CARD_H,
            title=group["name"], subtitle=group["reach"], accent=colour, alpha=alpha,
        )

        # Down from the model into the group, so the direction of the claim is visible: the
        # model is what calls these, not something they feed.
        canvas.arrow(
            x + CARD_W / 2, model_y + model_h,
            x + CARD_W / 2, CARD_Y,
            ease(ramp(frame, GROUP_START + index * GROUP_STRIDE, 14)),
            colour=blend(BG, colour, 0.5),
        )

        top = Canvas.body(CARD_Y)
        for at, tool in enumerate(group["tools"]):
            # Staggered inside the group too, so the eye reads them as a list arriving rather
            # than a block appearing.
            each = ease(ramp(frame, GROUP_START + index * GROUP_STRIDE + 6 + at * 4, 14))
            canvas.chip(
                x + 14, top + at * 34, CARD_W - 28, 26,
                tool, colour, alpha=min(alpha, each), font=F_MINI,
            )

        # The point the four cards are making, said once where it cannot be missed.
        more = ease(ramp(frame, GROUP_START + index * GROUP_STRIDE + 24, 12))
        if more > 0.01 and index >= 2:
            draw.text(
                (x + CARD_W / 2, CARD_Y + CARD_H - 22),
                "+ however many you add",
                font=F_MINI,
                fill=blend(BG, blend(colour, TEXT, 0.4), more * alpha),
                anchor="mm",
            )

    # --- the gate ----------------------------------------------------------------------
    #
    # Drawn under every card rather than beside one, because it applies to all of them. A gate
    # attached to a single group would say the others bypass it, which would be a lie about the
    # one property the product is most careful with.
    gate = ease(ramp(frame, GATE_START, 22))
    if gate > 0.01:
        gy = CARD_Y + CARD_H + 22
        canvas.panel(48, gy, WIDTH - 96, 54, tone=SUNKEN, accent=TEXT, alpha=gate)
        draw.text(
            (62, gy + 18),
            "You approve each one, and what you are shown is what happens",
            font=F_BODY,
            fill=blend(BG, TEXT, gate),
        )
        draw.text(
            (62, gy + 34),
            "the literal command, the computed diff, the real source - never the model's "
            "description of what it intends to do",
            font=F_MINI,
            fill=blend(BG, MUTED, gate),
        )
        for index in range(len(GROUPS)):
            canvas.arrow(
                CARD_XS[index] + CARD_W / 2, CARD_Y + CARD_H,
                CARD_XS[index] + CARD_W / 2, gy,
                ease(ramp(frame, GATE_START + index * 4, 14)),
                colour=blend(BG, GROUPS[index]["colour"], 0.45 * gate),
            )

    # --- the claim, said once in the frame ---------------------------------------------
    #
    # In the picture rather than only in the caption, so a still frame - which is what a slide
    # or a README thumbnail actually is - still carries the point. The other generators cut
    # these into slides for exactly that use.
    close = ease(ramp(frame, CLOSE_START, 20))
    if close > 0.01:
        draw.text(
            (WIDTH / 2, HEIGHT - 58),
            "Light Code is a small agent with a lot of reach, and a gate in front of all of it",
            font=F_BODY,
            fill=blend(BG, TEXT, close),
            anchor="mm",
        )

    return canvas.image


def main() -> None:
    frames = [render(frame) for frame in range(TOTAL)]
    root = Path(__file__).resolve().parent.parent / "docs" / "gifs"
    (root / "slides").mkdir(parents=True, exist_ok=True)
    write_gif(frames, root / "why-tools.gif", frame_ms=FRAME_MS)

    # Cut on the captions, as the other generators do: a caption already marks the moment the
    # thing being described changes, so cutting anywhere else would put a caption change in the
    # middle of a segment somebody is talking over.
    bounds = [at for at, _ in CAPTIONS] + [TOTAL]
    for index in range(len(CAPTIONS)):
        start, stop = bounds[index], bounds[index + 1]
        if stop <= start:
            continue
        stem = f"why-tools-{index + 1}"
        write_gif(frames[start:stop], root / "slides" / f"{stem}.gif",
                  frame_ms=FRAME_MS, end_hold=2000, once=True)
        frames[stop - 1].save(root / "slides" / f"{stem}.png")


if __name__ == "__main__":
    main()
