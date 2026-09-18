---
'light-code-vscode': patch
'@chosengeneration/light-code': patch
---

Attachments on a queued message are no longer lost

Reported from real use. A message typed while a turn is running is queued host-side and folded in
at the next safe point — but the queue held **only text**, and the composer dropped the images
before they ever left the panel. So the words arrived, the screenshot they were about did not, and
the model was asked about something it had never been shown. Nothing on screen said so, which makes
it read as the model ignoring the attachment.

The queue carries them now, on both paths: folded in mid-turn, and the leftover case where a turn
ended before reaching a safe point. That second one mattered more than it looks — there is no
visible seam there, so the loss would be even harder to notice.

The **same vision check** applies as on the ordinary path: a queued image for a model that does not
accept them is reported rather than sent, instead of failing somewhere much further along. And the
queued row in the composer now says `[1 image]`, so what is waiting is visible rather than implied.
