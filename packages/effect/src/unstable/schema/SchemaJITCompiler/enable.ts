/**
 * Enables lazy JIT compilation for every Schema AST resolved after this module
 * is imported. ASTs already present in the shared registry are left unchanged.
 * Import before the first schema use, including construction. Late activation is
 * allowed but does not upgrade entries created by an earlier maker or decoder.
 * If dynamic function generation is unavailable or compilation fails, the
 * affected operation uses the interpreter without retrying compilation. Decoding
 * and construction initialize independently. This
 * fallback does not catch exceptions from executing the parser.
 *
 * @since 4.0.0
 */
import * as CompilerRegistry from "../../../internal/schema/compilerRegistry.ts"
import { compile } from "../../../internal/schema/jitCompiler.ts"

CompilerRegistry.install(compile)
