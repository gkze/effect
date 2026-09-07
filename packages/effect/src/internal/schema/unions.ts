import type * as Arr from "../../Array.ts"
import type * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import { type AST, getCandidates, type ParseOptions, type Union } from "../../SchemaAST.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"
import type * as SchemaParser from "../../SchemaParser.ts"
import { effectIsExit, iterateEager } from "../effect.ts"
import * as InternalSchemaCause from "./cause.ts"
import * as InternalParser from "./parser.ts"

/** @internal */
export function makeUnionParser(
  ast: Union,
  compile: SchemaParser.Compiler,
  isConstructor: boolean
): SchemaParser.Parser {
  const parse: SchemaParser.Parser = (input, options) => {
    if (input === InternalParser.missing) {
      return InternalParser.missingExit
    }
    const candidates = getCandidates(input, ast.types, isConstructor)

    if (candidates.length === 0) {
      return Effect.fail(new SchemaIssue.AnyOf(ast, [], input, options))
    }
    if (candidates.length === 1) {
      const result = compile(candidates[0])(input, options)
      if ((result as Exit.Exit<unknown, SchemaIssue.Issue>)._tag === "Success") return result
      return effectIsExit(result)
        ? failSingleUnionCandidate(ast, (result as Exit.Failure<unknown, SchemaIssue.Issue>).cause, input, options)
        : Effect.catchCause(result, (cause) => failSingleUnionCandidate(ast, cause, input, options))
    }

    const state = {
      ast,
      compile,
      input,
      out: undefined,
      successes: ast.options?.mode === "oneOf" ? [] : undefined,
      issues: undefined as Arr.NonEmptyArray<SchemaIssue.Issue> | undefined,
      options
    }
    const eff = parseUnion(state, candidates)
    if (!eff) {
      if (state.out) return state.out
      return Effect.fail(new SchemaIssue.AnyOf(ast, state.issues ?? [], input, options))
    }
    return Effect.flatMapEager(eff, (_) => {
      if (state.out) return state.out
      return Effect.fail(new SchemaIssue.AnyOf(ast, state.issues ?? [], input, options))
    })
  }
  return (input, options) => {
    try {
      return parse(input, options)
    } catch (error) {
      return Effect.die(error)
    }
  }
}
function failSingleUnionCandidate(
  ast: Union,
  cause: Cause.Cause<SchemaIssue.Issue>,
  input: unknown,
  options: ParseOptions
) {
  const issue = InternalSchemaCause.getSchemaIssue(cause)
  if (!issue) return Exit.failCause(cause)
  return Exit.fail(new SchemaIssue.AnyOf(ast, [issue], input, options))
}

const parseUnion = iterateEager<{
  readonly compile: (ast: AST) => SchemaParser.Parser
  readonly ast: Union
  readonly input: unknown
  readonly options: ParseOptions
  out: Exit.Success<unknown, SchemaIssue.Issue> | undefined
  readonly successes: Array<AST> | undefined
  issues: Array<SchemaIssue.Issue> | undefined
}, AST>()({
  onItem(s, ast) {
    const parser = s.compile(ast)
    return parser(s.input, s.options)
  },
  step(s, candidate, exit) {
    if (exit._tag === "Failure") {
      const issue = InternalSchemaCause.getSchemaIssue(exit.cause)
      if (issue === undefined) {
        return exit
      }
      if (s.issues) s.issues.push(issue)
      else s.issues = [issue]
    } else {
      if (s.out && s.successes) {
        s.successes.push(candidate)
        return Exit.fail(new SchemaIssue.OneOf(s.ast, s.successes, s.input, s.options))
      }
      s.out = exit
      if (s.successes) {
        s.successes.push(candidate)
      } else {
        return Exit.void
      }
    }
  }
})
