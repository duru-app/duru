import type { Binding, Node, NodePath } from '@babel/traverse';

type NodeOf<T extends Node['type']> = Extract<Node, { type: T }>;
type BinaryExpression = NodeOf<'BinaryExpression'>;
type BooleanLiteral = NodeOf<'BooleanLiteral'>;
type Identifier = NodeOf<'Identifier'>;
type NumericLiteral = NodeOf<'NumericLiteral'>;
type StringLiteral = NodeOf<'StringLiteral'>;

export interface SettingNeed {
  root: string;
  path: string[];
  need: string;
  value?: unknown;
  default?: unknown;
}

export interface SettingNeedsResult {
  settings?: SettingNeed[];
  joined?: boolean;
  reason?: string;
}

export interface SettingNeeds {
  read: (p: NodePath) => SettingNeedsResult | null;
  readNegated: (p: NodePath) => SettingNeedsResult | null;
  readsResult: (p: NodePath) => boolean;
  includes: (chain: string[], entry: string) => SettingNeedsResult;
}

const REASONS = {
  call: '함수를 불러 정하는 조건이라 켤 값을 정할 수 없습니다',
  notEqual: '같지 않음을 보는 조건이라 켤 값을 하나로 정할 수 없습니다',
  or: '「또는」으로 묶인 조건이라 켤 값을 하나로 정할 수 없습니다',
  nonLiteral: '고정된 값이 아닌 것과 비교하는 조건이라 켤 값을 정할 수 없습니다',
  order: '크기를 비교하는 조건이라 켤 값을 정할 수 없습니다',
  negated: '부정한 조건이라 켤 값을 하나로 정할 수 없습니다',
  other: '이 모양의 조건은 읽지 못합니다',
};
const LITERALS = ['StringLiteral', 'NumericLiteral', 'BooleanLiteral'];

// 조건식이 설정에 요구하는 값을 읽는다. 설정을 읽지 않는 조건은 null, 읽지만 값을 정할 수 없으면 { reason }.
// resultOf 는 설정 함수가 돌려준 객체를 가리키는 이름에 그 객체가 놓인 설정 자리 [root, section] 을 준다.
export function settingNeeds(settingsRoots: Iterable<string>, defaults: Record<string, unknown>, resultOf: (id: NodePath<Identifier>) => readonly string[] | null | undefined = () => null): SettingNeeds {
  const roots = new Set(settingsRoots);
  const named = (id: NodePath<Identifier>) => roots.has(id.node.name) || Boolean(resultOf(id));

  function constInit(p: NodePath<Identifier>, seen: Set<Binding>): NodePath | null {
    const binding = p.scope.getBinding(p.node.name);
    if (binding?.kind !== 'const' || seen.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.get('id').isIdentifier()) return null;
    seen.add(binding);
    const init = binding.path.get('init');
    return init.node ? (init as NodePath) : null;
  }

  function mentions(p: NodePath, seen: Set<Binding>, isSetting: (id: NodePath<Identifier>) => boolean = named): boolean {
    const ids: NodePath<Identifier>[] = p.isIdentifier() ? [p] : [];
    p.traverse({ Identifier: (id) => void ids.push(id) });
    return ids.some((id) => {
      if (!id.isReferencedIdentifier()) return false;
      if (isSetting(id)) return true;
      const init = constInit(id, seen);
      return Boolean(init) && mentions(init!, seen, isSetting);
    });
  }

  // system.HELP_LINK_ENABLED (const system = globalSettings.SYSTEM) → ['globalSettings', 'SYSTEM', 'HELP_LINK_ENABLED']
  function settingPath(p: NodePath, seen: Set<Binding>): string[] | null {
    if (p.isIdentifier()) {
      if (roots.has(p.node.name)) return [p.node.name];
      const result = resultOf(p);
      if (result) return [...result];
      const init = constInit(p, seen);
      return init && settingPath(init, seen);
    }
    if (!(p.isMemberExpression() || p.isOptionalMemberExpression())) return null;
    const prop = p.node.property;
    const key = !p.node.computed ? (prop as Identifier).name : prop.type === 'StringLiteral' ? prop.value : null;
    const base = key != null && settingPath(p.get('object') as NodePath, seen);
    return base ? [...base, key] : null;
  }

  const defaultOf = ([root, ...keys]: string[]) => keys.reduce((v: any, k) => (v && typeof v === 'object' ? v[k] : undefined), defaults[root]);

  function needOf(chain: string[], need: string, value?: unknown): SettingNeed {
    const found = defaultOf(chain);
    return {
      root: chain[0],
      path: chain.slice(1),
      need,
      ...(value !== undefined ? { value } : {}),
      ...(found !== undefined ? { default: found } : {}),
    };
  }

  const one = (chain: string[], need: string, value?: unknown) => ({ settings: [needOf(chain, need, value)] });
  const truthy = (chain: string[]) => {
    const d = defaultOf(chain);
    return one(chain, d === undefined || typeof d === 'boolean' ? 'on' : 'present');
  };
  const equals = (chain: string[], value: unknown) => (typeof value === 'boolean' ? one(chain, value ? 'on' : 'off') : one(chain, 'equals', value));

  function negate(result: SettingNeedsResult | null): SettingNeedsResult | null {
    if (!result?.settings) return result;
    const [s] = result.settings;
    if (result.joined || result.settings.length !== 1 || !['on', 'off'].includes(s.need)) return { reason: REASONS.negated };
    return { settings: [{ ...s, need: s.need === 'on' ? 'off' : 'on' }] };
  }

  function compare(p: NodePath<BinaryExpression>, seen: Set<Binding>): SettingNeedsResult {
    const sides = [p.get('left'), p.get('right')];
    const at = sides.findIndex((side) => side.isExpression() && settingPath(side, new Set(seen)));
    const other = sides[1 - at];
    if (at < 0 || !LITERALS.includes(other.node.type)) return { reason: REASONS.nonLiteral };
    return equals(settingPath(sides[at], new Set(seen))!, (other.node as StringLiteral | NumericLiteral | BooleanLiteral).value);
  }

  function read(p: NodePath, seen = new Set<Binding>()): SettingNeedsResult | null {
    if (!mentions(p, new Set(seen))) return null;
    const chain = settingPath(p, new Set(seen));
    if (chain) return chain.length > 1 ? truthy(chain) : { reason: REASONS.other };
    if (p.isIdentifier()) {
      const init = constInit(p, seen);
      return init ? read(init, seen) : { reason: REASONS.other };
    }
    if (p.isUnaryExpression({ operator: '!' })) return negate(read(p.get('argument'), seen));
    if (p.isLogicalExpression()) {
      if (p.node.operator !== '&&') return { reason: REASONS.or };
      const parts = [read(p.get('left'), new Set(seen)), read(p.get('right'), new Set(seen))];
      // 설정을 읽지 않는 쪽(역할 검사 등)은 버리므로, 앞에 `!`가 붙으면 남은 설정만 뒤집어서는 안 된다.
      return parts.find((r) => r?.reason) ?? { settings: parts.flatMap((r) => r?.settings ?? []), joined: true };
    }
    if (p.isBinaryExpression()) {
      const op = p.node.operator;
      if (op === '===' || op === '==') return compare(p, seen);
      if (op === '!==' || op === '!=') return { reason: REASONS.notEqual };
      if (['<', '<=', '>', '>='].includes(op)) return { reason: REASONS.order };
      return { reason: REASONS.other };
    }
    if (p.isCallExpression() || p.isOptionalCallExpression()) return { reason: REASONS.call };
    return { reason: REASONS.other };
  }

  return {
    read,
    readNegated: (p: NodePath) => negate(read(p)),
    readsResult: (p: NodePath) => mentions(p, new Set(), (id) => Boolean(resultOf(id))),
    includes: (chain: string[], entry: string) => one(chain, 'includes', entry),
  };
}
