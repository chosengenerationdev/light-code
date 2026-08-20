## Point it at a model

Light Code ships with **no endpoints at all**. A fresh install contacts nothing until you
say where to go — that is deliberate, and it is why this step comes first.

1. Open the **Light Code** icon in the Activity Bar.
2. Click the gear, then **Providers → Add provider**.
3. Pick a preset, paste an API key, choose a model, and **Save**.

Every field a preset fills in stays editable. If you are behind a corporate gateway, the
**Network** tab takes your CA certificate once and applies it to everything — the gateway,
the token endpoint, and anything else it talks to.

Stuck on a connection? **Test Connection** in the provider form runs
certificates → token → model list and tells you *which* step failed.
