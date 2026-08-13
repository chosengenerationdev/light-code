---
'light-code-vscode': patch
---

Fix indexing rejecting documents, and let you name the index.

**"failed to parse field [vector] of type [knn_vector] … preview of field's value: null"** —
the vector check confirmed the response was an array of the right length but never that its
elements were numbers. `JSON.stringify([1, NaN, 3])` is `[1,null,3]`, so a single bad float
arrived as a null and the whole document was rejected, with an error pointing at the mapping
when the mapping was fine. Every element is now checked, and the failure names the model, the
position, and where to look.

**A width mismatch is now caught up front.** A vector field's dimension is fixed when the
index is created, so pointing a differently-sized embedding model at an existing index used
to fail on every single write with a mapping error that never said why. It now refuses
immediately and tells you to change the width back or use a different index name.

**The index name is yours to choose** (Settings → Search). Leave it blank and one is derived
from the workspace path — collision-free, but nobody looking at a shared cluster can tell
whose `light-code-a3f2…` it is. It is also how you move to a new index after changing
embedding model, since the old one's width cannot be altered.
