/**
 * Provides the shared registry used by Schema decoder implementations. A
 * decoder installed with {@link set} is consumed transparently by the normal
 * `SchemaParser` APIs, allowing runtime and ahead-of-time compilers to use the
 * same cache without introducing a compiled Schema type or a second parser API.
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
 * It must honor every supported `ParseOptions` value. Return {@link invalid}
 * only for invalid input, never for an unsupported optimization. Do not call
 * the detailed decoder and discard its failure: the caller runs `decode` after
 * `invalid`. User checks may themselves construct issues.
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
 * @category models
 * @since 4.0.0
 */
export interface Decode {
  (
    input: unknown,
    options: SchemaAST.ParseOptions
  ): Effect.Effect<unknown, SchemaIssue.Issue, any>
}

/**
 * The operations installed for an AST in the shared Schema parser registry.
 *
 * **Details**
 *
 * `decode` is required because it preserves detailed failures. `validate` and
 * `is` are optional fast paths used by decoding and type guards respectively.
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
