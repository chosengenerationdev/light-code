#!/usr/bin/env python3
"""Shared drawing for the animated diagrams in `docs/gifs/`.

Extracted when the second one was written, for the reason this repository keeps returning to: one
fact declared in two places drifts. A palette, a chip and a fade copied per file would mean eight
diagrams that slowly stop looking like each other, and nothing would fail when they did.

Run by hand, never in CI (see `generate-feature-gifs.py`). Needs Pillow.
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# --- palette ------------------------------------------------------------------------------
#
# Two of these are the product's own defaults (`ui.accentColor`, `ui.expertColor`), so a picture of
# Light Code and the panel itself agree about what it looks like.

BG = (15, 17, 21)
PANEL = (26, 30, 38)
SUNKEN = (21, 25, 32)
BORDER = (42, 47, 58)
TEXT = (230, 232, 236)
MUTED = (138, 147, 163)
FAINT = (58, 64, 78)

GREEN = (34, 197, 94)
BLUE = (91, 157, 249)
ORANGE = (217, 119, 87)
PURPLE = (167, 139, 250)
RED = (239, 83, 80)
AMBER = (234, 179, 8)

WIDTH, HEIGHT = 960, 530
FRAME_MS = 70


def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    root = Path(os.environ.get("SystemRoot", "C:/Windows")) / "Fonts"
    for candidate in (name, "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(str(root / candidate), size)
        except OSError:
            continue
    return ImageFont.load_default()


F_TITLE = _font("segoeuib.ttf", 25)
F_CAPTION = _font("segoeui.ttf", 15)
F_NAME = _font("segoeuib.ttf", 15)
F_BODY = _font("segoeui.ttf", 13)
F_SMALL = _font("segoeui.ttf", 11)
F_CHIP = _font("segoeui.ttf", 12)
F_MINI = _font("segoeui.ttf", 10)
F_MONO = _font("consola.ttf", 11)
F_MONO_S = _font("consola.ttf", 10)


# --- timing -------------------------------------------------------------------------------


def blend(a, b, t: float):
    """`a` toward `b` by `t`. Every fade goes through this, so nothing needs an alpha channel."""
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def ease(u: float) -> float:
    """Cubic in-out. Something that starts and stops abruptly reads as a jump, not a journey."""
    u = max(0.0, min(1.0, u))
    return 4 * u * u * u if u < 0.5 else 1 - pow(-2 * u + 2, 3) / 2


def ramp(frame: int, start: int, length: int) -> float:
    """0 before `start`, 1 once it has run for `length` frames."""
    if frame < start:
        return 0.0
    return min(1.0, (frame - start) / max(1, length))


def pulse(frame: int, start: int, length: int) -> float:
    """0 -> 1 -> 0 across `length`, for something that flashes rather than arrives."""
    u = ramp(frame, start, length)
    return 0.0 if u <= 0 or u >= 1 else 1 - abs(u * 2 - 1)


def latest(table, frame: int):
    """The last entry in `[(frame, value), ...]` whose frame has been reached."""
    chosen = table[0][1]
    for at, value in table:
        if frame >= at:
            chosen = value
    return chosen


# --- surface ------------------------------------------------------------------------------


class Canvas:
    """A frame, with the pieces every one of these diagrams is built from."""

    def __init__(self, title: str, caption: str, note: str | None = None):
        self.image = Image.new("RGB", (WIDTH, HEIGHT), BG)
        self.d = ImageDraw.Draw(self.image)
        self.d.text((48, 30), title, font=F_TITLE, fill=TEXT)
        self.d.text((48, 66), caption, font=F_CAPTION, fill=MUTED)
        if note is not None:
            self.d.text((48, HEIGHT - 44), note, font=F_MONO, fill=blend(MUTED, TEXT, 0.25))

    # -- containers

    def panel(self, x, y, w, h, *, title=None, subtitle=None, tone=PANEL, accent=None, alpha=1.0):
        if alpha <= 0.01:
            return
        outline = BORDER if accent is None else blend(BORDER, accent, 0.55)
        self.d.rounded_rectangle(
            (x, y, x + w, y + h),
            radius=10,
            fill=blend(BG, tone, alpha),
            outline=blend(BG, outline, alpha),
            width=1,
        )
        if title is not None:
            self.d.text((x + 14, y + 14), title, font=F_NAME, fill=blend(tone, TEXT, alpha))
        if subtitle is not None:
            self.d.text((x + 14, y + 36), subtitle, font=F_SMALL, fill=blend(tone, MUTED, alpha))

    @staticmethod
    def body(y: float, *, subtitle: bool = True) -> float:
        """Where a panel's content may start.

        A number rather than a habit, because the first version placed it by eye per scene and four
        of the seven collided with their own subtitle — the sort of fault that is invisible to
        everything except looking at the picture.
        """
        return y + (64 if subtitle else 44)

    def chip(self, x, y, w, h, label, colour, *, solid=True, alpha=1.0, over=PANEL, font=None):
        """One named thing: a skill, a tool, a field, a log line.

        `solid` is something this side owns; an outline is something reached from elsewhere. That
        distinction carries most of the meaning in these diagrams, so it is fill rather than a
        label nobody can read at this size.
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
        self.d.rounded_rectangle((x, y, x + w, y + h), radius=6, fill=fill, outline=line, width=1)
        self.d.rectangle((x + 1, y + 6, x + 3, y + h - 6), fill=line)
        face = font or (F_CHIP if h >= 24 else F_MINI)
        self.d.text((x + 12, y + h / 2), label, font=face, fill=ink, anchor="lm")

    def badge(self, x, y, w, h, label, colour, *, alpha=1.0, over=PANEL):
        """A status pill: ok, FAILED, #DIV/0!, 2,000 cells.

        Much stronger than `chip`, and deliberately so. A chip is a *named thing* whose colour says
        who owns it, so it is tinted and the label carries the meaning. Here the colour **is** the
        meaning — green and red have to be told apart at a glance and in a still frame — and the
        first version used the chip's own wash, which rendered every status the same grey.
        """
        if alpha <= 0.01:
            return
        self.d.rounded_rectangle(
            (x, y, x + w, y + h),
            radius=4,
            fill=blend(over, blend(colour, over, 0.35), alpha),
            outline=blend(over, colour, alpha),
            width=1,
        )
        self.d.text((x + w / 2, y + h / 2), label, font=F_MINI,
                    fill=blend(over, TEXT, alpha), anchor="mm")

    def slot(self, x, y, w, h):
        """An empty place, so a container does not appear to shrink while something is in flight."""
        self.d.rounded_rectangle((x, y, x + w, y + h), radius=6, outline=FAINT, width=1)

    # -- connections

    def arrow(self, x0, y0, x1, y1, progress, colour=(70, 80, 98), *, head=True, width=1):
        """A line that grows from (x0,y0) toward (x1,y1)."""
        if progress <= 0.01:
            return
        ex = x0 + (x1 - x0) * progress
        ey = y0 + (y1 - y0) * progress
        self.d.line((x0, y0, ex, ey), fill=colour, width=width)
        if head and progress > 0.92:
            size = 5
            if abs(x1 - x0) > abs(y1 - y0):
                sign = 1 if x1 > x0 else -1
                self.d.polygon(
                    [(ex, ey), (ex - sign * size, ey - size), (ex - sign * size, ey + size)],
                    fill=colour,
                )
            else:
                sign = 1 if y1 > y0 else -1
                self.d.polygon(
                    [(ex, ey), (ex - size, ey - sign * size), (ex + size, ey - sign * size)],
                    fill=colour,
                )

    def travellers(self, x0, y0, x1, y1, frame, start, length, colour, count=3, spacing=6):
        """Dots moving along a path — data going somewhere, rather than a static connection."""
        for index in range(count):
            u = ramp(frame, start + index * spacing, length)
            if u <= 0 or u >= 1:
                continue
            e = ease(u)
            cx, cy = x0 + (x1 - x0) * e, y0 + (y1 - y0) * e
            self.d.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), fill=blend(BG, colour, 0.9))

    # -- small pieces

    def label(self, x, y, text, *, font=F_SMALL, fill=MUTED, anchor=None):
        self.d.text((x, y), text, font=font, fill=fill, anchor=anchor)

    def avatar(self, x, y, name, colour, *, radius=9):
        self.d.ellipse((x, y, x + radius * 2, y + radius * 2), fill=blend(colour, PANEL, 0.25))
        self.d.text((x + radius * 2 + 8, y + radius), name, font=F_NAME, fill=TEXT, anchor="lm")

    def bar(self, x, y, w, h, fraction, colour, *, over=PANEL):
        """A horizontal progress or magnitude bar."""
        self.d.rounded_rectangle((x, y, x + w, y + h), radius=3, fill=blend(over, FAINT, 0.6))
        filled = max(0, min(w, w * fraction))
        if filled > 2:
            self.d.rounded_rectangle((x, y, x + filled, y + h), radius=3, fill=colour)

    def cursor(self, x, y, alpha=1.0):
        """A pointer, for the scenes where something is being operated rather than transferred."""
        if alpha <= 0.01:
            return
        ink = blend(BG, TEXT, alpha)
        self.d.polygon([(x, y), (x, y + 14), (x + 4, y + 10), (x + 8, y + 16), (x + 11, y + 14),
                        (x + 7, y + 8), (x + 12, y + 8)], fill=ink, outline=blend(BG, BG, alpha))


# --- output -------------------------------------------------------------------------------


def write_gif(frames, path: Path, *, frame_ms: int = FRAME_MS, end_hold: int = 600) -> None:
    """Quantises to one palette and writes the animation.

    A single palette for every frame, because per-frame adaptive palettes make flat colours shimmer
    between frames — on a diagram that reads as a rendering fault rather than a style.

    **The palette is built from a sample across the whole animation, not from the first frame.**
    That was a real defect and an invisible one: frame 0 is a title and some empty boxes, so a
    palette derived from it held almost no colour, and every diagram came out uniformly grey while
    the raw render was vivid. Nothing failed — the file was valid, the shapes were right, and only
    putting the two side by side showed it. A montage of evenly spaced frames sees every colour the
    animation actually uses.

    Note Pillow merges runs of identical frames and **sums** their durations, so a scene that holds
    is already seconds long before `end_hold` adds to it. That is why the extra is small.
    """
    step = max(1, len(frames) // 12)
    sample = frames[::step] or [frames[-1]]
    montage = Image.new("RGB", (frames[0].width, frames[0].height * len(sample)))
    for index, frame in enumerate(sample):
        montage.paste(frame, (0, index * frames[0].height))
    base = montage.quantize(colors=128, method=Image.MEDIANCUT)
    quantised = [f.quantize(palette=base, dither=Image.NONE) for f in frames]

    path.parent.mkdir(parents=True, exist_ok=True)
    quantised[0].save(
        path,
        save_all=True,
        append_images=quantised[1:],
        duration=[frame_ms] * (len(frames) - 1) + [end_hold],
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"[gif] {len(frames):3d} frames -> {path.name} ({path.stat().st_size / 1024:.0f} KB)")
