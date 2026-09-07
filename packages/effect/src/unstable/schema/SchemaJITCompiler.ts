/**
 * Provides selective just-in-time compilation for Schema parsing and construction. Use
 * {@link enable} to enable JIT compilation for one exact AST, or import
 * `effect/unstable/schema/SchemaJITCompiler/enable` for its side effect to
 * enable compilation globally.
 *
 * @since 4.0.0
 */
import * as CompilerRegistry from "../../internal/schema/compilerRegistry.ts"
import { compile } from "../../internal/schema/jitCompiler.ts"
import type * as SchemaAST from "../../SchemaAST.ts"

const compileScoped = CompilerRegistry.makeScopedCompiler(compile)

/**
 * Enables JIT compilation for an exact AST and its parsing and construction dependencies.
 *
 * **Details**
 *
 * The AST is installed immediately, while its `is`, `validate`, `decodeEffect`, and `makeEffect`
 * operations remain lazy. Existing compiled descendants are preserved and
 * lazy boundaries are compiled when first reached. If dynamic function
 * generation is unavailable or compilation fails, decoding continues through
 * the interpreter. Failed compilation is not retried for that entry.
 * Exceptions from executing a parser keep their normal behavior and do not
 * trigger fallback.
 * Declaration type parameters are prepared on the declaration's first use,
 * with their operations still lazy. New ASTs created inside its callback
 * follow the normal registry policy.
 * Use `SchemaAST.toType(schema.ast)` for construction, and install a distinct
 * type-side AST separately from an encoded root. Decoding and construction
 * initialize and recover from compilation failures independently. An interpreted
 * constructor can still resolve selectively compiled children, including lazy ones.
 *
 * @category compilation
 * @since 4.0.0
 */
export const enable = (ast: SchemaAST.AST): void => {
  compileScoped(ast)
}
