import type { CallEdge, CodeLanguage, CodeSymbol, FileMap, SymbolKind } from './types';

/** The part of a tree-sitter node the extractor reads (web-tree-sitter's `Node`). */
export interface SyntaxNode {
  /** Unique per node in a tree; wrappers for the same node are different objects, so compare ids. */
  readonly id: number;
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly namedChildren: Array<SyntaxNode | null>;
  readonly previousSibling: SyntaxNode | null;
  readonly parent: SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
}

const SIGNATURE_MAX = 160;
const DOC_MAX = 200;

interface Scope {
  /** Qualified name of the enclosing symbol ("" at module level). */
  qualified: string;
  /** Name of the enclosing class / namespace / function, if any. */
  parent: string | null;
  /** True when the enclosing container is a class body (functions there are methods). */
  inClass: boolean;
  /** True at module (or namespace) level: where const-with-a-function-value counts as a symbol. */
  topLevel: boolean;
}

const MODULE: Scope = { qualified: '', parent: null, inClass: false, topLevel: true };

class Collector {
  readonly symbols: CodeSymbol[] = [];
  readonly calls: CallEdge[] = [];
  readonly imports: string[] = [];
  /** Local name -> module specifier it was imported from. */
  readonly bindings = new Map<string, string>();
  readonly lines: string[];

  constructor(source: string) {
    this.lines = source.split(/\r?\n/);
  }

  addImport(spec: string): void {
    if (spec && !this.imports.includes(spec)) this.imports.push(spec);
  }

  signature(row: number): string {
    const line = (this.lines[row] ?? '').trim();
    return line.length <= SIGNATURE_MAX ? line : `${line.slice(0, SIGNATURE_MAX - 1).trimEnd()}…`;
  }

  symbol(kind: SymbolKind, name: string, node: SyntaxNode, scope: Scope, opts: { doc?: string | null; sigRow?: number } = {}): Scope {
    const qualified = scope.qualified ? `${scope.qualified}.${name}` : name;
    this.symbols.push({
      name,
      qualified,
      kind,
      line: (opts.sigRow ?? node.startPosition.row) + 1,
      endLine: node.endPosition.row + 1,
      signature: this.signature(opts.sigRow ?? node.startPosition.row),
      doc: opts.doc ?? null,
      parent: scope.parent,
    });
    return { qualified, parent: name, inClass: kind === 'class', topLevel: kind === 'module' };
  }

  call(callee: string, node: SyntaxNode, scope: Scope, module: string | null): void {
    if (!callee) return;
    this.calls.push({ from: scope.qualified, callee, line: node.startPosition.row + 1, module });
  }
}

const named = (n: SyntaxNode): SyntaxNode[] => n.namedChildren.filter((c): c is SyntaxNode => c !== null);
const same = (a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean => !!a && !!b && a.id === b.id;
const unquote = (s: string): string => s.replace(/^[`'"]|[`'"]$/g, '');

/** First sentence of a comment or docstring body, whitespace-collapsed and capped. */
export function firstSentence(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const s = (m?.[1] ?? flat).trim();
  return s.length <= DOC_MAX ? s : `${s.slice(0, DOC_MAX - 1).trimEnd()}…`;
}

/** Comment text without its markers: `/** … *\/`, `// …`, `# …`. */
function commentBody(raw: string): string {
  if (raw.startsWith('/*')) {
    return raw
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*\s?/, ''))
      .filter((l) => !/^\s*@/.test(l))
      .join(' ');
  }
  return raw.replace(/^\s*(\/\/+|#+)\s?/, '');
}

/**
 * The comment directly above `node` (touching it, possibly several line comments in a row): the doc of
 * a declaration that has no docstring.
 */
function leadingComment(node: SyntaxNode): string | null {
  const parts: string[] = [];
  let expectRow = node.startPosition.row;
  let prev = node.previousSibling;
  while (prev && prev.type === 'comment' && prev.endPosition.row >= expectRow - 1) {
    parts.unshift(commentBody(prev.text));
    expectRow = prev.startPosition.row;
    if (prev.text.startsWith('/*')) break;
    prev = prev.previousSibling;
  }
  return parts.length ? firstSentence(parts.join(' ')) : null;
}

// ---- TypeScript / TSX / JavaScript -------------------------------------------------------------

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

function walkJs(node: SyntaxNode, scope: Scope, c: Collector, docNode: SyntaxNode | null = null): void {
  const doc = (): string | null => leadingComment(docNode ?? node);
  const sigRow = (docNode ?? node).startPosition.row;
  const body = (): void => {
    for (const child of named(node)) walkJs(child, scope, c);
  };

  switch (node.type) {
    case 'comment':
      return;
    case 'export_statement': {
      const source = node.childForFieldName('source');
      if (source) c.addImport(unquote(source.text));
      const decl = node.childForFieldName('declaration');
      if (decl) return walkJs(decl, scope, c, node);
      return body();
    }
    case 'import_statement': {
      const source = node.childForFieldName('source');
      const spec = source ? unquote(source.text) : '';
      c.addImport(spec);
      bindJsImport(node, spec, c);
      return;
    }
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_signature': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return body();
      const inner = c.symbol(scope.inClass ? 'method' : 'function', name, node, scope, { doc: doc(), sigRow });
      return walkChildren(node, { ...inner, inClass: false, topLevel: false }, c);
    }
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return body();
      const inner = c.symbol('class', name, node, scope, { doc: doc(), sigRow });
      return walkChildren(node, { ...inner, inClass: true, topLevel: false }, c);
    }
    case 'method_definition':
    case 'method_signature':
    case 'abstract_method_signature': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return body();
      const inner = c.symbol('method', name, node, { ...scope, inClass: true }, { doc: doc(), sigRow });
      return walkChildren(node, { ...inner, inClass: false, topLevel: false }, c);
    }
    case 'public_field_definition':
    case 'field_definition': {
      const name = (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text;
      const value = node.childForFieldName('value');
      if (name && value && FUNCTION_VALUES.has(value.type)) {
        const inner = c.symbol('method', name, node, { ...scope, inClass: true }, { doc: doc(), sigRow });
        return walkJs(value, { ...inner, inClass: false, topLevel: false }, c);
      }
      return body();
    }
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return body();
      const kind: SymbolKind = node.type === 'interface_declaration' ? 'interface' : node.type === 'enum_declaration' ? 'enum' : 'type';
      c.symbol(kind, name, node, scope, { doc: doc(), sigRow });
      return;
    }
    case 'internal_module':
    case 'module': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return body();
      const inner = c.symbol('module', unquote(name), node, scope, { doc: doc(), sigRow });
      return walkChildren(node, { ...inner, inClass: false, topLevel: true }, c);
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const decl of named(node)) {
        if (decl.type !== 'variable_declarator') {
          walkJs(decl, scope, c);
          continue;
        }
        const nameNode = decl.childForFieldName('name');
        const value = decl.childForFieldName('value');
        const name = nameNode?.type === 'identifier' ? nameNode.text : null;
        if (name && value && isRequire(value)) {
          const spec = requireSpec(value);
          if (spec) {
            c.addImport(spec);
            c.bindings.set(name, spec);
          }
        }
        if (name && value && FUNCTION_VALUES.has(value.type) && scope.topLevel) {
          const inner = c.symbol('function', name, decl, scope, { doc: doc(), sigRow });
          walkJs(value, { ...inner, inClass: false, topLevel: false }, c);
        } else if (value) {
          walkJs(value, scope, c);
        }
      }
      return;
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier') {
          if (fn.text === 'require') {
            const spec = requireSpec(node);
            if (spec) c.addImport(spec);
          } else {
            c.call(fn.text, node, scope, c.bindings.get(fn.text) ?? null);
          }
        } else if (fn.type === 'import') {
          const spec = requireSpec(node);
          if (spec) c.addImport(spec);
        } else if (fn.type === 'member_expression') {
          const prop = fn.childForFieldName('property')?.text ?? '';
          const obj = fn.childForFieldName('object');
          c.call(prop, node, scope, obj?.type === 'identifier' ? (c.bindings.get(obj.text) ?? null) : null);
        }
      }
      return body();
    }
    case 'new_expression': {
      const ctor = node.childForFieldName('constructor');
      if (ctor?.type === 'identifier') c.call(ctor.text, node, scope, c.bindings.get(ctor.text) ?? null);
      return body();
    }
    default:
      return body();
  }
}

/** Walk a declaration's children (its body) in the declaration's own scope. */
function walkChildren(node: SyntaxNode, scope: Scope, c: Collector): void {
  for (const child of named(node)) {
    // The name itself is not a call or a symbol.
    if (same(child, node.childForFieldName('name'))) continue;
    walkJs(child, scope, c);
  }
}

function isRequire(n: SyntaxNode): boolean {
  return n.type === 'call_expression' && n.childForFieldName('function')?.text === 'require';
}

function requireSpec(call: SyntaxNode): string | null {
  const args = call.childForFieldName('arguments');
  const first = args ? named(args)[0] : undefined;
  return first && (first.type === 'string' || first.type === 'template_string') ? unquote(first.text) : null;
}

function bindJsImport(node: SyntaxNode, spec: string, c: Collector): void {
  for (const clause of named(node)) {
    if (clause.type !== 'import_clause') continue;
    for (const part of named(clause)) {
      if (part.type === 'identifier') c.bindings.set(part.text, spec);
      else if (part.type === 'namespace_import') {
        const id = named(part).find((n) => n.type === 'identifier');
        if (id) c.bindings.set(id.text, spec);
      } else if (part.type === 'named_imports') {
        for (const s of named(part)) {
          if (s.type !== 'import_specifier') continue;
          const local = (s.childForFieldName('alias') ?? s.childForFieldName('name'))?.text;
          if (local) c.bindings.set(local, spec);
        }
      }
    }
  }
}

// ---- Python ----------------------------------------------------------------------------------

function pyDocstring(def: SyntaxNode): string | null {
  const block = def.childForFieldName('body');
  const first = block ? named(block)[0] : undefined;
  if (first?.type !== 'expression_statement') return null;
  const str = named(first)[0];
  if (str?.type !== 'string') return null;
  const raw = str.text.replace(/^[rRuUbBfF]*('''|"""|'|")/, '').replace(/('''|"""|'|")$/, '');
  return firstSentence(raw);
}

function walkPy(node: SyntaxNode, scope: Scope, c: Collector, decorated: SyntaxNode | null = null): void {
  const body = (): void => {
    for (const child of named(node)) walkPy(child, scope, c);
  };
  switch (node.type) {
    case 'comment':
      return;
    case 'decorated_definition': {
      const def = node.childForFieldName('definition');
      for (const child of named(node)) if (!same(child, def)) walkPy(child, scope, c);
      if (def) walkPy(def, scope, c, node);
      return;
    }
    case 'function_definition':
    case 'class_definition': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return body();
      const isClass = node.type === 'class_definition';
      const kind: SymbolKind = isClass ? 'class' : scope.inClass ? 'method' : 'function';
      const doc = pyDocstring(node) ?? leadingComment(decorated ?? node);
      const inner = c.symbol(kind, name, node, scope, { doc });
      const next: Scope = { ...inner, inClass: isClass, topLevel: false };
      for (const child of named(node)) {
        if (same(child, node.childForFieldName('name'))) continue;
        walkPy(child, next, c);
      }
      return;
    }
    case 'import_statement': {
      for (const part of named(node)) {
        if (part.type === 'dotted_name') {
          c.addImport(part.text);
          c.bindings.set(part.text.split('.')[0]!, part.text);
        } else if (part.type === 'aliased_import') {
          const mod = part.childForFieldName('name')?.text ?? '';
          const alias = part.childForFieldName('alias')?.text;
          c.addImport(mod);
          if (alias) c.bindings.set(alias, mod);
        }
      }
      return;
    }
    case 'import_from_statement': {
      const mod = node.childForFieldName('module_name')?.text ?? '';
      c.addImport(mod);
      for (const part of named(node)) {
        if (same(part, node.childForFieldName('module_name'))) continue;
        if (part.type === 'dotted_name') c.bindings.set(part.text, mod);
        else if (part.type === 'aliased_import') {
          const local = (part.childForFieldName('alias') ?? part.childForFieldName('name'))?.text;
          if (local) c.bindings.set(local, mod);
        }
      }
      return;
    }
    case 'call': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') c.call(fn.text, node, scope, c.bindings.get(fn.text) ?? null);
      else if (fn?.type === 'attribute') {
        const attr = fn.childForFieldName('attribute')?.text ?? '';
        const obj = fn.childForFieldName('object');
        c.call(attr, node, scope, obj?.type === 'identifier' ? (c.bindings.get(obj.text) ?? null) : null);
      }
      return body();
    }
    default:
      return body();
  }
}

/** Symbols, imports and calls of one parsed file (pure: no I/O, no AI). */
export function extract(root: SyntaxNode, source: string, language: CodeLanguage): FileMap {
  const c = new Collector(source);
  if (language === 'python') walkPy(root, MODULE, c);
  else walkJs(root, MODULE, c);
  return { language, symbols: c.symbols, imports: c.imports, calls: c.calls };
}
