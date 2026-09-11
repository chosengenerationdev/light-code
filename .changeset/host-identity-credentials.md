---
'@chosengeneration/light-code': minor
---

Take the current user and credentials from your own Python functions

For an environment whose own libraries are the only thing that knows who is
logged in and where the passwords are.

    light-code --identity-tool whoami.py --credential-tool creds.py

`whoami.py` defines `run() -> str` and settings, secrets and history are filed
under whatever it returns. `creds.py` defines `run(name)` returning a string or a
dict; a secret stored as `tool:<name>` is fetched from it on use instead of being
kept on disk, and `tool:<name>#field` picks one field of a pair.

The credential function is a source of secrets, not a tool the assistant can
call: everything that needs one — the gateway key, a search cluster's username
and password, a certificate passphrase, an MCP server's environment — already
resolves through the same interface, and a tool the model called would put the
password in the transcript.

Both refuse rather than guess. A function returning None does not become a user
called None; a credential missing the field you asked for names the fields it did
return instead of answering with an empty string, because an empty password comes
back from a gateway as "your credentials are wrong" and sends you to check
something that was never sent.

The startup banner prints the resolved user and which file secrets come from.
