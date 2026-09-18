---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

Charts and diagrams can be asked for smaller

Reported from the Node host: a chart filled the whole window, and asking the assistant for a
smaller one got nowhere — because there was nothing to ask *for*. The request was that it work for
every kind of picture, diagrams included.

So `size` is one shared vocabulary rather than a field invented twice: `small` (an aside), `medium`
(the ordinary case), `large` (worth studying), `full` (the whole width). A chart and a diagram
asked for "small" get the same width, and the next kind of picture inherits it rather than adding
a third spelling.

**A word rather than a pixel count**, because the model cannot know how wide the panel is — a
sidebar in the extension, most of a window in the browser, and the same 900 pixels is comfortable
in one and absurd in the other. The word says what was meant; the panel decides what it is worth
there.

It caps, never stretches: a diagram narrower than its size is left alone rather than blown up.
`full` is what everything did before, and is still the default, so nothing already drawn changes.

The chart's own bug is fixed with it. Its drawing was `width: 100%` inside a card with no width of
its own, so "how big is this chart" was answered entirely by how wide the panel happened to be. The
cap is on the card, which bounds the title, legend and numbers table too — capping the drawing
alone would have left those sticking out.
