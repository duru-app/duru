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
export function settingNeeds(settingsRoots, defaults) {
  const roots = new Set(settingsRoots);

  function constInit(p, seen) {
    const binding = p.scope.getBinding(p.node.name);
    if (binding?.kind !== 'const' || seen.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.get('id').isIdentifier()) return null;
    seen.add(binding);
    const init = binding.path.get('init');
    return init.node ? init : null;
  }

  function mentions(p, seen) {
    const ids = p.isIdentifier() ? [p] : [];
    p.traverse({ Identifier: (id) => void ids.push(id) });
    return ids.some((id) => {
      if (!id.isReferencedIdentifier()) return false;
      if (roots.has(id.node.name)) return true;
      const init = constInit(id, seen);
      return Boolean(init) && mentions(init, seen);
    });
  }

  // system.HELP_LINK_ENABLED (const system = globalSettings.SYSTEM) → ['globalSettings', 'SYSTEM', 'HELP_LINK_ENABLED']
  function settingPath(p, seen) {
    if (p.isIdentifier()) {
      if (roots.has(p.node.name)) return [p.node.name];
      const init = constInit(p, seen);
      return init && settingPath(init, seen);
    }
    if (!(p.isMemberExpression() || p.isOptionalMemberExpression())) return null;
    const prop = p.node.property;
    const key = !p.node.computed ? prop.name : prop.type === 'StringLiteral' ? prop.value : null;
    const base = key != null && settingPath(p.get('object'), seen);
    return base ? [...base, key] : null;
  }

  const defaultOf = ([root, ...keys]) => keys.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), defaults[root]);

  function needOf(chain, need, value) {
    const found = defaultOf(chain);
    return {
      root: chain[0],
      path: chain.slice(1),
      need,
      ...(value !== undefined ? { value } : {}),
      ...(found !== undefined ? { default: found } : {}),
    };
  }

  const one = (chain, need, value) => ({ settings: [needOf(chain, need, value)] });
  const truthy = (chain) => {
    const d = defaultOf(chain);
    return one(chain, d === undefined || typeof d === 'boolean' ? 'on' : 'present');
  };
  const equals = (chain, value) => (typeof value === 'boolean' ? one(chain, value ? 'on' : 'off') : one(chain, 'equals', value));

  function negate(result) {
    if (!result?.settings) return result;
    const [s] = result.settings;
    if (result.joined || result.settings.length !== 1 || !['on', 'off'].includes(s.need)) return { reason: REASONS.negated };
    return { settings: [{ ...s, need: s.need === 'on' ? 'off' : 'on' }] };
  }

  function compare(p, seen) {
    const sides = [p.get('left'), p.get('right')];
    const at = sides.findIndex((side) => side.isExpression() && settingPath(side, new Set(seen)));
    const other = sides[1 - at];
    if (at < 0 || !LITERALS.includes(other.node.type)) return { reason: REASONS.nonLiteral };
    return equals(settingPath(sides[at], new Set(seen)), other.node.value);
  }

  function read(p, seen = new Set()) {
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
    readNegated: (p) => negate(read(p)),
    includes: (chain, entry) => one(chain, 'includes', entry),
  };
}
