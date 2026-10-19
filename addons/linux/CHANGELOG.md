# @chosengeneration/light-code-addon-linux

## 0.2.1

- **Fixed: signing in with Pageant.** It went through a helper program the SSH library starts (`pagent.exe`), which the bundled add-on did not carry - so it could not work - and which would have been a new program running on your PC. Pageant is now reached through its own named pipe, found automatically while it runs, with nothing started. Needs PuTTY 0.75 (2021) or later.

## 0.2.0

- The Linux tab lists the tools it gives the assistant, each with Ask first / Always allow / Never. It shows only while the
  add-on is enabled (Settings → Add-ons).
- **Set up SSH key**: on a machine that signs in with a password, one press makes this PC's key (once), adds its public half to the machine's `authorized_keys`, proves it, and switches the machine to key sign-in. A button only; the assistant does not have it. Needs Light Code 0.170.0, the Node host 0.144.0 or Fire Code 0.39.0 - older ones do not offer it at all.

## 0.1.0

- First release: a Linux tab to add machines with labels; `machines`, `run` (read-only, enforced), `download` (SFTP), `test_connection` and `forget_host_key`. Pageant, the Windows OpenSSH agent, key files and passwords; jump hosts; host keys trusted on first use and then checked. SSH runs inside Node, with no program of its own. Needs Light Code 0.169.0, the Node host 0.143.0 or Fire Code 0.38.0 for its tab.
