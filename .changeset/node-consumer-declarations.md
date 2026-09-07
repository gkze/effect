---
"effect": patch
---

Make `Channel.decodeText` options compatible with Node-only TypeScript projects without requiring DOM types. Remove an internal CLI helper from published declarations so it cannot reference metadata functions removed during declaration stripping.
