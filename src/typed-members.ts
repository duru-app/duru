import fs from 'node:fs';
import ts from 'typescript';

export interface MemberTarget {
  file: string;
  // 클래스 이름이 적힌 위치
  at: number;
  // '*' 는 클래스의 멤버 전부
  member: string;
  self: string;
  quiet?: true;
}

export interface TypedMembers {
  // 이 파일에서 멤버 단위로 추적하는 클래스의 이름이 적힌 위치와, 그 클래스에서 따로 추적하는 멤버의 이름
  classesIn: (file: string) => Map<number, Set<string>>;
  names: Set<string>;
  // file 의 at 위치에서 참조하는 멤버가 가리키는 메서드들. self 는 그 위치의 this 가 가리키는 클래스다.
  targets: (file: string, at: number, self: string | null) => MemberTarget[];
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  experimentalDecorators: true,
};

function strip(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
}

const isStatic = (node: ts.Node) => Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static);
const isFunctionValue = (node: ts.Expression | undefined) => Boolean(node && (ts.isArrowFunction(strip(node)) || ts.isFunctionExpression(strip(node))));

function memberName(node: ts.ClassElement): string | null {
  if (isStatic(node) || !node.name || !(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return null;
  const runs = ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body !== undefined)
    || (ts.isPropertyDeclaration(node) && isFunctionValue(node.initializer));
  return runs ? node.name.text : null;
}

function callsUseContext(fn: ts.Node) {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = strip(n.expression);
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name === 'useContext') found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

function contextHooks(source: ts.SourceFile) {
  const hooks: ts.SignatureDeclaration[] = [];
  const named = (name: ts.Node | undefined) => Boolean(name && ts.isIdentifier(name) && /^use[A-Z0-9]/.test(name.text));
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && named(n.name) && n.body && callsUseContext(n.body)) hooks.push(n);
    if (ts.isVariableDeclaration(n) && named(n.name) && n.initializer) {
      const init = strip(n.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && callsUseContext(init.body)) hooks.push(init);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return hooks;
}

function startsWithBom(file: string) {
  if (!fs.existsSync(file)) return false;
  const head = Buffer.alloc(3);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 3, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head.equals(Buffer.from([0xef, 0xbb, 0xbf]));
}

const CLASS_LINE = /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:abstract[ \t]+)?class[ \t]+[A-Za-z_$]/m;
const IMPORT_FROM = /^[ \t]*(?:import|export)[ \t][^;]*?from[ \t]*['"]([^'"]+)['"]/gm;
const EXPORT_FROM = /^[ \t]*export[ \t][^;]*?from[ \t]*['"]([^'"]+)['"]/gm;

// TypeScript 프로그램을 만들기 전에 소스 텍스트만 보고 거른다. useContext 를 쓰는 파일과, 그 파일이 import 하는 파일(타입만
// 가져오는 것도 포함), 그 파일이 다시 import 하는 파일, 그리고 이들이 re-export 하는 파일 가운데 클래스 선언이 하나도 없으면
// 훅이 클래스를 돌려줄 수 없다고 본다.
function mayHoldContextClass(sources: string[], resolve: (from: string, spec: string) => string | null) {
  const text = new Map<string, string>();
  const read = (f: string) => {
    if (!text.has(f)) text.set(f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    return text.get(f)!;
  };
  const linked = (f: string, line: RegExp) => [...read(f).matchAll(line)].map((m) => resolve(f, m[1])).filter((t): t is string => Boolean(t));
  const hooks = sources.filter((f) => /\buseContext\b/.test(read(f)));
  const near = new Set([...hooks, ...hooks.flatMap((f) => linked(f, IMPORT_FROM))]);
  for (const f of [...near]) for (const t of linked(f, IMPORT_FROM)) near.add(t);
  for (const f of near) for (const t of linked(f, EXPORT_FROM)) near.add(t);
  return [...near].some((f) => CLASS_LINE.test(read(f)));
}

// files 가운데 React context 훅이 돌려주는 클래스와, 그 클래스의 필드에 담긴 클래스, 그리고 그 클래스들의 부모 클래스는
// 멤버마다 따로 추적한다. 그런 클래스가 없으면 null 이다.
export function typedMembers(tsconfig: string | null, files: string[], resolve: (from: string, spec: string) => string | null): TypedMembers | null {
  const sources = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  if (!mayHoldContextClass(sources, resolve)) return null;

  const parsed = tsconfig ? ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }) : null;
  const program = ts.createProgram({ rootNames: sources, options: { ...DEFAULT_OPTIONS, ...parsed?.options, allowJs: true, noEmit: true } });
  const checker = program.getTypeChecker();
  const own = (source: ts.SourceFile) => !source.isDeclarationFile && !program.isSourceFileFromExternalLibrary(source) && !source.fileName.includes('/node_modules/');

  // TypeScript 는 파일 맨 앞의 BOM 을 떼고 위치를 세지만, Babel 은 BOM 도 한 글자로 센다.
  const bomOf = new Map<string, number>();
  const startOf = (n: ts.Node) => {
    const file = n.getSourceFile().fileName;
    if (!bomOf.has(file)) bomOf.set(file, startsWithBom(file) ? 1 : 0);
    return n.getStart() + bomOf.get(file)!;
  };
  const classKey = (c: ts.ClassDeclaration) => `${c.getSourceFile().fileName}\0${startOf(c.name!)}`;
  const byKey = new Map<string, ts.ClassDeclaration>();
  const children = new Map<ts.ClassDeclaration, ts.ClassDeclaration[]>();
  const parentOf = new Map<ts.ClassDeclaration, ts.ClassDeclaration | null>();

  const classOfSymbol = (symbol: ts.Symbol | undefined): ts.ClassDeclaration | null => {
    if (!symbol) return null;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const found = symbol.declarations?.find((d): d is ts.ClassDeclaration => ts.isClassDeclaration(d) && Boolean(d.name) && own(d.getSourceFile()));
    return found ?? null;
  };

  const parent = (c: ts.ClassDeclaration) => {
    if (!parentOf.has(c)) {
      const heritage = c.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      parentOf.set(c, heritage ? classOfSymbol(checker.getSymbolAtLocation(heritage.expression)) : null);
    }
    return parentOf.get(c)!;
  };

  for (const source of program.getSourceFiles()) {
    if (!own(source)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isClassDeclaration(n) && n.name && n.parent === source) {
        byKey.set(classKey(n), n);
        const up = parent(n);
        if (up) children.set(up, [...(children.get(up) ?? []), n]);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }

  const isEmptyObject = (t: ts.Type) => Boolean(t.flags & ts.TypeFlags.Object) && !checker.getPropertiesOfType(t).length && !t.getCallSignatures().length && !t.getConstructSignatures().length;
  // 알 수 없는 타입이면 null 이다.
  const resolved = (type: ts.Type): ts.Type | null => {
    const seen = new Set<ts.Type>();
    for (let t: ts.Type | undefined = type; t && !seen.has(t);) {
      seen.add(t);
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
      const nonNull = checker.getNonNullableType(t);
      const generic = nonNull.isIntersection() && nonNull.types.length === 2 && nonNull.types.find((x) => x.flags & ts.TypeFlags.Instantiable);
      if (generic && nonNull.types.some(isEmptyObject)) t = generic;
      else if (nonNull.flags & ts.TypeFlags.Instantiable) t = checker.getBaseConstraintOfType(nonNull);
      else return nonNull;
    }
    return null;
  };

  const classesOfType = (type: ts.Type): ts.ClassDeclaration[] => {
    const t = resolved(type);
    if (!t) return [];
    if (t.isUnion() || t.isIntersection()) return t.types.flatMap(classesOfType);
    const found = classOfSymbol(t.getSymbol());
    return found && byKey.has(classKey(found)) ? [found] : [];
  };

  const instanceOf = new Map<ts.ClassDeclaration, ts.Type>();
  const instance = (c: ts.ClassDeclaration) => {
    if (!instanceOf.has(c)) instanceOf.set(c, checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(c.name!)!));
    return instanceOf.get(c)!;
  };

  const followed = new Set<ts.ClassDeclaration>();
  // 루트 클래스의 필드 이름 → 그 필드에 담긴 클래스
  const fields = new Map<string, ts.ClassDeclaration[]>();
  const add = (c: ts.ClassDeclaration | null) => {
    for (let at = c; at && !followed.has(at); at = parent(at)) followed.add(at);
  };
  for (const source of program.getSourceFiles()) {
    if (!own(source)) continue;
    for (const hook of contextHooks(source)) {
      const signature = checker.getSignatureFromDeclaration(hook);
      if (!signature) continue;
      const type = checker.getReturnTypeOfSignature(signature);
      for (const root of classesOfType(type)) {
        add(root);
        for (const prop of checker.getPropertiesOfType(instance(root))) {
          const field = prop.valueDeclaration;
          if (!field || !ts.isPropertyDeclaration(field) || isFunctionValue(field.initializer)) continue;
          for (const c of classesOfType(checker.getTypeOfSymbol(prop))) {
            add(c);
            fields.set(prop.name, [...(fields.get(prop.name) ?? []), c]);
          }
        }
      }
    }
  }
  if (!followed.size) return null;

  const membersOf = new Map<ts.ClassDeclaration, Set<string>>();
  const members = (c: ts.ClassDeclaration) => {
    if (!membersOf.has(c)) membersOf.set(c, new Set(c.members.map(memberName).filter((n): n is string => n !== null)));
    return membersOf.get(c)!;
  };
  const names = new Set([...followed].flatMap((c) => [...members(c)]));
  const descendants = (c: ts.ClassDeclaration): ts.ClassDeclaration[] => (children.get(c) ?? []).flatMap((d) => [d, ...descendants(d)]);

  // receiver 의 인스턴스에서 name 을 참조할 때 실행될 수 있는 정의: 부모 쪽으로 올라가며 처음 찾은 것과, 자식 클래스가 override 한 것
  function implementations(receiver: ts.ClassDeclaration, name: string, exact: boolean): MemberTarget[] {
    const found: MemberTarget[] = [];
    const take = (c: ts.ClassDeclaration, member: string, self: ts.ClassDeclaration) => {
      if (followed.has(c)) found.push({ file: c.getSourceFile().fileName, at: startOf(c.name!), member, self: classKey(self) });
    };
    if (name === '*') {
      for (let at: ts.ClassDeclaration | null = receiver; at; at = parent(at)) take(at, '*', receiver);
      for (const d of descendants(receiver)) take(d, '*', d);
      return found;
    }
    for (let at: ts.ClassDeclaration | null = receiver; at; at = parent(at)) {
      if (members(at).has(name)) {
        take(at, name, receiver);
        break;
      }
    }
    if (!exact) for (const d of descendants(receiver)) if (members(d).has(name)) take(d, name, d);
    return found;
  }

  const enclosingClass = (n: ts.Node): ts.ClassDeclaration | null => {
    for (let at: ts.Node | undefined = n.parent; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at) || ((ts.isMethodDeclaration(at) || ts.isAccessor(at)) && ts.isObjectLiteralExpression(at.parent))) return null;
      if (ts.isClassElement(at) && isStatic(at)) return null;
      if (ts.isClassDeclaration(at)) return at.name && byKey.has(classKey(at)) ? at : null;
    }
    return null;
  };

  const placesOf = new Map<string, Map<number, ts.Node>>();
  const places = (file: string) => {
    if (!placesOf.has(file)) {
      const found = new Map<number, ts.Node>();
      const source = program.getSourceFile(file);
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n)) found.set(startOf(n.name), n);
        else if (ts.isElementAccessExpression(n)) found.set(startOf(n.argumentExpression), n);
        else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) found.set(startOf(n.propertyName ?? n.name), n);
        ts.forEachChild(n, visit);
      };
      if (source) visit(source);
      placesOf.set(file, found);
    }
    return placesOf.get(file)!;
  };

  const lastName = (expr: ts.Expression | undefined): string | null => {
    const e = expr && strip(expr);
    if (!e) return null;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : null;
  };
  // 타입을 알 수 없는 값은, 마지막에 참조하는 이름이 루트 클래스의 필드 이름이면 그 필드의 클래스로 본다.
  // 그 밖의 값에서 키를 실행 중에 정해 접근하면('*') 따라가지 않는다.
  const fromType = (type: ts.Type, name: string, holder: ts.Expression | undefined) => {
    const target = resolved(type);
    const untyped = target === null;
    const classes = untyped ? (fields.get(lastName(holder) ?? '') ?? []) : classesOfType(type);
    if (classes.length) return classes.flatMap((c) => implementations(c, name, false));
    if (name === '*') return [];
    const possible = [...followed].filter((c) => untyped || checker.isTypeAssignableTo(instance(c), target));
    return possible.flatMap((c) => implementations(c, name, true)).map((t) => ({ ...t, quiet: true as const }));
  };

  const cache = new Map<string, MemberTarget[]>();
  function targets(file: string, at: number, self: string | null): MemberTarget[] {
    const key = `${file}\0${at}\0${self ?? ''}`;
    if (!cache.has(key)) cache.set(key, resolveTargets(file, at, self));
    return cache.get(key)!;
  }

  function resolveTargets(file: string, at: number, self: string | null): MemberTarget[] {
    const node = places(file).get(at);
    if (!node) return [];
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
      const declared = node.parent.parent;
      const holder = ts.isVariableDeclaration(declared) ? declared.initializer : undefined;
      return name && names.has(name) ? fromType(checker.getTypeAtLocation(node.parent), name, holder) : [];
    }
    const access = node as ts.PropertyAccessExpression | ts.ElementAccessExpression;
    const name = ts.isPropertyAccessExpression(access) ? access.name.text : ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : '*';
    if (name !== '*' && !names.has(name)) return [];
    const object = strip(access.expression);
    const inClass = enclosingClass(access);
    if (object.kind === ts.SyntaxKind.SuperKeyword) {
      const up = inClass && parent(inClass);
      return up && name !== '*' ? implementations(up, name, true).map((t) => ({ ...t, self: self ?? classKey(inClass) })) : [];
    }
    if (object.kind === ts.SyntaxKind.ThisKeyword && inClass) return implementations((self && byKey.get(self)) || inClass, name, false);
    return fromType(checker.getTypeAtLocation(object), name, object);
  }

  const classesIn = (file: string) => new Map([...followed].filter((c) => c.getSourceFile().fileName === file).map((c) => [startOf(c.name!), members(c)]));
  return { classesIn, names, targets };
}
