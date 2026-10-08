---
"@effect/platform-node-shared": patch
---

Retry process-group existence probes within the existing cleanup bounds when they fail with permission or unexpected errors; only `ESRCH` confirms absence. Signal failures no longer bypass verification.

Unconfirmed termination now fails `kill` with a native `PlatformError` and causes scoped release of a referenced process to die with that same error. Match `error.reason.module === "ChildProcess"` and `error.reason.method === "verifyTermination"` to retain resources that must not be released while descendants may still be running. The reason tag is `PermissionDenied` or `Unknown` for persistent probe errors, preserving their original cause, or `TimedOut` when the group remains present after configured `forceKillAfter` escalation. Pipeline kills attempt every process before surfacing verification failures. Cleanup of an unreferenced process remains best-effort.

The default without `forceKillAfter` still does not escalate, and known surviving groups can still outlive that default bounded wait. Cleanup covers the owned process group, not descendants that create another group or session.
