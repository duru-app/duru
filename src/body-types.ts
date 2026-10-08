import ts from 'typescript';

export interface BodyMethod {
  key: string;
  file: string;
  line: number;
  shownFile: string;
}

export interface BodyTypeNotice {
  method: string;
  field?: string;
  beside?: string;
  reason?: string;
}

export interface BodyFields {
  fields: Map<string, string[]>;
  notices: BodyTypeNotice[];
}

const MAX_DEPTH = 8;
// 이름에서 이 낱말들을 빼고 남은 낱말이 하나라도 같으면 같은 것을 가리키는 칸으로 본다(enabledAuth 와 authType).
const COMMON_WORDS = new Set(['enabled', 'enable', 'is', 'has', 'use', 'type', 'kind', 'mode']);
const wordsOf = (name: string) => name.split(/(?=[A-Z])|_/).map((w) => w.toLowerCase()).filter((w) => w && !COMMON_WORDS.has(w));

type FunctionNode = ts.MethodDeclaration | ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
const isFunction = (n: ts.Node): n is FunctionNode =>
  (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body !== undefined;
const PASSING = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

// 메서드 key 마다 그 메서드가 bodyKeys 이름으로 넘기는 값의 타입에서 켜기 · 끄기 칸의 경로를 찾는다. 배열 안의 칸은 `items[].on` 처럼 적는다.
export function readBodyFields(tsconfig: string, bodyKeys: string[], methods: BodyMethod[]): BodyFields {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const program = ts.createProgram({ rootNames: [...new Set(methods.map((m) => m.file))], options: { ...parsed?.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const fields = new Map<string, string[]>();
  const notices: BodyTypeNotice[] = [];

  const functionAt = (file: string, line: number): FunctionNode | null => {
    const source = program.getSourceFile(file);
    if (!source) return null;
    let found: FunctionNode | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      const starts = [n.getStart(source), ...(isFunction(n) && n.name ? [n.name.getStart(source)] : [])];
      if (isFunction(n) && starts.some((at) => source.getLineAndCharacterOfPosition(at).line + 1 === line)) found = n;
      else ts.forEachChild(n, visit);
    };
    visit(source);
    return found;
  };

  const isCallArgument = (object: ts.ObjectLiteralExpression): boolean => {
    let at: ts.Node = object;
    for (;;) {
      const up: ts.Node = at.parent;
      const passes = ts.isParenthesizedExpression(up) || ts.isAsExpression(up) || ts.isSatisfiesExpression(up) || ts.isNonNullExpression(up) || ts.isTypeAssertionExpression(up)
        || (ts.isConditionalExpression(up) && up.condition !== at)
        || (ts.isBinaryExpression(up) && (PASSING.has(up.operatorToken.kind) || (up.operatorToken.kind === ts.SyntaxKind.CommaToken && up.right === at)));
      if (!passes) break;
      at = up;
    }
    if (ts.isSpreadAssignment(at.parent) && ts.isObjectLiteralExpression(at.parent.parent)) return isCallArgument(at.parent.parent);
    const call = at.parent;
    return (ts.isCallExpression(call) || ts.isNewExpression(call)) && (call.arguments ?? []).some((arg) => arg === at);
  };

  const bodyTypes = (fn: FunctionNode, seen = new Set<ts.Node>()): ts.Type[] => {
    if (seen.has(fn)) return [];
    seen.add(fn);
    const found: ts.Type[] = [];
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      const named = (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && bodyKeys.includes(n.name.text);
      if (named && ts.isObjectLiteralExpression(n.parent) && isCallArgument(n.parent)) {
        if (ts.isPropertyAssignment(n)) found.push(checker.getTypeAtLocation(n.initializer));
        else {
          const value = checker.getShorthandAssignmentValueSymbol(n);
          if (value) found.push(checker.getTypeOfSymbolAtLocation(value, n));
        }
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) calls.push(n);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn, visit);
    if (found.length) return found;
    for (const call of calls) {
      const callee = call.expression as ts.PropertyAccessExpression;
      for (const d of checker.getSymbolAtLocation(callee.name)?.declarations ?? []) {
        const target = isFunction(d) ? d : ts.isPropertyDeclaration(d) && d.initializer && isFunction(d.initializer) ? d.initializer : null;
        if (target) found.push(...bodyTypes(target, seen));
      }
    }
    return found;
  };

  const textOrNumber = (t: ts.Type) => (t.isUnion() ? t.types : [t]).every((member) => member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike));
  const isOnOff = (t: ts.Type) => (t.flags & ts.TypeFlags.Boolean) !== 0;
  const isChoice = (t: ts.Type) => (t.flags & ts.TypeFlags.EnumLike) !== 0 || (t.isUnion() && t.types.length > 1 && t.types.every((m) => m.flags & ts.TypeFlags.StringLiteral));

  for (const m of methods) {
    const fn = functionAt(m.file, m.line);
    if (!fn) {
      notices.push({ method: m.key, reason: `no function was found at ${m.shownFile}:${m.line}` });
      continue;
    }
    const found = new Set<string>();
    const said = new Set<string>();
    const tell = (notice: BodyTypeNotice) => {
      const key = JSON.stringify(notice);
      if (!said.has(key)) notices.push(notice);
      said.add(key);
    };
    const walk = (type: ts.Type, at: string, path: ts.Type[]) => {
      const t = checker.getNonNullableType(type);
      if (path.includes(t) || path.length > MAX_DEPTH) return;
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
        tell({ method: m.key, reason: `${at ? `the body field ${at}` : 'the body'} is typed ${checker.typeToString(t)}, so its fields are not known` });
        return;
      }
      if (t.isUnion()) {
        for (const member of t.types) walk(member, at, path);
        return;
      }
      if (checker.isArrayType(t) || checker.isTupleType(t)) {
        for (const item of checker.getTypeArguments(t as ts.TypeReference)) walk(item, `${at}[]`, [...path, t]);
        return;
      }
      if (!(t.flags & ts.TypeFlags.Object) && !t.isIntersection()) return;
      if (checker.getSignaturesOfType(t, ts.SignatureKind.Call).length) return;
      const props = checker.getPropertiesOfType(t);
      const indexes = checker.getIndexInfosOfType(t);
      if (!props.length && indexes.some((info) => !textOrNumber(checker.getNonNullableType(info.type)))) {
        tell({ method: m.key, reason: `${at ? `the body field ${at}` : 'the body'} is typed ${checker.typeToString(t)}, which names no fields` });
        return;
      }
      const typed = props.map((p) => ({ name: p.name, type: checker.getNonNullableType(checker.getTypeOfSymbol(p)) }));
      const choices = typed.filter((p) => isChoice(p.type));
      for (const p of typed) {
        const field = at ? `${at}.${p.name}` : p.name;
        if (!isOnOff(p.type)) {
          walk(p.type, field, [...path, t]);
          continue;
        }
        const words = wordsOf(p.name);
        const beside = choices.find((c) => wordsOf(c.name).some((w) => words.includes(w)));
        if (beside) tell({ method: m.key, field, beside: at ? `${at}.${beside.name}` : beside.name });
        else found.add(field);
      }
    };
    const types = bodyTypes(fn);
    if (!types.length) tell({ method: m.key, reason: `it sent a body, but no ${bodyKeys.join(' or ')} was found in an object it gives to a call` });
    for (const type of types) walk(type, '', []);
    if (found.size) fields.set(m.key, [...found].sort());
  }
  return { fields, notices };
}
