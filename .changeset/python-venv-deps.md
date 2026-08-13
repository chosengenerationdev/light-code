---
'light-code-vscode': minor
---

Python tools now use your project's virtualenv and can install dependencies.

**It finds the venv you already have.** If the workspace contains `.venv`, `venv`, `.env` or
`env` with a working interpreter, that is what tools run in — and the tab says so, including
whether uv created it. That matters because your project's environment is where your internal
libraries are already installed; a private one would be empty, and a tool importing a company
package would fail in a way that looks like a bug rather than a missing install. A private
venv is still created if the project has none, and `python.venvPath` overrides both.

The tradeoff is stated in the tab rather than hidden: reusing the project venv means a tool's
dependencies are installed *into your project's environment*.

**PEP 723 dependencies actually install now.** Previously the model was told to declare them
and nothing ever installed them, so a tool needing a library failed on an `ImportError` that
pointed nowhere useful. Dependencies are installed before validation, so a failure names the
package and the index it was looked for on, and the model is told not to retry unchanged.

**Package index is configurable** — point it at your internal mirror to make company packages
installable and avoid reaching public PyPI at all. There is also an offline switch that
refuses the network entirely.

The path to `uv` now has a Browse button.
