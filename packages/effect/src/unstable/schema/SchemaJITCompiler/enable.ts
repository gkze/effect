/**
 * Enables lazy JIT compilation for every Schema AST resolved after this module
 * is imported. ASTs already present in the shared registry are left unchanged.
 * If dynamic function generation is unavailable or compilation fails, the
 * affected decoder uses the interpreter without retrying compilation. This
 * fallback does not catch exceptions from executing the parser.
 *
 * @since 4.0.0
 */
import * as CompilerRegistry from "../../../internal/schema/compilerRegistry.ts"
import { compile } from "../../../internal/schema/jitCompiler.ts"

CompilerRegistry.install(compile)
