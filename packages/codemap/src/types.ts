/** Languages the code map reads (Memory 01-D6: TS/JS and Python first). */
export type CodeLanguage = 'typescript' | 'tsx' | 'javascript' | 'python';

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'module';

export interface CodeSymbol {
  name: string;
  /** Name with its containers, e.g. "Hive.settle" (unique enough to name a caller). */
  qualified: string;
  kind: SymbolKind;
  /** 1-based. */
  line: number;
  endLine: number;
  /** The declaration's first line, trimmed, at most 160 characters. */
  signature: string;
  /** First sentence of the doc comment or docstring (no AI), at most 200 characters. */
  doc: string | null;
  /** Containing class, namespace or function, if any. */
  parent: string | null;
}

/** One call: `from` is the qualified name of the enclosing symbol, or "" at module level. */
export interface CallEdge {
  from: string;
  /** The called name: an identifier, or the last property of `a.b.c()`. */
  callee: string;
  line: number;
  /** When the callee was imported: the module specifier it came from. */
  module: string | null;
}

export interface FileMap {
  language: CodeLanguage;
  symbols: CodeSymbol[];
  /** Module specifiers this file imports or re-exports (in source order, unique). */
  imports: string[];
  calls: CallEdge[];
}
