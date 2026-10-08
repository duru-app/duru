import _traverse from '@babel/traverse';
import type { Binding, Node, NodePath, Scope } from '@babel/traverse';
import type { ParseResult } from '@babel/parser';

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

type ExpressionStatement = Extract<Node, { type: 'ExpressionStatement' }>;
type ImportDeclaration = Extract<Node, { type: 'ImportDeclaration' }>;
type ImportSpecifierNode = Extract<Node, { type: 'ImportSpecifier' | 'ImportNamespaceSpecifier' | 'ImportDefaultSpecifier' }>;
type Named = { name?: string; value?: string };

interface ExportSpecifierLike {
  type: string;
  exportKind?: string;
  exported: { name?: string; value?: string };
  local: { name?: string; value?: string };
}

type Span = [number, number];
type Range = [number, number, number];

interface Edge {
  file?: string | null;
  name?: string;
  region?: number | null;
  whole?: string | null;
}

interface Region {
  edges: Edge[];
}

interface ExportEntry {
  local?: string;
  from?: string | null;
  name?: string;
  region?: number;
}

interface Analysis {
  regions: Region[];
  regionAt: (pos: number) => number | null;
  exports: Map<string, ExportEntry>;
  stars: (string | null)[];
  sideEffects: (string | null)[];
  loads: (string | null)[];
  moduleLevel: number[];
  localEdge: (name: string) => Edge | null;
  aliased: (name: string) => string;
}

interface AstNode {
  type: string;
  start: number;
  end: number;
  computed?: boolean;
  static?: boolean;
  key: AstNode;
  value?: AstNode | null;
  superClass?: AstNode | null;
  body: { body: AstNode[] };
}

interface Walk {
  file?: string | null;
  name?: string | null;
  region?: number;
  whole?: string | null;
  load?: string | null;
}

export interface NameFollowerOptions<Site> {
  parse: (file: string) => { ast: ParseResult };
  resolve: (from: string, spec: string) => string | null;
  sitesOf: (file: string) => { start: number; site: Site }[];
}

type CanEnter = (file: string | null) => boolean;

export interface Origin {
  file: string;
  name: string;
}

// 이름이 TS 로 시작해도 실행되는 값을 담는 노드. 나머지 TS 노드 안의 이름은 타입이라 실행되지 않는다.
const RUNTIME_TS = new Set([
  'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression',
  'TSParameterProperty', 'TSEnumDeclaration', 'TSEnumBody', 'TSEnumMember', 'TSModuleDeclaration', 'TSModuleBlock',
  'TSExportAssignment', 'TSImportEqualsDeclaration', 'TSExternalModuleReference',
]);

const isType = (node: { type: string }) => node.type.startsWith('TS') && !RUNTIME_TS.has(node.type);
export const inTypePosition = (p: NodePath) => Boolean(p.findParent((a) => isType(a.node)));

const exportedName = (node: Named): string => node.name ?? node.value!;
const isScript = (file: string) => /\.(jsx?|tsx?)$/.test(file);

const CALLS = new Set<string | undefined>(['CallExpression', 'OptionalCallExpression', 'NewExpression', 'TaggedTemplateExpression']);
const isFunction = (node: { type: string }) => /Function(Expression|Declaration)?$|Method$/.test(node.type);
const isClass = (node: { type: string }) => node.type === 'ClassDeclaration' || node.type === 'ClassExpression';
const eachChild = (node: AstNode, visit: (child: AstNode, parent: AstNode, key: string) => void) => {
  for (const [key, value] of Object.entries(node)) {
    for (const child of Array.isArray(value) ? value : [value]) if (typeof child?.type === 'string') visit(child, node, key);
  }
};

// node 안에서 파일을 불러올 때 실행되는 호출의 [start, end] 들. 함수 본문과 클래스의 메서드 · 인스턴스 필드 값은 나중에 실행되므로 뺀다.
function loadTimeSpans(node: Node | null): Span[] {
  const calls: Span[] = [];
  const holes: Span[] = [];
  const later = (n: { start: number; end: number }, inCall: boolean) => {
    if (inCall) holes.push([n.start, n.end]);
  };
  const visit = (n: AstNode, inCall: boolean, parent: AstNode | null = null, key: string | null = null): void => {
    if (isType(n)) return;
    const next = (c: AstNode, p: AstNode, k: string) => visit(c, inCall, p, k);
    if (isFunction(n)) {
      if (n.computed) visit(n.key, inCall);
      if (inCall && CALLS.has(parent?.type) && (key === 'callee' || key === 'tag')) eachChild(n, next);
      else later(n.computed ? { start: n.key.end, end: n.end } : n, inCall);
    } else if (isClass(n)) {
      if (n.superClass) visit(n.superClass, inCall);
      for (const member of n.body.body) {
        if (isFunction(member)) visit(member, inCall);
        else if (member.type === 'StaticBlock') eachChild(member, next);
        else {
          if (member.computed) visit(member.key, inCall);
          if (member.value && member.static) visit(member.value, inCall);
          else if (member.value) later(member.value, inCall);
        }
      }
    } else if (!inCall && CALLS.has(n.type)) {
      calls.push([n.start, n.end]);
      eachChild(n, (c, p, k) => visit(c, true, p, k));
    } else eachChild(n, next);
  };
  if (node) visit(node as unknown as AstNode, false);
  calls.sort((a, b) => a[0] - b[0]);
  holes.sort((a, b) => a[0] - b[0]);
  const spans: Span[] = [];
  for (const [start, end] of calls) {
    let at = start;
    for (const [hs, he] of holes) {
      if (hs < start || he > end) continue;
      if (hs > at) spans.push([at, hs]);
      at = Math.max(at, he);
    }
    if (at < end) spans.push([at, end]);
  }
  return spans;
}

// 파일 맨 위의 선언마다 「구역」을 하나 두고, 구역 안에서 쓰는 이름이 가리키는 구역이나 다른 파일의 이름을 모은다.
// 선언이 아닌 맨 위 문장과, 선언이나 `X.y = …` 안에서 파일을 불러올 때 실행되는 호출은 늘 닿는 구역이 된다. `X.y = …` 의 나머지는 X 의 구역에 붙인다.
function analyze(file: string, parse: NameFollowerOptions<unknown>['parse'], resolve: NameFollowerOptions<unknown>['resolve']): Analysis {
  const { ast } = parse(file);
  const program = ast.program;
  const regions: Region[] = [];
  const ranges: Range[] = [];
  const exports = new Map<string, ExportEntry>();
  const stars: (string | null)[] = [];
  const sideEffects: (string | null)[] = [];
  const loads: (string | null)[] = [];
  const aliases = new Map<string, string>();
  const moduleLevel: number[] = [];
  const from = (node: { source?: { value: string } | null }) => resolve(file, node.source!.value);
  let loadRegion: number | null = null;
  const place = (start: number, end: number, idx: number, runs: Node | null) => {
    let at = start;
    for (const [s, e] of loadTimeSpans(runs)) {
      if (loadRegion === null) {
        regions.push({ edges: [] });
        loadRegion = regions.length - 1;
        moduleLevel.push(loadRegion);
      }
      if (s > at) ranges.push([at, s, idx]);
      ranges.push([s, e, loadRegion]);
      at = e;
    }
    if (at < end) ranges.push([at, end, idx]);
  };
  const newRegion = (node: Node, runs: Node | null = null) => {
    regions.push({ edges: [] });
    place(node.start!, node.end!, regions.length - 1, runs);
    return regions.length - 1;
  };
  const declare = (decl: Node & { id?: Node | null }, exported: boolean) => {
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        newRegion(d, d);
        if (decl.kind === 'const' && d.id.type === 'Identifier' && d.init?.type === 'Identifier') aliases.set(d.id.name, d.init.name);
        if (exported) for (const name of declaredNames(d.id)) exports.set(name, { local: name });
      }
      return;
    }
    newRegion(decl, decl);
    if (exported && decl.id?.type === 'Identifier') exports.set(decl.id.name, { local: decl.id.name });
  };
  const attachments: ExpressionStatement[] = [];
  for (const stmt of program.body) {
    switch (stmt.type) {
      case 'ImportDeclaration':
        if (stmt.importKind === 'type') break;
        if (stmt.specifiers.length) loads.push(from(stmt));
        else sideEffects.push(from(stmt));
        break;
      case 'ExportNamedDeclaration':
        if (stmt.exportKind === 'type') break;
        if (stmt.source) loads.push(from(stmt));
        if (stmt.declaration) declare(stmt.declaration, true);
        for (const s of stmt.specifiers as unknown as ExportSpecifierLike[]) {
          if (s.exportKind === 'type') continue;
          const name = exportedName(s.exported);
          if (stmt.source) exports.set(name, { from: from(stmt), name: s.type === 'ExportNamespaceSpecifier' ? '*' : exportedName(s.local) });
          else exports.set(name, { local: exportedName(s.local) });
        }
        break;
      case 'ExportAllDeclaration':
        if (stmt.exportKind !== 'type') {
          const target = from(stmt);
          stars.push(target);
          loads.push(target);
        }
        break;
      case 'ExportDefaultDeclaration':
        exports.set('default', { region: newRegion(stmt, stmt.declaration), ...(stmt.declaration.type === 'Identifier' && { local: stmt.declaration.name }) });
        break;
      case 'VariableDeclaration':
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
      case 'TSEnumDeclaration':
      case 'TSModuleDeclaration':
        declare(stmt, false);
        break;
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSDeclareFunction':
        break;
      case 'ExpressionStatement':
        attachments.push(stmt);
        break;
      default:
        moduleLevel.push(newRegion(stmt));
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const regionAt = (pos: number): number | null => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [start, end, idx] = ranges[mid];
      if (pos < start) hi = mid - 1;
      else if (pos >= end) lo = mid + 1;
      else return idx;
    }
    return null;
  };

  let programScope = null as unknown as Scope;
  traverse(ast, {
    Program(p) {
      programScope = p.scope;
      p.stop();
    },
  });
  const ownerOf = (stmt: ExpressionStatement) => {
    const { expression } = stmt;
    if (expression.type !== 'AssignmentExpression') return null;
    let target: Node = expression.left;
    while (target.type === 'MemberExpression') target = target.object;
    if (target === expression.left || target.type !== 'Identifier') return null;
    const binding = programScope.getBinding(target.name);
    return binding && binding.kind !== 'module' ? regionAt(binding.identifier.start!) : null;
  };
  const attached = attachments.map((stmt) => [stmt, ownerOf(stmt)] as const);
  for (const [stmt, owner] of attached) {
    if (owner === null) moduleLevel.push(newRegion(stmt));
    else place(stmt.start!, stmt.end!, owner, stmt.expression);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const importOf = (binding: Binding): Edge => {
    const spec = binding.path.node as ImportSpecifierNode;
    const target = resolve(file, (binding.path.parent as ImportDeclaration).source.value);
    if (spec.type === 'ImportNamespaceSpecifier') return { file: target, name: '*' };
    return { file: target, name: spec.type === 'ImportDefaultSpecifier' ? 'default' : exportedName(spec.imported) };
  };
  const edgeOf = (binding: Binding): Edge => (binding.kind === 'module' ? importOf(binding) : { region: regionAt(binding.identifier.start!) });

  traverse(ast, {
    'Identifier|JSXIdentifier'(p) {
      if (!p.isReferencedIdentifier() || (p.parentPath.isJSXMemberExpression() && p.key === 'property')) return;
      const at = regionAt(p.node.start!);
      if (at === null) return;
      const binding = p.scope.getBinding(p.node.name);
      if (!binding || binding.scope !== programScope || inTypePosition(p)) return;
      let edge = edgeOf(binding);
      if (edge.name === '*') {
        const parent = p.parentPath;
        const member = (parent.isMemberExpression() || parent.isOptionalMemberExpression() || parent.isJSXMemberExpression()) && parent.node.object === p.node && !(parent.node as { computed?: boolean }).computed;
        edge = member ? { file: edge.file, name: exportedName(parent.node.property as Named) } : { whole: edge.file };
      }
      regions[at].edges.push(edge);
    },
    CallExpression(p) {
      const arg = p.node.arguments[0];
      if (p.node.callee.type !== 'Import' || arg?.type !== 'StringLiteral') return;
      const at = regionAt(p.node.start!);
      if (at !== null) regions[at].edges.push({ whole: resolve(file, arg.value) });
    },
  });

  const localEdge = (name: string) => {
    const binding = programScope.getBinding(name);
    return binding ? edgeOf(binding) : null;
  };
  const aliased = (name: string) => {
    const seen = new Set<string>();
    while (aliases.has(name) && !seen.has(name)) {
      seen.add(name);
      name = aliases.get(name)!;
    }
    return name;
  };
  return { regions, regionAt, exports, stars, sideEffects, loads, moduleLevel, localEdge, aliased };
}

function declaredNames(id: Node): string[] {
  const found: string[] = [];
  const walk = (n: Node | null): void => {
    if (!n) return;
    if (n.type === 'Identifier') found.push(n.name);
    else if (n.type === 'ObjectPattern') n.properties.forEach((prop) => walk(prop.type === 'RestElement' ? prop.argument : prop.value));
    else if (n.type === 'ArrayPattern') n.elements.forEach(walk);
    else if (n.type === 'AssignmentPattern') walk(n.left);
    else if (n.type === 'RestElement') walk(n.argument);
  };
  walk(id);
  return found;
}

// parse(file) 는 { ast }, resolve(from, spec) 는 파일 경로나 null, sitesOf(file) 는 그 파일의 호출 자리 [{ start, site }] 를 준다.
export function nameFollower<Site>({ parse, resolve, sitesOf }: NameFollowerOptions<Site>) {
  const analyses = new Map<string, Analysis>();
  const analysis = (file: string | null | undefined): Analysis | null => {
    if (!file || !isScript(file)) return null;
    if (!analyses.has(file)) analyses.set(file, analyze(file, parse, resolve));
    return analyses.get(file)!;
  };
  const unreadable = new Set<string>();
  const readable = (file: string) => {
    if (unreadable.has(file)) return null;
    try {
      return analysis(file);
    } catch {
      unreadable.add(file);
      return null;
    }
  };

  function exportsName(file: string | null, name: string, canEnter: CanEnter, seen = new Set<string | null>()): boolean {
    if (!canEnter(file) || seen.has(file)) return false;
    const a = analysis(file);
    if (!a) return false;
    seen.add(file);
    return a.exports.has(name) || a.stars.some((f) => exportsName(f, name, canEnter, seen));
  }

  // starts 는 [{ file, name }] 이고 name 이 null 이면 파일 전체에서 시작한다. canEnter 가 거짓인 파일에는 들어가지 않는다.
  function reach(starts: { file: string; name: string | null }[], canEnter: CanEnter) {
    const seen = new Set<string>();
    const whole = new Set<string | null>();
    const visited = new Map<string, Set<number>>();
    const stack: Walk[] = starts.map(({ file, name }) => (name === null ? { whole: file } : { file, name }));
    const enter = (file: string | null | undefined) => {
      if (!file || !canEnter(file)) return null;
      const a = analysis(file);
      if (!a) return null;
      if (!visited.has(file)) {
        visited.set(file, new Set());
        for (const idx of a.moduleLevel) stack.push({ file, region: idx });
        for (const f of a.sideEffects) stack.push({ whole: f });
        for (const f of a.loads) stack.push({ load: f });
      }
      return a;
    };
    const follow = (file: string | null | undefined, edge: Edge | null | undefined) => {
      if (!edge) return;
      if (edge.region !== undefined) {
        if (edge.region !== null) stack.push({ file, region: edge.region });
      } else if (edge.whole !== undefined) stack.push({ whole: edge.whole });
      else if (edge.file) stack.push(edge.name === '*' ? { whole: edge.file } : { file: edge.file, name: edge.name });
    };
    while (stack.length) {
      const item = stack.pop()!;
      if (item.load !== undefined) {
        enter(item.load);
        continue;
      }
      if (item.whole !== undefined) {
        const key = `${item.whole}\0*`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = enter(item.whole);
        if (!a) continue;
        whole.add(item.whole);
        a.regions.forEach((_, idx) => stack.push({ file: item.whole, region: idx }));
        for (const exp of a.exports.values()) if (exp.from) follow(item.whole, { file: exp.from, name: exp.name });
        for (const f of a.stars) stack.push({ whole: f });
        continue;
      }
      if (item.region !== undefined) {
        const key = `${item.file}\0#${item.region}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = enter(item.file);
        if (!a) continue;
        visited.get(item.file!)!.add(item.region);
        for (const edge of a.regions[item.region].edges) follow(item.file, edge);
        continue;
      }
      const key = `${item.file}\0${item.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = enter(item.file);
      if (!a) continue;
      const exp = a.exports.get(item.name!);
      if (exp?.region !== undefined) follow(item.file, exp);
      else if (exp?.from !== undefined) follow(item.file, { file: exp.from, name: exp.name });
      else if (exp) {
        const edge = a.localEdge(exp.local!);
        if (edge) follow(item.file, edge);
        else stack.push({ whole: item.file });
      } else {
        const hits = a.stars.filter((f) => exportsName(f, item.name!, canEnter));
        if (hits.length) hits.forEach((f) => stack.push({ file: f, name: item.name }));
        else stack.push({ whole: item.file });
      }
    }
    const sites = new Set<Site>();
    for (const [file, regions] of visited) {
      const a = analysis(file)!;
      const always = new Set(a.moduleLevel);
      for (const { start, site } of sitesOf(file)) {
        const at = a.regionAt(start);
        if (whole.has(file) || at === null || always.has(at) || regions.has(at)) sites.add(site);
      }
    }
    return sites;
  }

  // 다시 내보내는 파일을 거쳐 isEnd 인 파일이 내보내는 이름에 닿으면 { file, name } 을, 아니면 null 을 준다.
  function origin(file: string | null | undefined, name: string, isEnd: (file: string) => boolean, seen = new Set<string>()): Origin | null {
    if (!file) return null;
    if (isEnd(file)) return { file, name };
    const a = readable(file);
    const key = `${file}\0${name}`;
    if (!a || seen.has(key)) return null;
    seen.add(key);
    const exp = a.exports.get(name);
    if (exp?.from !== undefined) return exp.name === '*' ? null : origin(exp.from, exp.name!, isEnd, seen);
    if (exp?.local !== undefined) {
      const edge = a.localEdge(a.aliased(exp.local));
      return edge?.file !== undefined && edge.name !== '*' ? origin(edge.file, edge.name!, isEnd, seen) : null;
    }
    if (exp) return null;
    for (const f of a.stars) {
      const found = origin(f, name, isEnd, seen);
      if (found) return found;
    }
    return null;
  }

  return { reach, origin };
}
