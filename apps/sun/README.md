# Sun Code

Every codebase you work on, in one Windows window — each with its own
[Light Code](https://github.com/chosengenerationdev/light-code) agent, all working at the same time.

- **A sidebar of codebases.** Add any folder on your machine. Switch with a click, `Ctrl+1…9`, or
  `Ctrl+K` and a few letters. Hide the sidebar with `Ctrl+B` for more room; a slim strip keeps
  every agent's status in view.
- **Agents keep working in the background.** Each codebase runs in its own process, so a long task
  in one never slows another, and switching away pauses nothing.
- **Your existing settings.** Point a codebase at the Light Code config it already has — the VS Code
  extension's, or the Node host's that IntelliJ and PyCharm use — and its providers, MCP servers,
  search connections and project settings apply in place. Or copy one, or start fresh.
- **Windows notifications** when a background agent finishes, needs your approval, or sends one
  with `notify` — including scheduled runs. Click one to jump to that chat.
- **Schedules run on time even for sleeping codebases**: Sun wakes a codebase just before its job is due
  and lets it sleep again afterwards.
- **Idle codebases sleep** after a while to give memory back (never while working, waiting for you,
  or holding schedules), and wake in a moment when clicked.
- **Reach beyond the codebase**: agents read any drive or shared folder, and may write anywhere — asking
  you every time they write outside the codebase. Keys, passwords and Windows folders stay off-limits.
- **Fast, parallel file tools** written in Rust: find files across whole drives and shares, summarise a
  folder, spot duplicates, read many files at once, and work through huge logs and CSV or Excel files
  part by part — search, read any window, filter, group and total millions of rows in about a second.
- **Copy, move and zip** whole folders on every core — always asking first, with exactly what will be
  copied, moved, replaced or extracted.
- **Several chats per codebase**, each its own agent, safe to run side by side.
- **Reports in Sun**: Markdown and HTML reports from scheduled runs open in Sun's own viewer.
- **One environment for every agent**: a startup script (.cmd, .bat or .ps1), folders to put on PATH,
  and variables — plain values or saved credentials.
- **Everything Light Code does**: the same tools, MCP, Python tools, skills, Excel and Outlook,
  Confluence, Jira, Bitbucket, Jenkins, AutoSys, search and schedules — it is the same agent.

## Install

```
npm i -g @chosengeneration/sun-code
sun-code
```

Used **Sun Light Code** before? Sun Code is its new name. Your codebases, chats and credentials move
across by themselves the first time Sun Code starts; then remove the old package with
`npm uninstall -g @chosengeneration/sun-light-code`.

Windows 10 or 11 (x64) and Node.js 18 or newer. The package is prebuilt: it has **no install
scripts and no dependencies**, so installing only copies files — nothing is compiled and nothing is
downloaded, which is what makes it install cleanly on a locked-down office machine. The window uses
Microsoft Edge WebView2, which comes with Windows 11 (and with Edge on Windows 10).

## Settings and keys

When you add a codebase you choose where its Light Code settings come from:

| Choice | What happens |
|---|---|
| **Link** | Uses an existing `config.json` in place. Changes made in Sun or in the other app reach both. |
| **Copy** | Takes a copy now; independent afterwards. |
| **New** | Empty settings, set up in that codebase's Settings. |

A folder's own `.lightcode/config.json` is always used, whichever you choose.

**API keys and passwords are not in config files.** The VS Code extension keeps them in VS Code's
encrypted storage, which another program cannot read, so enter each once in Sun — it then shares
them with every codebase. Sun keeps them in `%LOCALAPPDATA%\sun-code\secrets.json`, readable
by your Windows account only, not in an OS keychain; it says so rather than implying otherwise.

## What it connects to

Nothing on its own. Like Light Code, Sun has no telemetry, no update checks and no default
endpoints: the only hosts contacted are the ones you configure. Each codebase's agent runs on
`127.0.0.1` behind a one-time token, and is stopped — with every process it started — when Sun
closes.

## Theme

Settings (`Ctrl+,`) chooses light, dark or system and an accent colour. Every chat follows them,
and so do the window and taskbar icons; each chat keeps its own role colours.

## Building it

The source is in [`apps/sun`](https://github.com/chosengenerationdev/light-code/tree/main/apps/sun)
of the Light Code repository, and Sun's Settings can export the whole repository as a zip that
builds offline. You need Rust 1.86+ (MSVC) and pnpm; then `node apps/sun/scripts/build.mjs`.

MIT licensed.
