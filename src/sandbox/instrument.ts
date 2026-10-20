import { parse } from 'acorn';

/**
 * Rewrites strategy source so every loop iteration and every function call charges one op (`__b()`).
 * The op budget makes timeouts deterministic (same code, same inputs → same cutoff on any machine)
 * and stops infinite loops synchronously.
 *
 * Also turns `export default …` into an assignment to `__exports.default`, rewrites `a ** b` to `__pow(a, b)` (the
 * engine-independent pow), and rejects imports.
 */
export interface InstrumentResult {
  ok: true;
  code: string;
}
export interface InstrumentError {
  ok: false;
  error: string;
}

interface Edit {
  pos: number;
  text: string;
  /** Characters to delete starting at `pos`. */
  del?: number;
  /** Tie-break for edits at the same position (higher first when applying back-to-front). */
  order: number;
}

type AnyNode = { type: string; start: number; end: number; [k: string]: any };

const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const FUNCS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

export function instrument(source: string): InstrumentResult | InstrumentError {
  let ast: AnyNode;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) as unknown as AnyNode;
  } catch (e) {
    return { ok: false, error: `SyntaxError: ${(e as Error).message}` };
  }

  const edits: Edit[] = [];
  let seq = 0;
  let hasDefault = false;
  let error: string | null = null;

  const wrapStatement = (body: AnyNode) => {
    if (body.type === 'BlockStatement') {
      edits.push({ pos: body.start + 1, text: '__b();', order: seq++ });
    } else {
      edits.push({ pos: body.start, text: '{__b();', order: seq++ });
      edits.push({ pos: body.end, text: '}', order: -seq++ });
    }
  };

  const visit = (node: AnyNode | null | undefined) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ImportExpression':
        error ??= `imports are not allowed (line ${node.loc?.start?.line ?? '?'})`;
        return;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        error ??= `only "export default" is allowed (line ${node.loc?.start?.line ?? '?'})`;
        return;
      case 'MetaProperty':
        error ??= 'import.meta is not allowed';
        return;
      case 'AssignmentExpression':
        if (node.operator === '**=') {
          error ??= `"**=" is not supported; write x = x ** y (line ${node.loc?.start?.line ?? '?'})`;
          return;
        }
        break;
      case 'BinaryExpression':
        if (node.operator === '**') {
          // Find the operator token between the operands (parentheses and spaces may surround it).
          const between = source.slice(node.left.end, node.right.start);
          const at = node.left.end + between.indexOf('**');
          edits.push({ pos: node.start, text: '__pow(', order: seq++ });
          edits.push({ pos: at, del: 2, text: ',', order: seq++ });
          edits.push({ pos: node.end, text: ')', order: -seq++ });
        }
        break;
      case 'ExportDefaultDeclaration': {
        hasDefault = true;
        const decl = node.declaration as AnyNode;
        if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
          edits.push({ pos: node.start, del: decl.start - node.start, text: '', order: seq++ });
          edits.push({ pos: node.end, text: `\n__exports.default = ${decl.id.name};`, order: -seq++ });
        } else {
          edits.push({ pos: node.start, del: decl.start - node.start, text: '__exports.default = (', order: seq++ });
          edits.push({ pos: decl.end, text: ');', order: -seq++ });
        }
        visit(decl);
        return;
      }
    }
    if (LOOPS.has(node.type)) wrapStatement(node.body);
    if (FUNCS.has(node.type)) {
      const body = node.body as AnyNode;
      if (body.type === 'BlockStatement') {
        edits.push({ pos: body.start + 1, text: '__b();', order: seq++ });
      } else {
        edits.push({ pos: body.start, text: '(__b(), ', order: seq++ });
        edits.push({ pos: body.end, text: ')', order: -seq++ });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => visit(c));
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast);
  if (error) return { ok: false, error };

  // Apply back to front so earlier positions stay valid.
  edits.sort((a, b) => b.pos - a.pos || b.order - a.order);
  let out = source;
  for (const e of edits) out = out.slice(0, e.pos) + e.text + out.slice(e.pos + (e.del ?? 0));
  if (!hasDefault) out += '\nif (typeof control === "function") __exports.default = control;';
  return { ok: true, code: out };
}
