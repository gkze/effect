import type * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Option from "../../Option.ts"
import { args } from "../core.ts"

/** @internal */
export const missing = Symbol()

/** @internal */
export { args }

/** @internal */
export type Success<A, E = never> = Exit.Success<A, E> & { readonly [args]: A }

/** @internal */
export const succeed = Exit.succeed as <A>(value: A) => Success<A>

/** The input/output is absent. This is distinct from a present `undefined`. @internal */
export const missingExit = succeed(missing)

/**
 * Identity-based success for the unchanged, present input of the current parser.
 * Its stored payload is deliberately unused, even though it equals `missing`.
 * Never inspect that payload or yield this Exit to the generic Effect runtime.
 *
 * Synchronous collection/check code consumes it with the corresponding input.
 * Before returning it from an Effect continuation, handing it to a transformation
 * or middleware, or exposing it through a public adapter, materialize that input.
 * Deferred parser Effects must already yield ordinary successes, never sameExit.
 * Ordinary successes, including `missingExit`, retain their actual payload.
 * @internal
 */
export const sameExit: Success<unknown> = succeed(missing)

/** Resolves the private unchanged-input protocol at an Effect boundary. @internal */
export const materialize = <E, R>(
  result: Effect.Effect<unknown, E, R>,
  input: unknown
): Effect.Effect<unknown, E, R> => result === sameExit ? succeed(input) : result

/** @internal */
export const toOption = <A>(value: A): Option.Option<A> => value === missing ? Option.none() : Option.some(value as A)

/** @internal */
export const fromOptionExit = <A>(option: Option.Option<A>): Success<A | typeof missing> =>
  option._tag === "None" ? missingExit : succeed(option.value)
