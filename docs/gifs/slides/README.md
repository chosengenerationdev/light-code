# Slide segments

Each animation in `../` cut into its own beats, for presenting.

**A GIF cannot be paused.** PowerPoint plays one start to finish — no scrub bar, no stop button,
no way to hold it while you talk. So the only way to pause at a step is for the animation to *end*
there. That is what these are: each segment plays once, stops on its last frame, and stays there
until you click through to the next slide.

## Using them

One segment per slide, in numerical order:

| Slide | File |
|---|---|
| 1 | `scheduled-logs-1.gif` |
| 2 | `scheduled-logs-2.gif` |
| … | … |

Insert with **Insert → Pictures**, not Insert → Video. PowerPoint animates a GIF automatically
when the slide appears, so there is nothing to configure — no autoplay setting, no trigger, no
transition timing. Talk for as long as you like; the picture holds the last frame.

Each segment opens on the state the previous one ended in, so the story carries across the slides
rather than restarting. Nothing is lost by pausing between them.

A `.png` sits beside every `.gif` — the same final frame. Use it for a handout, for printing, or
for anywhere a GIF will not play. Swapping one in loses only the motion.

## If you want to scrub rather than click

These stop; they do not seek. If you need to run a step backwards, or hold halfway through one,
a video is the right format — PowerPoint gives an MP4 a scrub bar and a pause. Nothing here
produces one (there is no encoder on the machine these were built on), but the frames are
rendered individually and could be handed to `ffmpeg` if that becomes worth doing.

## Regenerating

These are produced by the same two generators as the looping versions, and are not edited by
hand:

```bash
pip install Pillow
python scripts/generate-feature-gifs.py
python scripts/generate-team-skills-gif.py
```

The cut points are the **caption changes** in each scene, read from the same table the captions
themselves come from. That is deliberate: the captions already mark the moment the thing being
described changes, so cutting anywhere else would put a caption change in the middle of a segment
somebody is talking over. Add or move a caption and the segments follow.
