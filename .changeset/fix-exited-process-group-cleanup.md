---
"@effect/platform-node-shared": patch
---

Clean up surviving process-group descendants when a referenced child process's scope closes after its leader has already exited, including honoring `forceKillAfter`. This applies to Node.js and Bun. Descendants that create another process group or session remain outside this cleanup boundary; the default without `forceKillAfter` still does not send `SIGKILL`.
