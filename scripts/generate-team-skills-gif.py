#!/usr/bin/env python3
"""Draws `docs/gifs/team-skills.gif`: how a team's skills come to be shared.

## Why a generator rather than a hand-made file

The same reason `generate-walkthrough-art.mjs` exists: a picture of a feature goes stale silently.
When the mechanism changes, this file is what gets edited, and the diff shows what the picture now
claims. A binary dropped into the repository can only be replaced, never reviewed.

## Why Python rather than Node, unlike every other script here

It needs a rasteriser, and Pillow is the shortest path to one on a machine that already has
Python for section 13's tooling. It is **run by hand**, not in CI and not part of `pnpm build`, so
it adds no dependency to anything anyone installs:

    pip install Pillow
    python scripts/generate-team-skills-gif.py

## What it must keep true

The captions describe the real mechanism in section 12g, and they are the part worth checking when
this is regenerated:

- everyone writes into **their own** folder, with `write_skill`;
- everyone publishes to **their own** collection, never a shared one, so one person's re-index
  cannot disturb anybody else's;
- `embedder.skillsAlias` is what spans them;
- `search_team_skills` returns a colleague's skill **body**, because there is no file on this disk
  to read afterwards.

Names and skill titles here are invented, and must stay invented.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - a human running this gets told what to install
    sys.exit("This needs Pillow: pip install Pillow")

# --- canvas -------------------------------------------------------------------------------

WIDTH, HEIGHT = 960, 530
FRAME_MS = 70

BG = (15, 17, 21)
PANEL = (26, 30, 38)
POOL = (21, 25, 32)
BORDER = (42, 47, 58)
TEXT = (230, 232, 236)
MUTED = (138, 147, 163)
FAINT = (58, 64, 78)

# The product's own defaults for two of these (§ the UI conventions), so the picture and the
# panel agree about what Light Code looks like.
GREEN = (34, 197, 94)
BLUE = (91, 157, 249)
ORANGE = (217, 119, 87)

CARD_Y, CARD_H, CARD_W = 110, 200, 272
CARD_XS = (48, 344, 640)
POOL_X, POOL_Y, POOL_W, POOL_H = 48, 345, 864, 110

MEMBERS = (
    {"name": "Ana", "colour": GREEN, "skills": ("deploy-pipeline", "release-checklist")},
    {"name": "Ben", "colour": BLUE, "skills": ("invoice-format", "vat-rules")},
    {"name": "Cara", "colour": ORANGE, "skills": ("risk-model", "stress-test")},
)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    root = Path(os.environ.get("SystemRoot", "C:/Windows")) / "Fonts"
    for candidate in (name, "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(str(root / candidate), size)
        except OSError:
            continue
    return ImageFont.load_default()


F_TITLE = font("segoeuib.ttf", 25)
F_CAPTION = font("segoeui.ttf", 15)
F_NAME = font("segoeuib.ttf", 15)
F_SMALL = font("segoeui.ttf", 11)
F_CHIP = font("segoeui.ttf", 12)
F_MINI = font("segoeui.ttf", 10)
F_MONO = font("consola.ttf", 11)


def blend(a, b, t: float):
    """`a` toward `b` by `t`. Used for every fade, so nothing needs an alpha channel."""
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def ease(u: float) -> float:
    """Cubic in-out. A chip that starts and stops abruptly reads as a jump rather than a journey."""
    u = max(0.0, min(1.0, u))
    return 4 * u * u * u if u < 0.5 else 1 - pow(-2 * u + 2, 3) / 2


def ramp(frame: int, start: int, length: int) -> float:
    """0 before `start`, 1 after it has run for `length` frames."""
    if frame < start:
        return 0.0
    return min(1.0, (frame - start) / max(1, length))


# --- pieces -------------------------------------------------------------------------------


def chip(draw, x, y, w, h, label, colour, *, solid=True, alpha=1.0, over=PANEL):
    """One skill.

    `solid` is a skill this person wrote; an outline is one reached through the pool. The
    difference is the whole point of the last scene, so it is carried by fill rather than by a
    label nobody reads at this size.
    """
    if alpha <= 0.01:
        return
    if solid:
        fill = blend(over, blend(colour, over, 0.80), alpha)
        line = blend(over, colour, alpha * 0.85)
        ink = blend(over, TEXT, alpha)
    else:
        fill = over
        line = blend(over, colour, alpha * 0.45)
        ink = blend(over, blend(colour, TEXT, 0.35), alpha)
    draw.rounded_rectangle((x, y, x + w, y + h), radius=6, fill=fill, outline=line, width=1)
    draw.rectangle((x + 1, y + 6, x + 3, y + h - 6), fill=line)
    face = F_CHIP if h >= 24 else F_MINI
    draw.text((x + 12, y + h / 2), label, font=face, fill=ink, anchor="lm")


def card(draw, x, name, colour):
    draw.rounded_rectangle(
        (x, CARD_Y, x + CARD_W, CARD_Y + CARD_H), radius=10, fill=PANEL, outline=BORDER, width=1
    )
    draw.ellipse((x + 14, CARD_Y + 14, x + 32, CARD_Y + 32), fill=blend(colour, PANEL, 0.55))
    draw.text((x + 40, CARD_Y + 23), name, font=F_NAME, fill=TEXT, anchor="lm")
    draw.text((x + 14, CARD_Y + 46), "writes into their own folder", font=F_SMALL, fill=MUTED)


def own_slot(member_index: int, slot: int):
    x = CARD_XS[member_index] + 14
    return x, CARD_Y + 66 + slot * 32, CARD_W - 28, 26


def pool_slot(index: int):
    return POOL_X + 14 + index * 142, POOL_Y + 62, 132, 26


def shared_slot(member_index: int, index: int):
    """The four skills somebody else wrote, two across and two down under a divider."""
    x = CARD_XS[member_index] + 14
    return x + (index % 2) * 124, CARD_Y + 146 + (index // 2) * 24, 118, 20


# --- the frame ----------------------------------------------------------------------------

# Every chip, in the order they are written and in the order they land in the pool.
CHIPS = [
    (m, s, member["skills"][s], member["colour"])
    for m, member in enumerate(MEMBERS)
    for s in range(2)
]

WRITE_START, WRITE_STEP, WRITE_LEN = 1, 4, 5
TRAVEL_START, TRAVEL_STEP, TRAVEL_LEN = 30, 3, 14
POOL_FULL = TRAVEL_START + TRAVEL_STEP * 5 + TRAVEL_LEN  # 59
SHARE_START, SHARE_STEP, SHARE_LEN = 68, 5, 9
TOTAL = 112

CAPTIONS = (
    (0, "Everyone records what they know, in their own folder"),
    (TRAVEL_START, "Each publishes to their own collection"),
    (POOL_FULL, "One alias spans every collection"),
    (SHARE_START, "Now anyone can find anyone's"),
)

NOTES = (
    (0, "write_skill"),
    (TRAVEL_START, "publish"),
    (POOL_FULL, "embedder.skillsAlias"),
    (SHARE_START, "search_team_skills  -  returns the body, not a path"),
)


def latest(table, frame: int) -> str:
    chosen = table[0][1]
    for at, value in table:
        if frame >= at:
            chosen = value
    return chosen


def render(frame: int) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    draw.text((48, 30), "Team skills", font=F_TITLE, fill=TEXT)
    draw.text((48, 66), latest(CAPTIONS, frame), font=F_CAPTION, fill=MUTED)

    for index, member in enumerate(MEMBERS):
        card(draw, CARD_XS[index], member["name"], member["colour"])

    # The pool, dim until anything is in it — an empty box drawn as though it were full would
    # say the sharing exists before it does.
    filled = sum(1 for i in range(6) if frame >= TRAVEL_START + TRAVEL_STEP * i + TRAVEL_LEN)
    warmth = 0.0 if filled == 0 else min(1.0, filled / 6)
    draw.rounded_rectangle(
        (POOL_X, POOL_Y, POOL_X + POOL_W, POOL_Y + POOL_H),
        radius=10,
        fill=POOL,
        outline=blend(BORDER, (90, 100, 120), warmth * 0.7),
        width=1,
    )
    draw.text((POOL_X + 14, POOL_Y + 16), "Shared skills pool", font=F_NAME, fill=TEXT)
    draw.text(
        (POOL_X + 160, POOL_Y + 19),
        "one collection each, one alias across them",
        font=F_SMALL,
        fill=MUTED,
    )

    # Lines from the pool back up, once anything is being found through it.
    reach = ramp(frame, SHARE_START - 2, 12)
    if reach > 0:
        for index in range(3):
            top = CARD_XS[index] + CARD_W / 2
            card_bottom, pool_top = CARD_Y + CARD_H, POOL_Y
            # Grows upward *from* the pool, because that is the direction the skill travels when
            # somebody finds a colleague's. Drawn the other way round it read as publishing again.
            end = pool_top + (card_bottom - pool_top) * reach
            draw.line((top, pool_top, top, end), fill=blend(BG, (70, 80, 98), reach), width=1)

    # Empty slots, so a card does not appear to shrink while its chips are in flight.
    for index in range(3):
        for slot in range(2):
            x, y, w, h = own_slot(index, slot)
            draw.rounded_rectangle((x, y, x + w, y + h), radius=6, outline=FAINT, width=1)
    for index in range(6):
        x, y, w, h = pool_slot(index)
        draw.rounded_rectangle((x, y, x + w, y + h), radius=6, outline=FAINT, width=1)

    in_flight = []
    for index, (member, slot, label, colour) in enumerate(CHIPS):
        appear = WRITE_START + index * WRITE_STEP
        go = TRAVEL_START + index * TRAVEL_STEP
        land = go + TRAVEL_LEN

        x, y, w, h = own_slot(member, slot)
        alpha = ramp(frame, appear, WRITE_LEN)
        # Drawn for every frame after it is written, flight included. Publishing is a *copy*, and
        # a card that emptied while the copy travelled would say the skill had been handed over.
        # Slides up as it appears, which reads as being typed rather than switched on.
        chip(draw, x, y + (1 - alpha) * 8, w, h, label, colour, alpha=alpha)

        if go <= frame < land:
            u = ease((frame - go) / TRAVEL_LEN)
            sx, sy, sw, sh = own_slot(member, slot)
            dx, dy, dw, dh = pool_slot(index)
            in_flight.append(
                (
                    sx + (dx - sx) * u,
                    sy + (dy - sy) * u,
                    sw + (dw - sw) * u,
                    sh,
                    label,
                    colour,
                )
            )
        elif frame >= land:
            px, py, pw, ph = pool_slot(index)
            chip(draw, px, py, pw, ph, label, colour, over=POOL)

    for x, y, w, h, label, colour in in_flight:
        chip(draw, x, y, w, h, label, colour, over=BG)

    # What each person gains: the other four, outlined, under a divider.
    for index in range(3):
        alpha = ramp(frame, SHARE_START + index * SHARE_STEP, SHARE_LEN)
        if alpha <= 0.01:
            continue
        x = CARD_XS[index] + 14
        draw.line(
            (x, CARD_Y + 134, x + CARD_W - 28, CARD_Y + 134),
            fill=blend(PANEL, BORDER, alpha),
            width=1,
        )
        others = [c for c in CHIPS if c[0] != index]
        for position, (_, _, label, colour) in enumerate(others):
            sx, sy, sw, sh = shared_slot(index, position)
            chip(draw, sx, sy, sw, sh, label, colour, solid=False, alpha=alpha)

    draw.text(
        (48, HEIGHT - 44), latest(NOTES, frame), font=F_MONO, fill=blend(MUTED, TEXT, 0.25)
    )
    return image


def main() -> None:
    frames = [render(frame) for frame in range(TOTAL)]

    # One palette for the whole animation. Per-frame adaptive palettes make flat colours shimmer
    # between frames, which on a diagram reads as a rendering fault rather than a style.
    base = frames[0].quantize(colors=128, method=Image.MEDIANCUT)
    quantised = [base] + [f.quantize(palette=base, dither=Image.NONE) for f in frames[1:]]

    out = Path(__file__).resolve().parent.parent / "docs" / "gifs" / "team-skills.gif"
    out.parent.mkdir(parents=True, exist_ok=True)
    quantised[0].save(
        out,
        save_all=True,
        append_images=quantised[1:],
        duration=[FRAME_MS] * (TOTAL - 1) + [600],  # a beat before it loops; see below
        loop=0,
        # Pillow merges runs of identical frames and sums their durations, so the closing hold is
        # already seconds long before this adds to it — which is why the extra is small.
        optimize=True,
        disposal=2,
    )
    print(f"[gif] {TOTAL} frames -> {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
