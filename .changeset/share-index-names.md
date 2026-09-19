---
'light-code-vscode': patch
'@chosengeneration/light-code': patch
---

Exported search settings no longer carry the index names that identify you

Sending a colleague your search setup is how they join a team skills pool — they need the store,
the alias, and an embedding model of the same width. But `embedder.indexName` and the `retrieval`
index names sit under the same settings, and everyone must publish to their *own* collection.
Exporting them pointed the importer at the exporter's index; the symptom was skills appearing to
vanish when a colleague reindexed.

Those three names are now left out of an export and preserved on an import, and the chooser says
so beside the section. The aliases, the store and the embedding model still travel, because those
are the parts that have to match.
