/**
 * Provides the shared registry used by Schema decoder implementations. A
 * decoder installed with {@link set} is consumed transparently by the normal
 * `SchemaParser` APIs, allowing runtime and ahead-of-time compilers to use the
 * same cache without introducing a compiled Schema type or a second parser API.
 *
 * The cache associates each exact AST with an entry containing decoder
 * operations, never parsing results. The interpreter uses the same registry
 * with only `decode`; JIT, AOT, and manual installations may add the optional
 * fast paths in {@link CompiledDecoder}.
 *
 * @since 4.0.0
 */
import type * as Effect from "../../Effect.ts"
import * as CompilerRegistry from "../../internal/schema/compilerRegistry.ts"
import * as InternalParser from "../../internal/schema/parser.ts"
import type * as SchemaAST from "../../SchemaAST.ts"
import type * as SchemaIssue from "../../SchemaIssue.ts"

/**
 * The result returned by {@link Validate} when validation fails.
 *
 * @category symbols
 * @since 4.0.0
 */
export const invalid = CompilerRegistry.invalid

/**
 * The input passed to a decoder when an optional value is absent.
 *
 * @category symbols
 * @since 4.0.0
 */
export const missing = InternalParser.missing

/**
 * A compiled boolean validator.
 *
 * **Details**
 *
 * This optional fast path avoids constructing output. Omit it when validation
 * requires reconstructed values, such as a Struct check that must see the
 * object after excess properties are removed. Type guards then use `validate`,
 * or `decode` if neither fast path is available.
 * It must honor the supplied parse options; public `Schema.is` and
 * `SchemaParser.is` use the defaults.
 *
 * @category models
 * @since 4.0.0
 */
export interface Is {
  (input: unknown, options: SchemaAST.ParseOptions): boolean
}

/**
 * A compiled validator that returns the decoded value without constructing
 * diagnostic issues.
 *
 * **Details**
 *
 * This optional synchronous fast path lets valid inputs return their output
 * without the detailed decoding pass. For decoding, the registry follows
 * {@link invalid} with `decode` because the sentinel provides no error details.
 * Type guards instead convert it to `false`. Omit this operation
 * when the fast path is unsupported or replay would be unsafe, including ASTs
 * containing transformations or middleware.
 *
 * It must honor every supported `ParseOptions` value. Return {@link invalid}
 * only for invalid input, never for an unsupported optimization. Do not call
 * the detailed decoder and discard its failure: decoding would run `decode`
 * again after `invalid`. User checks may themselves construct issues.
 *
 * @category models
 * @since 4.0.0
 */
export interface Validate {
  (input: unknown, options: SchemaAST.ParseOptions): unknown | typeof invalid
}

/**
 * A compiled decoder that returns detailed Schema issues on failure.
 *
 * **Details**
 *
 * This required operation implements complete decoding for its AST, including
 * transformations, middleware, and asynchronous work when present. It makes
 * every parser API usable without optional fast paths and provides diagnostics
 * after `validate` returns `invalid`. The implementation can also be interpreted;
 * invoking `decode` does not imply a switch from compiled to interpreted parsing.
 *
 * @category models
 * @since 4.0.0
 */
export interface Decode {
  (input: unknown, options: SchemaAST.ParseOptions): Effect.Effect<unknown, SchemaIssue.Issue, any>
}

/**
 * The operations installed for an AST in the shared Schema parser registry.
 *
 * **Details**
 *
 * `decode` is required for complete decoding and detailed failures. `validate`
 * and `is` are optional optimizations, not requirements for an AST to be usable.
 * The interpreter supplies only `decode` in this same format.
 *
 * The registry wraps these operations in an internal entry.
 * Decoding tries `validate` when present, returning its output on success or
 * calling `decode` after `invalid`. Without `validate`, or for the {@link missing}
 * sentinel, it calls `decode` directly. Type guards prefer `is`, then `validate`,
 * then ordinary decoding.
 * They need no diagnostic replay when a fast path returns `false` or `invalid`.
 * Synchronous decoding and encoding share an adapter that returns successful
 * `validate` output directly, without wrapping it in an intermediate Effect.
 * Each operation is resolved lazily on first use, so unused fast paths need
 * not be compiled.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledDecoder {
  readonly is?: Is | undefined
  readonly validate?: Validate | undefined
  readonly decode: Decode
}

/**
 * Installs a compiled decoder for an exact AST in the shared Schema parser
 * registry.
 *
 * **Details**
 *
 * A later call for the same AST replaces the previous entry. Parser functions
 * that have already resolved and retained an earlier entry are not updated.
 * This also applies when subsequent calls use different parse options.
 * The decoder is trusted to implement the semantics of the supplied AST.
 * Installation does not evaluate operation getters. Each operation, including
 * an absent optional operation, is resolved once when first needed. Accessors
 * retain the supplied decoder as their receiver. The supplied object is not
 * mutated. JIT installation uses these same rules.
 *
 * @category registry
 * @since 4.0.0
 */
export const set = (ast: SchemaAST.AST, decoder: CompiledDecoder): void => {
  CompilerRegistry.set(ast, decoder)
}
