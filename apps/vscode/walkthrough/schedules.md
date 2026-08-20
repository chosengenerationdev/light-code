## Let it run on its own

**Settings → Schedules** runs a prompt on an interval, daily, or on chosen weekdays.

- Each schedule has its **own list of tools**, ticked by you when you write it. The default is
  **nothing** — a run that should only read gets only reading.
- Ticking editing tools is how you authorise unattended edits. Installing Python tools or
  skills can never be granted this way: that is authorising a *capability*, not a change.
- Runs happen in the background without touching the conversation you are in, and leave a
  normal task you can open afterwards.
- The **notify** tool lets a run reach you when the panel is closed, and can attach a Markdown
  report you open in an editor tab.
- Run history is on the tab, with the transcript of each one.

Schedules only fire while VS Code is open — there is no background service, and the tab says so.
