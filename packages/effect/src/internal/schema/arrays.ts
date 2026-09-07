import type * as Arr from "../../Array.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import type { Arrays, AST, ParseOptions } from "../../SchemaAST.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"
import type * as SchemaParser from "../../SchemaParser.ts"
import { iterateEager } from "../effect.ts"
import { wrapPropertyKeyIssue } from "./cause.ts"
import * as Diagnostics from "./diagnostics.ts"
import * as InternalParser from "./parser.ts"

/** @internal */
export function makeArrayParser(ast: Arrays, compile: SchemaParser.Compiler): SchemaParser.Parser {
  type ElementParser = { readonly ast: AST; readonly parser: SchemaParser.Parser }
  let elements: Array<ElementParser> | undefined
  let rest: Array<ElementParser> | undefined
  const elementLen = ast.elements.length
  const tailLen = Math.max(0, ast.rest.length - 1)

  function getParser(
    tailThreshold: number,
    index: number
  ): { readonly ast: AST; readonly parser: SchemaParser.Parser } {
    return Diagnostics.getTupleElement(elements!, rest!, tailThreshold, index)
  }

  return Effect.fnUntracedEager(function*(input, options) {
    if (input === InternalParser.missing) {
      return InternalParser.missing
    }

    // If the input is not an array, return early with an error
    if (!Array.isArray(input)) {
      return yield* Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
    }
    if (!elements) {
      elements = ast.elements.map((ast) => ({ ast, parser: compile(ast) }))
      rest = ast.rest.map((ast) => ({ ast, parser: compile(ast) }))
    }

    const len = input.length
    const state = {
      ast,
      getParser,
      input,
      len,
      tailThreshold: Math.max(elementLen, len - tailLen),
      output: new globalThis.Array(len),
      issues: undefined as Arr.NonEmptyArray<SchemaIssue.Issue> | undefined,
      options
    }
    const eff = parseArray(state, input, 0, ast.rest.length === 0 ? elementLen : Math.max(len, elementLen + tailLen))
    if (eff) yield* eff

    // ---------------------------------------------
    // handle excess indexes
    // ---------------------------------------------
    if (ast.rest.length === 0 && len > elementLen) {
      for (let i = elementLen; i <= len - 1; i++) {
        const issue = Diagnostics.unexpectedKey(ast, i, input[i], options)
        if (options.errors === "all") {
          if (state.issues) state.issues.push(issue)
          else state.issues = [issue]
        } else {
          return yield* Effect.fail(
            new SchemaIssue.Composite(ast, [issue], input, options)
          )
        }
      }
    }
    if (state.issues) {
      return yield* Effect.fail(
        new SchemaIssue.Composite(ast, state.issues, input, options)
      )
    }
    return state.output
  })
}
const parseArray = iterateEager<{
  readonly ast: AST
  readonly input: unknown
  readonly len: number
  readonly getParser: (
    tailThreshold: number,
    index: number
  ) => { readonly ast: AST; readonly parser: SchemaParser.Parser }
  readonly tailThreshold: number
  readonly options: ParseOptions
  readonly output: Array<unknown>
  issues: Array<SchemaIssue.Issue> | undefined
}, unknown>()({
  onItem(s, item, i) {
    const value = i < s.len ? item : InternalParser.missing
    return s.getParser(s.tailThreshold, i).parser(value, s.options)
  },
  step(s, _item, exit, i) {
    if (exit._tag === "Failure") {
      return wrapPropertyKeyIssue(s, s.ast, i, exit)
    }
    const value = (exit as InternalParser.Success<unknown, SchemaIssue.Issue>)[InternalParser.args]
    if (value !== InternalParser.missing) {
      s.output[i] = value
    } else {
      const p = s.getParser(s.tailThreshold, i)
      if (p.ast.context?.isOptional) return
      const issue = Diagnostics.missingKey(i, p.ast)
      if (s.options.errors === "all") {
        if (s.issues) s.issues.push(issue)
        else s.issues = [issue]
      } else {
        return Exit.fail(
          new SchemaIssue.Composite(s.ast, [issue], s.input, s.options)
        )
      }
    }
  }
})
