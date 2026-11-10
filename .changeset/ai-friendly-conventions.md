---
'cleanstack-generator': minor
---

Generate AI-agent support files with every project: a workspace `AGENTS.md`, a
full-stack `ARCHITECTURE.md`, and a `.ai/` rules folder (architecture,
naming conventions, protected regions, and the entity workflow) that both
humans and AI coding agents follow. The files render from a new `project`
template pack, refresh with `cleanstack regenerate`, and preserve team notes
through their protected regions. The doctor command now also checks the new
pack's template integrity.
