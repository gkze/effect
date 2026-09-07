import * as Effect from "../../Effect.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import type * as SchemaIssue from "../../SchemaIssue.ts"
import { effectIsExit } from "../effect.ts"
import { checkOutput, getEncodingChecks } from "./checks.ts"
import type { Parser, ResolveParser } from "./compilerRegistry.ts"
import * as InternalParser from "./parser.ts"
import { applyTransformation, makeEncoding } from "./transformation.ts"

/** @internal */
export function makeConstructorParser(descriptor: SchemaAST.ConstructorDescriptor, resolve: ResolveParser): Parser {
  let sourceParser: Parser
  return (input, options) => {
    if (input === InternalParser.missing) return InternalParser.missingExit
    if (descriptor.isConstructed(input)) return InternalParser.succeed(input)
    const result = (sourceParser ??= resolve(descriptor.link.to))(input, options)
    return Effect.flatMapEager(
      applyTransformation(result, descriptor.link.transformation, options),
      InternalParser.fromOptionExit
    )
  }
}

/** @internal */
export function withConstructorDefault(ast: SchemaAST.AST, parser: Parser, resolve: ResolveParser): Parser {
  const link = ast.context?.constructorDefault
  if (link === undefined) return parser
  let source: Parser | undefined
  return makeEncoding(ast, [link], [(input, options) => (source ??= resolve(link.to))(input, options)], parser)
}

/** @internal */
export function compileConstructor(ast: SchemaAST.AST, resolve: ResolveParser): Parser {
  return compile(ast, resolve, (ast) => withConstructorDefault(ast, resolve(ast), resolve))
}

/** @internal */
export function compile(
  ast: SchemaAST.AST,
  resolve: ResolveParser,
  resolveConstructorDefault?: ResolveParser
): Parser {
  const descriptor = resolveConstructorDefault ? SchemaAST.getConstructorDescriptor(ast) : undefined
  const parser = descriptor
    ? makeConstructorParser(descriptor, resolve)
    : ast.getParser(resolve, resolveConstructorDefault)
  const links = ast.encoding
  const parseLocal = applyChecks(ast, parser)
  if (!links) return parseLocal
  let encodingParser: Parser | undefined
  return (input, options) =>
    (encodingParser ??= makeEncoding(ast, links, links.map((link) => resolve(link.to)), parseLocal))(input, options)
}

/** @internal */
export function applyChecks(ast: SchemaAST.AST, parser: Parser): Parser {
  const checks = ast.checks
  const encodingChecks = getEncodingChecks(ast)
  if (!checks && !encodingChecks) return parser
  return (input, options) => {
    const result = parser(input, options)
    if (effectIsExit(result)) {
      if (result._tag === "Failure") return result
      const output = (result as InternalParser.Success<unknown, SchemaIssue.Issue>)[InternalParser.args]
      const issue = checkOutput(ast, input, output, options)
      return issue === undefined ? result : Effect.fail(issue)
    }
    return Effect.flatMap(result, (output) => {
      const issue = checkOutput(ast, input, output, options)
      return issue === undefined ? Effect.succeed(output) : Effect.fail(issue)
    })
  }
}
