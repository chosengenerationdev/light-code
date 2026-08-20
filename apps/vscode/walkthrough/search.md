## Find things by meaning

**Settings → Search**, off by default.

Point it at a vector store and it can search your codebase semantically rather than by grep:

- **Qdrant** or **Chroma** in a container on your own machine — your code is embedded and
  stored locally.
- **OpenSearch**, if your organisation already runs a cluster. That one can also query indexes
  you already have, with raw query DSL.

Embedding uses one of your existing provider profiles, so there is no second endpoint or
credential to set up.

**The dispatcher**, on the same tab, keeps tool schemas out of the prompt when you have more
tools than context. Hidden tools stay fully callable — the assistant looks one up when it needs
it. It pays off at forty tools and costs you at three, so the tab shows the count.

Switching store later? **Copy an existing index here** moves the vectors across instead of
re-embedding everything.

**Settings → Tools** lists everything the assistant can currently call, from every source.
