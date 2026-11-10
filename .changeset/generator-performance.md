---
'cleanstack-generator': patch
---

Speed up generation and CLI startup. Compiled Handlebars templates are now
cached per engine (with mtime/size invalidation), manifest files are written in
parallel with bounded concurrency while keeping per-destination order and
deterministic reporting, command modules load on demand, and the spinner
dependency (ora) is imported only when a spinner is shown. Synchronous
`startSpinner` behavior is preserved.
