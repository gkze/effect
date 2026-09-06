import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import type * as Option from "../../Option.ts"
import type * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"
import { effectIsExit } from "../effect.ts"
import type { Parser } from "./compilerRegistry.ts"
import * as InternalParser from "./parser.ts"

/** @internal */
export function applyTransformation(
  result: Effect.Effect<unknown, SchemaIssue.Issue, unknown>,
  transformation: SchemaAST.Link["transformation"],
  options: SchemaAST.ParseOptions
): Effect.Effect<Option.Option<unknown>, SchemaIssue.Issue, unknown> {
  if (effectIsExit(result) && result._tag === "Success") {
    const optional = InternalParser.toOption(
      (result as InternalParser.Success<unknown, SchemaIssue.Issue>)[InternalParser.args]
    )
    return transformation._tag === "Transformation"
      ? transformation.decode.run(optional, options)
      : transformation.decode(InternalParser.succeed(optional), options)
  } else if (transformation._tag === "Transformation") {
    return Effect.flatMapEager(
      result,
      (value) => transformation.decode.run(InternalParser.toOption(value), options)
    )
  } else {
    return transformation.decode(
      Effect.mapEager(result, InternalParser.toOption),
      options
    )
  }
}

const fromOption = (option: Option.Option<unknown>): unknown =>
  option._tag === "None" ? InternalParser.missing : option.value

/** @internal */
export const makeEncoding = (
  ast: SchemaAST.AST,
  links: SchemaAST.Encoding,
  parsers: ReadonlyArray<Parser>,
  local: Parser
): Parser =>
(input, options) => {
  let result = parsers[parsers.length - 1](input, options)
  for (let index = links.length - 1; index >= 0; index--) {
    let transformed = applyTransformation(result, links[index].transformation, options)
    const next = index === 0 ? local : parsers[index - 1]
    if (effectIsExit(transformed) && transformed._tag === "Success") {
      const optional = (transformed as InternalParser.Success<Option.Option<unknown>, SchemaIssue.Issue>)[
        InternalParser.args
      ]
      result = next(fromOption(optional), options)
    } else {
      if (index === 0) {
        transformed = Effect.catchCause(
          transformed,
          (cause) =>
            Effect.failCauseSync(() =>
              Cause.map(cause, (issue) => new SchemaIssue.Encoding(ast, issue, input, options))
            )
        )
      }
      result = Effect.flatMapEager(transformed, (optional) => next(fromOption(optional), options))
    }
  }
  return result
}
