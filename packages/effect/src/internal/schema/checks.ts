import * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"
import { missing } from "./parser.ts"

/** @internal */
export const getEncodingChecks = (ast: SchemaAST.AST): SchemaAST.Checks | undefined =>
  "encodingChecks" in ast ? ast.encodingChecks : undefined

/** @internal */
export const checkOutput = (
  ast: SchemaAST.AST,
  input: unknown,
  output: unknown,
  options: SchemaAST.ParseOptions
): SchemaIssue.Composite | undefined => {
  if (output === missing || options.disableChecks) return
  const encodingChecks = getEncodingChecks(ast)
  if (encodingChecks !== undefined && input !== missing) {
    const issues = SchemaAST.collectIssues(encodingChecks, input, undefined, ast, options)
    if (issues !== undefined) return new SchemaIssue.Composite(ast, issues, input, options)
  }
  if (ast.checks !== undefined) {
    const issues = SchemaAST.collectIssues(ast.checks, output, undefined, ast, options)
    if (issues !== undefined) return new SchemaIssue.Composite(ast, issues, output, options)
  }
}
