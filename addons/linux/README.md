# Linux add-on for Light Code and Fire Code

Lets the assistant look at your Linux machines over SSH: run **read-only** commands (disk, memory,
processes, logs, services, containers) and **download files** to investigate them here.

```
npm i -g @chosengeneration/light-code-addon-linux
```

Then open Light Code or Fire Code settings:

1. **Settings → Add-ons** (the puzzle piece) **→ Linux → Enable**, read the program it will run, and
   confirm. Installed globally, it is found by itself - no folder to set.
2. A **Linux** tab appears beside it (it is there only while the add-on is installed and enabled;
   disable it and the tab goes, keeping your machines). Add your machines, each with a short
   **label** - what you and the assistant will call it (`prod-web-1`) - and press **Test connection**.

Ask things like *"why is prod-web-1 slow?"*, *"check the disk on the db machines"* or *"download the
last app log from web2 and find the errors"*. Every command is shown to you for approval like any
other tool, and the MCP tab's Always / Ask / Never applies per tool.

## Signing in

| Choice | Use when |
|---|---|
| **Pageant** (default) | You use PuTTY: load your key into Pageant once, and every connection uses it. Works with every PuTTY key format. Found by itself while it runs; needs PuTTY 0.75 (2021) or later. |
| **Windows OpenSSH agent** | Your key is added with `ssh-add` (the *OpenSSH Authentication Agent* service). |
| **Private key file** | An OpenSSH key, or an older PuTTY `.ppk` (version 2, RSA). For a newer `.ppk`, use Pageant, or in PuTTYgen choose *Conversions → Export OpenSSH key*. |
| **Password** | Kept in Light Code's secret storage, never in a file. |

A refused sign-in is **never retried**, so the assistant cannot lock your account.

**No SSH key yet?** Add the machine with **Password**, then press **Set up SSH key** on it. In one
press it:

1. makes a key for this PC, `%USERPROFILE%\.ssh\light-code_ed25519` - once, then reused for every
   machine; an existing one is never replaced;
2. signs in with the stored password and adds the key's **public** half to `~/.ssh/authorized_keys`
   on the machine (once, with the permissions the server requires) - the private half never leaves
   your PC;
3. signs in again with the key alone to prove it works, and only then switches the machine to the key.

If the server refuses keys, the machine stays on its password and you are told what the server may be
refusing. The password stays stored until you remove it with Edit. This is the one thing the add-on
writes to a machine, so it is a button only: the assistant does not have it.

**Jump hosts:** add the bastion as a machine too, then put its label in *Connect through* on the
machine behind it.

## Why it does not trip security monitoring

- **No new program.** SSH is done by a JavaScript library inside the Node process that already runs
  Light Code - not by `plink.exe`, `ssh.exe` or a helper binary. Nothing new starts on your computer,
  and nothing is installed but this package's JavaScript.
- **One sign-in per machine**, kept open and reused for ten idle minutes, rather than a login per
  command - so the Linux side sees one session, not a burst of logins.
- **Nothing that changes a machine can be sent** (below), and nothing is retried after a refusal.

## Read-only, enforced

Before a command is sent, it is checked: only programs that cannot change anything (`cat`, `tail`,
`grep`, `ls`, `find`, `df`, `du`, `free`, `ps`, `top -b -n 1`, `ss`, `ip addr`, `journalctl`,
`systemctl status`, `docker ps/logs/inspect`, `kubectl get/describe/logs`, and about a hundred
more), joined with `|` if needed. Refused:

- chaining, redirecting and substitution: `;` `&&` `||` `>` `<` `$(...)` backticks, new lines;
- programs that can write or run others: `rm`, `sed`, `awk`, `perl`, `python`, `xargs`, `sudo`, `su`;
- flags that write or never end: `find -delete/-exec`, `sort -o`, `tail -f`, `journalctl --vacuum-*`,
  `dmesg -c`, `date -s`, `systemctl restart`, `docker logs -f`, `kubectl delete`...

A program you know only reads can be added under **Also allow these programs** on the Linux tab.

## Host keys

A machine's host key is trusted the first time and checked every time after. If it changes, the
connection is refused and nothing is sent - that happens when a machine is rebuilt, or when
something is intercepting the connection. Press **Forget host key** only once you know which.

## Downloads

Files go to Light Code's storage (per codebase in Fire Code), under the machine's label, keeping
their path - e.g. `.../addons/addon-linux/downloads/prod-web-1/var/log/app/server.log` - and the
assistant reads them there without asking. Folders are not downloaded; the size limit is on the tab
(100 MB by default).

## Seeing its tools

The **Linux** tab lists the tools it gives the assistant - `machines`, `run`, `download`,
`test_connection`, `forget_host_key` - each with **Ask first / Always allow / Never**, changed right
there. *Set up SSH key* is not among them: it is a button, not a tool.

## Settings

Machines, labels and options are kept in your Light Code settings; passwords and passphrases in its
secret storage. In Fire Code, codebases with their own settings each have their own list - link them
to one settings file to share it.
