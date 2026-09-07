---
"@effect/platform-node-shared": patch
---

Preserve symbolic link targets by default when copying files and directories with `FileSystem.copy` on Node and Bun. Relative links within a copied directory remain relative instead of being rewritten to absolute paths into the source directory. No new option is required. All link targets are copied verbatim; links pointing outside the copied directory are not isolated.
