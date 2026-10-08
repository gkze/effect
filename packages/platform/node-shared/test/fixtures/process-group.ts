import { spawn } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"

// The descendant stays in the leader's process group, with either inherited
// or ignored stdio. It exits after its delay (200ms by default) on SIGTERM or
// ignores the signal while writing heartbeats. The leader exits normally, or
// on SIGTERM (immediately unless a delay is supplied).
const [role, mode, marker, leaderDelay = "0", descendantDelay = "200"] = process.argv.slice(2)

if (role === "leader") {
  const isolatedStdio = mode === "ignore-signal-no-stdio" || mode === "exit-leader"
  const child = spawn(process.execPath, [process.argv[1], "descendant", mode, marker, leaderDelay, descendantDelay], {
    stdio: isolatedStdio ? ["ignore", "ignore", "ignore", "ipc"] : ["ignore", "inherit", "inherit"]
  })
  child.on("message", () => {
    process.stdout.write(`READY ${child.pid}\n`, () => {
      if (mode === "exit-leader") process.exit(0)
    })
  })
  if (Number(leaderDelay) > 0) {
    process.on("SIGTERM", () => setTimeout(() => process.exit(0), Number(leaderDelay)))
  }
  process.stdin.once("data", (data) => process.exit(data.toString().trim() === "exit 1" ? 1 : 0))
  setInterval(() => {}, 1_000)
} else {
  if (mode === "exit-on-signal") {
    process.on("SIGTERM", () => {
      setTimeout(() => {
        writeFileSync(marker, "exited")
        process.exit(0)
      }, Number(descendantDelay))
    })
  } else {
    process.on("SIGTERM", () => {})
    appendFileSync(marker, "x")
    setInterval(() => appendFileSync(marker, "x"), 10)
  }
  setTimeout(() => process.exit(1), 5_000)
  if (process.send) {
    process.send("ready", () => process.disconnect?.())
  } else {
    process.stdout.write(`READY ${process.pid}\n`)
  }
}
