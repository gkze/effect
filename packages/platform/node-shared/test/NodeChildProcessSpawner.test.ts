import { buildSpawnOptions } from "@effect/platform-node-shared/internal/nodeChildProcessSpawner"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { assert, describe, it } from "@effect/vitest"
import * as ChildProcessSpawnerTest from "effect-test/process/ChildProcessSpawnerTest"
import * as ByteSize from "effect/ByteSize"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { join } from "node:path"
import { vi } from "vitest"

const NodeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer
  ))
)

ChildProcessSpawnerTest.suite("NodeChildProcessSpawner", NodeServices, {
  processGroups: true
})

describe("buildSpawnOptions", () => {
  const base = { stdio: "pipe" } as const

  it("defaults to hiding non-detached Windows children", () => {
    assert.deepStrictEqual(buildSpawnOptions({}, base, "win32"), {
      stdio: "pipe",
      detached: false,
      shell: undefined,
      windowsHide: true
    })
    assert.deepStrictEqual(buildSpawnOptions({ detached: true }, base, "win32"), {
      stdio: "pipe",
      detached: true,
      shell: undefined,
      windowsHide: false
    })
    assert.deepStrictEqual(buildSpawnOptions({ detached: false }, base, "win32"), {
      stdio: "pipe",
      detached: false,
      shell: undefined,
      windowsHide: true
    })
  })

  it("allows windowsHide to be configured independently of detached", () => {
    assert.deepStrictEqual(
      buildSpawnOptions({ detached: false, windowsHide: false }, base, "win32"),
      {
        stdio: "pipe",
        detached: false,
        shell: undefined,
        windowsHide: false
      }
    )
    assert.deepStrictEqual(
      buildSpawnOptions({ detached: true, windowsHide: true }, base, "win32"),
      {
        stdio: "pipe",
        detached: true,
        shell: undefined,
        windowsHide: true
      }
    )
  })
})

it.live("kills every process in a pipeline", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const rootHeartbeat = `${directory}/root-heartbeat`
    const childHeartbeat = `${directory}/child-heartbeat`
    const handle = yield* ChildProcess.make(
      "sh",
      [
        "-c",
        "printf x >> \"$1\"; printf 'ROOT_READY\\n'; while :; do printf x >> \"$1\"; sleep 0.01; done",
        "pipeline-root",
        rootHeartbeat
      ]
    ).pipe(ChildProcess.pipeTo(ChildProcess.make(
      "sh",
      [
        "-c",
        "printf x >> \"$1\"; printf 'CHILD_READY\\n'; read -r ready; printf '%s\\n' \"$ready\"; while :; do printf x >> \"$1\"; sleep 0.01; done",
        "pipeline-child",
        childHeartbeat
      ]
    )))
    const readyLines = yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.take(2),
      Stream.runCollect
    )
    assert.deepStrictEqual(readyLines, ["CHILD_READY", "ROOT_READY"])
    yield* handle.kill({ killSignal: "SIGKILL" })
    const rootSizeAfterKill = (yield* fs.stat(rootHeartbeat)).size
    const childSizeAfterKill = (yield* fs.stat(childHeartbeat)).size
    yield* Effect.sleep("100 millis")
    const rootFinalSize = (yield* fs.stat(rootHeartbeat)).size
    const childFinalSize = (yield* fs.stat(childHeartbeat)).size

    assert.strictEqual(ByteSize.toBigInt(rootFinalSize), ByteSize.toBigInt(rootSizeAfterKill))
    assert.strictEqual(ByteSize.toBigInt(childFinalSize), ByteSize.toBigInt(childSizeAfterKill))
  }).pipe(Effect.scoped, Effect.provide(NodeServices)))

const processGroupFixture = join(__dirname, "fixtures", "process-group.ts")

// Use native timers under TestClock.
const liveSleep = (millis: number) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), millis)
    return Effect.sync(() => clearTimeout(timer))
  })

const liveTimeout = (millis: number) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(effect, liveSleep(millis).pipe(Effect.andThen(Effect.die(new Error("timed out")))))

const startProcessGroup = (
  mode: "exit-on-signal" | "ignore-signal" | "ignore-signal-no-stdio" | "exit-leader",
  options?: ChildProcess.CommandOptions,
  directoryOverride?: string
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = directoryOverride ?? (yield* fs.makeTempDirectoryScoped())
    const marker = `${directory}/marker`
    const scope = yield* Scope.fork(yield* Effect.scope)
    const handle = yield* Scope.provide(scope)(ChildProcess.make(
      process.execPath,
      [processGroupFixture, "leader", mode, marker],
      { stdin: "ignore", ...options }
    ))
    const ready = yield* Deferred.make<number>()
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        line.startsWith("READY ") ? Deferred.succeed(ready, Number(line.slice("READY ".length))) : Effect.void
      ),
      Effect.forkScoped
    )
    const descendantPid = yield* Deferred.await(ready).pipe(liveTimeout(5_000))
    return { handle, descendantPid, marker, scope }
  })

const killDescendant = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  })

const assertHeartbeatStopped = (marker: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const sizeAfterKill = (yield* fs.stat(marker)).size
    yield* liveSleep(100)
    const finalSize = (yield* fs.stat(marker)).size
    assert.strictEqual(finalSize, sizeAfterKill)
  })

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const start = Date.now()
    yield* effect
    return Date.now() - start
  })

// Restrict faults to one group. Restore the global spy even when a cleanup
// assertion fails; all other process operations keep their native behavior.
const mockGroupKill = (pid: number, intercept: (signal: string | number | undefined) => true | void) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const originalKill = process.kill.bind(process)
      return vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && intercept(signal) === true) return true
        return originalKill(target, signal)
      })
    }),
    (kill) => Effect.sync(() => kill.mockRestore())
  )

describe.skipIf(process.platform === "win32")("process group cleanup", { concurrent: false }, () => {
  it.live("scope release cleans descendants after the leader exits successfully", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-on-signal", { stdin: "pipe" })
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))

      yield* Stream.run(Stream.make(new TextEncoder().encode("exit\n")), handle.stdin)
      assert.strictEqual(yield* handle.exitCode, 0)
      assert.doesNotThrow(() => process.kill(descendantPid, 0), "descendant must still be alive after the leader exits")
      assert.isFalse(yield* fs.exists(marker))

      yield* Scope.close(scope, Exit.void)

      assert.strictEqual(yield* fs.readFileString(marker), "exited")
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release force kills descendants after the leader exits with a non-zero code", () =>
    Effect.gen(function*() {
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("ignore-signal", {
        stdin: "pipe",
        forceKillAfter: "200 millis"
      })
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))

      yield* Stream.run(Stream.make(new TextEncoder().encode("exit 1\n")), handle.stdin)
      assert.strictEqual(yield* handle.exitCode, 1)

      yield* Scope.close(scope, Exit.void).pipe(liveTimeout(2_000))

      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release cleans descendants after the leader is killed externally", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-on-signal")
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))

      process.kill(handle.pid, "SIGKILL")
      assert.isTrue(Exit.isFailure(yield* Effect.exit(handle.exitCode)))
      assert.doesNotThrow(() => process.kill(descendantPid, 0), "descendant must survive the leader's SIGKILL")
      assert.isFalse(yield* fs.exists(marker))

      yield* Scope.close(scope, Exit.void)

      assert.isTrue(yield* fs.exists(marker), "scope release must wait for the descendant's exit marker")
      assert.strictEqual(yield* fs.readFileString(marker), "exited")
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release force kills descendants after the leader already exited", () =>
    Effect.gen(function*() {
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-leader", {
        forceKillAfter: "200 millis"
      })
      yield* Effect.gen(function*() {
        assert.strictEqual(yield* handle.exitCode, 0)
        yield* Scope.close(scope, Exit.void)
        yield* assertHeartbeatStopped(marker)
      }).pipe(Effect.ensuring(killDescendant(descendantPid)))
    }).pipe(Effect.provide(NodeServices)))

  it.live("scope release retries transient probe and signal EPERM before confirming termination", () =>
    Effect.gen(function*() {
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-leader", {
        forceKillAfter: "200 millis"
      })
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))
      assert.strictEqual(yield* handle.exitCode, 0)
      let deniedProbes = 0
      yield* mockGroupKill(handle.pid, (signal) => {
        if (signal === "SIGKILL") {
          // The group can become zombie-only between signalling and checking.
          process.kill(descendantPid, "SIGKILL")
          throw Object.assign(new Error("Permission denied"), { code: "EPERM" })
        }
        if (signal === "SIGTERM" || (signal === 0 && deniedProbes++ < 2)) {
          throw Object.assign(new Error("Permission denied"), { code: "EPERM" })
        }
      })

      const releaseMillis = yield* timed(Scope.close(scope, Exit.void))

      assert.isBelow(releaseMillis, 3_000)
      assert.isAtLeast(deniedProbes, 3)
      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.provide(NodeServices)))

  for (
    const { code, reason } of [
      { code: "EPERM", reason: "PermissionDenied" },
      { code: "EIO", reason: "Unknown" },
      { code: "present", reason: "TimedOut" }
    ] as const
  ) {
    for (const operation of ["kill", "scope release"] as const) {
      it.live(`${operation} surfaces unconfirmed group termination as ${reason}`, () =>
        Effect.gen(function*() {
          const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-leader", {
            forceKillAfter: "200 millis"
          })
          yield* Effect.addFinalizer(() => killDescendant(descendantPid))
          assert.strictEqual(yield* handle.exitCode, 0)
          const probeError = Object.assign(new Error("Probe failed"), { code })
          yield* mockGroupKill(handle.pid, (signal) => {
            if (signal !== 0) return
            if (code === "present") return true
            throw probeError
          })

          const start = Date.now()
          const exit = yield* Effect.exit(
            operation === "kill"
              ? handle.kill({ forceKillAfter: "200 millis" })
              : Scope.close(scope, Exit.void)
          )
          assert.isBelow(Date.now() - start, 3_000)
          if (!Exit.isFailure(exit)) throw new Error("Expected unconfirmed termination to fail")
          assert.strictEqual(Cause.hasDies(exit.cause), operation === "scope release")
          assert.strictEqual(Cause.hasFails(exit.cause), operation === "kill")
          const error = Cause.squash(exit.cause)
          if (!(error instanceof PlatformError.PlatformError)) throw new Error("Expected PlatformError")
          assert.strictEqual(error.reason.module, "ChildProcess")
          assert.strictEqual(error.reason.method, "verifyTermination")
          assert.strictEqual(error.reason._tag, reason)
          if (code !== "present") assert.strictEqual(error.reason.cause, probeError)
          yield* assertHeartbeatStopped(marker)
        }).pipe(Effect.provide(NodeServices)))
    }
  }

  it.live("scope release of an unreferenced process keeps cleanup best-effort", () =>
    Effect.gen(function*() {
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("ignore-signal", {
        stdin: "pipe",
        forceKillAfter: "200 millis"
      })
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))
      // Keep the process unreferenced for the rest of the test.
      yield* Effect.asVoid(handle.unref)
      yield* Stream.run(Stream.make(new TextEncoder().encode("exit 1\n")), handle.stdin)
      assert.strictEqual(yield* handle.exitCode, 1)
      yield* mockGroupKill(handle.pid, (signal) => {
        if (signal === 0) throw Object.assign(new Error("Permission denied"), { code: "EPERM" })
      })

      const exit = yield* Effect.exit(Scope.close(scope, Exit.void))

      assert.isTrue(Exit.isSuccess(exit))
      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.provide(NodeServices)))

  it.live("pipeline kill attempts every group before surfacing verification failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const rootMarker = `${directory}/root`
      const tailMarker = `${directory}/tail`
      const command = (marker: string) =>
        ChildProcess.make(
          process.execPath,
          [processGroupFixture, "leader", "exit-leader", marker],
          { stdin: "ignore", forceKillAfter: "200 millis" }
        )
      const handle = yield* command(rootMarker).pipe(ChildProcess.pipeTo(command(tailMarker)))
      yield* handle.stdout.pipe(Stream.runDrain, liveTimeout(5_000))
      assert.strictEqual(yield* handle.exitCode, 0)
      yield* Effect.gen(function*() {
        while (!(yield* fs.exists(rootMarker))) yield* liveSleep(10)
      }).pipe(liveTimeout(5_000))
      yield* mockGroupKill(handle.pid, (signal) => {
        if (signal === 0) throw Object.assign(new Error("Permission denied"), { code: "EPERM" })
      })

      const exit = yield* Effect.exit(handle.kill({ forceKillAfter: "200 millis" }))

      if (!Exit.isFailure(exit)) throw new Error("Expected pipeline verification failure")
      const error = Cause.squash(exit.cause)
      if (!(error instanceof PlatformError.PlatformError)) throw new Error("Expected PlatformError")
      assert.strictEqual(error.reason.module, "ChildProcess")
      assert.strictEqual(error.reason.method, "verifyTermination")
      yield* assertHeartbeatStopped(rootMarker)
      yield* assertHeartbeatStopped(tailMarker)
    }).pipe(Effect.provide(NodeServices)))

  it.live("interruption force kills a descendant with ignored stdio", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const ready = yield* Deferred.make<string>()
      const fiber = yield* Effect.gen(function*() {
        const { marker } = yield* startProcessGroup(
          "ignore-signal-no-stdio",
          { forceKillAfter: "200 millis" },
          directory
        )
        yield* Deferred.succeed(ready, marker)
        return yield* Effect.never
      }).pipe(Effect.scoped, Effect.forkChild)
      const marker = yield* Deferred.await(ready).pipe(liveTimeout(5_000))
      yield* Fiber.interrupt(fiber)
      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.provide(NodeServices)))

  it.live("scope release does not escalate by default for a descendant with ignored stdio", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { descendantPid, marker, scope } = yield* startProcessGroup("ignore-signal-no-stdio")
      yield* Effect.gen(function*() {
        yield* Scope.close(scope, Exit.void)
        const sizeAfterRelease = (yield* fs.stat(marker)).size
        yield* liveSleep(100)
        assert.isTrue((yield* fs.stat(marker)).size > sizeAfterRelease)
      }).pipe(Effect.ensuring(killDescendant(descendantPid)))
    }).pipe(Effect.provide(NodeServices)))

  it.live("scope release waits for descendants that outlive the leader", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { handle, marker, scope } = yield* startProcessGroup("exit-on-signal")

      yield* Scope.close(scope, Exit.void)

      assert.isFalse(yield* handle.isRunning)
      assert.isTrue(yield* fs.exists(marker))
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release force kills descendants that ignore the kill signal", () =>
    Effect.gen(function*() {
      const { marker, scope } = yield* startProcessGroup("ignore-signal", { forceKillAfter: "200 millis" })

      yield* Scope.close(scope, Exit.void)

      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("kill force kills descendants that ignore the kill signal", () =>
    Effect.gen(function*() {
      const { handle, marker, scope } = yield* startProcessGroup("ignore-signal")

      yield* handle.kill({ forceKillAfter: "200 millis" })

      assert.isFalse(yield* handle.isRunning)
      yield* assertHeartbeatStopped(marker)
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.effect("forceKillAfter escalation does not depend on the Effect clock", () =>
    Effect.gen(function*() {
      const { marker, scope } = yield* startProcessGroup("ignore-signal", { forceKillAfter: "200 millis" })

      const releaseMillis = yield* timed(Scope.close(scope, Exit.void))

      assert.isBelow(releaseMillis, 2_000)
      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release returns when a descendant holds the inherited pipe without forceKillAfter", () =>
    Effect.gen(function*() {
      const { descendantPid, handle, scope } = yield* startProcessGroup("ignore-signal")

      yield* Effect.gen(function*() {
        const releaseMillis = yield* timed(Scope.close(scope, Exit.void))

        assert.isFalse(yield* handle.isRunning)
        assert.isAtLeast(releaseMillis, 1_000)
        assert.isBelow(releaseMillis, 3_000)
      }).pipe(Effect.ensuring(killDescendant(descendantPid)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))
})

it.live("scope release returns when stdout is unread and backpressured", () =>
  Effect.gen(function*() {
    const releaseMillis = yield* timed(Effect.scoped(Effect.gen(function*() {
      yield* ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write(\"x\".repeat(1024 * 1024)); setInterval(() => {}, 1000)"
      ], { stdin: "ignore" })
      yield* Effect.sleep("100 millis")
    })))

    assert.isBelow(releaseMillis, 2_000)
  }).pipe(Effect.provide(NodeServices)))
