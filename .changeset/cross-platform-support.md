---
'cleanstack-generator': patch
---

Make CleanStack work consistently on Windows, macOS, and Linux. Generated and
merged files now follow a portable line-ending policy (CRLF for Windows scripts
such as `.cmd`, `.bat`, and `.ps1`; LF everywhere else), UTF-8 BOMs in
configuration, entity, and OpenAPI files are accepted, and project paths reject
Windows absolute, drive-relative, UNC, and reserved names. Commands
run through `cmd.exe` when needed, Windows `.cmd` shims resolve through
`PATHEXT`, and generated next steps, migrations, and doctor hints use the right
shell syntax for the current platform. New workspaces also include a
`.gitattributes`, and CI now covers macOS in addition to Linux and Windows.
