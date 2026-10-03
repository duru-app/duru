import { parseExpression } from '@babel/parser';
import { lookupConstant, memberChain, UNKNOWN } from './client.mjs';
import { parseRoleEntry } from './config.mjs';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rolePattern(entry) {
  const { name, object, key } = parseRoleEntry(entry);
  if (name) return escapeRegExp(name);
  const obj = escapeRegExp(object);
  const k = escapeRegExp(key);
  const bracket = `${obj}\\s*(?:\\?\\.\\s*)?\\[\\s*(?:'${k}'|"${k}")\\s*\\]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${bracket}|${obj}\\s*\\??\\.\\s*${k}` : bracket;
}

const rolesSource = (config) => (config.roleIdentifiers ?? []).map(rolePattern).join('|');

function guardKinds(config, guardInits) {
  const alt = (names) => names.map(escapeRegExp).join('|');
  const rules = [];
  if (config.roleIdentifiers?.length) rules.push(['role', new RegExp(`(?<![\\w$])(?:${rolesSource(config)})(?![\\w$])`)]);
  const settings = config.settingsRoots ?? [];
  if (settings.length) rules.push(['setting', new RegExp(`(?<![\\w$])(?:${alt(settings)})\\s*\\??\\.`)]);
  return (guard, file) => {
    const entry = guardInits.get(file)?.get(guard);
    const texts = [entry?.source ?? guard, ...(entry?.inits ?? []).map((i) => i.init)];
    return rules.filter(([, re]) => texts.some((t) => re.test(t))).map(([kind]) => kind);
  };
}

const NODE_META = new Set(['type', 'start', 'end', 'loc', 'extra', 'comments', 'errors', 'leadingComments', 'trailingComments', 'innerComments']);

function childNodes(node) {
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return node.computed ? [node.object, node.property] : [node.object];
  if (node.type === 'ObjectProperty') return node.computed ? [node.key, node.value] : [node.value];
  return Object.entries(node)
    .filter(([k]) => !NODE_META.has(k))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter((v) => typeof v?.type === 'string');
}

const numberOf = (node) =>
  node.type === 'NumericLiteral' ? node.value
    : node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral' ? -node.argument.value : undefined;
// indexOf 결과를 이렇게 비교하면 목록에 들어 있다는 뜻이다.
const FOUND = { '>': -1, '>=': 0, '!==': -1, '!=': -1 };
const intersect = (sets) => sets.reduce((a, b) => new Set([...a].filter((v) => b.has(v))));

function nameReads(node, names) {
  if (node.type === 'Identifier') return names.includes(node.name) ? [node] : [];
  return childNodes(node).flatMap((child) => nameReads(child, names));
}

// 역할 조건이 역할을 어떤 값과 견주는지 읽는다. 값을 읽을 수 없으면 null 이다.
function roleReader(config, guardInits, constants) {
  const isRole = new RegExp(`^(?:${rolesSource(config)})$`);
  const roleNames = new Set((config.roleIdentifiers ?? []).map((e) => parseRoleEntry(e).name).filter(Boolean));
  const isMember = (node) => (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed;
  const isProps = (node) =>
    (node.type === 'Identifier' && node.name === 'props') || (isMember(node) && node.object.type === 'ThisExpression' && node.property.name === 'props');
  const isPropsMember = (node) => isMember(node) && roleNames.has(node.property.name) && isProps(node.object);
  const parsed = new Map();
  const parse = (text) => {
    if (!parsed.has(text)) {
      try {
        parsed.set(text, parseExpression(text, { plugins: ['jsx'] }));
      } catch {
        parsed.set(text, null);
      }
    }
    return parsed.get(text) && { node: parsed.get(text), text };
  };

  return (guard, file) => {
    const entry = guardInits.get(file)?.get(guard);
    const inits = entry?.inits ?? [];
    const helpers = entry?.helpers ?? new Map();
    const initOf = ({ node }, seen) => {
      if (node.type !== 'Identifier' || seen.has(node.name)) return null;
      const found = inits.filter((i) => i.name === node.name);
      return found.length === 1 ? parse(found[0].init) : null;
    };
    const at = (expr, node) => ({ node, text: expr.text });
    const follow = (expr, seen) => [initOf(expr, seen), new Set([...seen, expr.node.name])];
    const inlined = (expr, seen) => {
      const { node } = expr;
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || seen.has(node.callee.name)) return [null, seen];
      const fn = helpers.get(node.callee.name);
      const body = fn && node.arguments.length === fn.params.length && !node.arguments.some((a) => a.type === 'SpreadElement') && parse(fn.body);
      if (!body) return [null, seen];
      let { text } = body;
      for (const ref of nameReads(body.node, fn.params).sort((a, b) => b.start - a.start)) {
        const arg = node.arguments[fn.params.indexOf(ref.name)];
        text = `${text.slice(0, ref.start)}(${expr.text.slice(arg.start, arg.end)})${text.slice(ref.end)}`;
      }
      return [parse(text), new Set([...seen, node.callee.name])];
    };

    const isRoleRead = (expr, seen) => {
      if (isRole.test(expr.text.slice(expr.node.start, expr.node.end))) return true;
      if (isPropsMember(expr.node)) return true;
      const [init, next] = follow(expr, seen);
      return Boolean(init) && isRoleRead(init, next);
    };
    const mentionsRole = (expr, seen) => {
      if (isRoleRead(expr, seen)) return true;
      const [init, next] = follow(expr, seen);
      if (init) return mentionsRole(init, next);
      return childNodes(expr.node).some((n) => mentionsRole(at(expr, n), seen));
    };
    const valueOf = (expr, seen) => {
      const { node } = expr;
      if (node.type === 'StringLiteral') return node.value;
      if (node.type === 'ArrayExpression') {
        const values = node.elements.map((e) => e && valueOf(at(expr, e), seen));
        return values.every((v) => typeof v === 'string') ? values : undefined;
      }
      if (node.type === 'MemberExpression') return lookupConstant(constants, memberChain(node));
      const [init, next] = follow(expr, seen);
      return init ? valueOf(init, next) : undefined;
    };
    const listed = (expr, method, seen) => {
      const { node } = expr;
      if (node.type !== 'CallExpression' || node.arguments.length !== 1) return undefined;
      const { callee } = node;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== method) return undefined;
      if (!isRoleRead(at(expr, node.arguments[0]), seen)) return undefined;
      const values = valueOf(at(expr, callee.object), seen);
      return Array.isArray(values) && values.every((v) => typeof v === 'string') ? new Set(values) : undefined;
    };
    const compared = (expr, seen) => {
      const { node } = expr;
      if (node.type === 'CallExpression') return listed(expr, 'includes', seen);
      if (node.type !== 'BinaryExpression') return undefined;
      const [left, right] = [at(expr, node.left), at(expr, node.right)];
      if (node.operator === '===' || node.operator === '==') {
        const value = isRoleRead(left, seen) ? valueOf(right, seen) : isRoleRead(right, seen) ? valueOf(left, seen) : undefined;
        return typeof value === 'string' ? new Set([value]) : undefined;
      }
      return node.operator in FOUND && numberOf(node.right) === FOUND[node.operator] ? listed(left, 'indexOf', seen) : undefined;
    };

    // 역할을 읽지 않는 식은 undefined, 역할을 읽지만 값을 알 수 없는 식은 null 이다.
    const read = (expr, seen) => {
      if (isRoleRead(expr, seen)) return null;
      const { node } = expr;
      if (node.type === 'Identifier') {
        const [init, next] = follow(expr, seen);
        return init ? read(init, next) : undefined;
      }
      const [body, next] = inlined(expr, seen);
      if (body) return read(body, next);
      if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||')) {
        const l = read(at(expr, node.left), seen);
        const r = read(at(expr, node.right), seen);
        if (l === undefined && r === undefined) return undefined;
        if (node.operator === '&&') return l === undefined ? r : r === undefined ? l : l && r && intersect([l, r]);
        return l && r && new Set([...l, ...r]);
      }
      return compared(expr, seen) ?? (mentionsRole(expr, seen) ? null : undefined);
    };

    const expr = parse(entry?.source ?? guard);
    const values = expr && read(expr, new Set());
    return values?.size ? [...values].sort() : null;
  };
}

function linkTargets(screens) {
  return (to) => {
    if (typeof to !== 'string' || to.includes(UNKNOWN)) return [];
    const indices = screens.map((_, i) => i);
    const exact = indices.filter((i) => screens[i].path === to);
    if (exact.length) return exact;
    const prefix = to.replace(/\/$/, '') + '/';
    return indices.filter((i) => {
      const p = screens[i].path;
      return p.startsWith(prefix) && p.slice(prefix.length).split('/').every((seg) => seg.startsWith(':'));
    });
  };
}

const NO_SETTING_READ = '조건에서 설정을 읽는 곳을 찾지 못했습니다';

function settingsOf(guardSettings, guard, file) {
  const read = guardSettings.get(file)?.get(guard);
  return read?.settings ? { settings: read.settings } : { settings: null, settingsReason: read?.reason ?? NO_SETTING_READ };
}

const distinct = (list) => [...new Map(list.map((x) => [JSON.stringify(x), x])).values()];

function settingParts(guards) {
  const setting = guards.filter((g) => g.kinds.includes('setting'));
  return {
    guarded: setting.length > 0,
    needs: distinct(setting.flatMap((g) => g.settings ?? [])),
    unreadable: setting.filter((g) => !g.settings).map((g) => ({ guard: g.guard, reason: g.settingsReason })),
  };
}

function settingSources(route, links) {
  const sources = [];
  const add = (from, { guarded, inherited, needs, unreadable }) => {
    if (guarded || needs.length || unreadable.length) sources.push({ ...from, ...(inherited ? { inherited } : {}), needs, unreadable });
  };
  add({ from: 'route' }, settingParts(route));
  for (const l of links) add({ from: l.from, file: l.file, line: l.line }, l.settings);
  return sources;
}

// 서로 링크를 건 화면끼리 값이 계속 바뀌지 않도록 도는 횟수를 화면 수로 막는다.
function settle(targets, values, compute) {
  for (let changed = true, round = 0; changed && round <= targets.length; round += 1) {
    changed = false;
    for (const i of targets) {
      const v = compute(i);
      if (JSON.stringify(v) === JSON.stringify(values[i])) continue;
      values[i] = v;
      changed = true;
    }
  }
}

export function screenAccess(screens, redirects, config, guardInits, constants, guardSettings) {
  const kindsOf = guardKinds(config, guardInits);
  const rolesOf = roleReader(config, guardInits, constants);
  const blocking = (guards, file, via) =>
    guards.flatMap((guard) => {
      const kinds = kindsOf(guard, file);
      if (!kinds.length) return [];
      return [{ guard, kinds, ...(kinds.includes('role') ? { roles: rolesOf(guard, file) } : {}), ...(via ? { via } : {}), ...(kinds.includes('setting') ? settingsOf(guardSettings, guard, file) : {}) }];
    });

  const route = screens.map((s) => blocking(s.routeGuards, config.routesFile));
  const incoming = screens.map(() => []);
  const outgoing = screens.map(() => []);
  const targetsOf = linkTargets(screens);
  screens.forEach((s, from) => {
    for (const l of s.links) {
      const own = blocking(l.guards, l.file);
      const uses = (l.inheritedGuards ?? []).map((h) => blocking(h.guards, l.file, h.via));
      const guards = own.length || (uses.length && uses.every((u) => u.length)) ? [...own, ...uses.flat()] : [];
      for (const to of targetsOf(l.to)) {
        if (to === from) continue;
        const link = { from, to, file: l.file, line: l.line, guards };
        incoming[to].push(link);
        outgoing[from].push(link);
      }
    }
  });

  const indices = screens.map((_, i) => i);
  const reasons = screens.map(() => []);
  for (const r of redirects) {
    if (blocking(r.guards, config.routesFile).length) continue;
    for (const i of targetsOf(r.to)) reasons[i].push({ kind: 'redirect', file: config.routesFile, line: r.line });
  }
  for (const i of indices) if (incoming[i].length === 0) reasons[i].push({ kind: 'no-incoming-link' });
  const unknownEntryPaths = [];
  for (const p of config.entryPaths) {
    const found = targetsOf(p);
    if (!found.length) unknownEntryPaths.push(p);
    for (const i of found) reasons[i].push({ kind: 'config' });
  }
  const starts = indices.filter((i) => reasons[i].length);

  const walk = (starts, passable) => {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length) {
      for (const l of outgoing[queue.shift()]) {
        if (seen.has(l.to) || !passable(l)) continue;
        seen.add(l.to);
        queue.push(l.to);
      }
    }
    return seen;
  };
  const reachable = walk(starts, () => true);
  const openWay = (l) => l.guards.length === 0 && route[l.to].length === 0;
  // 어느 출발 화면에서도 갈 수 없는 화면은 접근을 막는 조건을 알 수 없으므로 접근 제한이 없는 화면으로 본다.
  const open = walk(
    indices.filter((i) => route[i].length === 0 && (starts.includes(i) || !reachable.has(i))),
    openWay,
  );
  const restricted = indices.map((i) => !open.has(i));

  const routeKinds = screens.map((_, i) => new Set(route[i].flatMap((g) => g.kinds)));
  const kinds = routeKinds.map((own) => new Set(own));
  const started = new Set(starts);
  const onlyBlockedLinks = (i) => !started.has(i) && incoming[i].length > 0 && incoming[i].every((l) => l.guards.length > 0 || restricted[l.from]);
  const linkKinds = (l) => [...l.guards.flatMap((g) => g.kinds), ...(restricted[l.from] ? kinds[l.from] : [])];
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of indices) {
      if (!restricted[i] || !onlyBlockedLinks(i)) continue;
      for (const k of incoming[i].flatMap(linkKinds)) {
        if (kinds[i].has(k)) continue;
        kinds[i].add(k);
        changed = true;
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of indices) {
      if (!restricted[i] || !onlyBlockedLinks(i)) continue;
      const every = intersect(incoming[i].map((l) => new Set(linkKinds(l))));
      for (const k of kinds[i]) {
        if (routeKinds[i].has(k) || every.has(k)) continue;
        kinds[i].delete(k);
        changed = true;
      }
    }
  }

  const roleGuards = (guards) => guards.filter((g) => g.kinds.includes('role'));
  const readSets = (guards) => roleGuards(guards).filter((g) => g.roles).map((g) => new Set(g.roles));
  const values = screens.map(() => null);
  // 역할을 묻지 않는 링크는 undefined, 읽지 못한 링크는 null 이다.
  const linkValues = (l) => {
    if (roleGuards(l.guards).length) {
      const sets = readSets(l.guards);
      return sets.length ? intersect(sets) : null;
    }
    return restricted[l.from] && kinds[l.from].has('role') ? values[l.from] && new Set(values[l.from]) : undefined;
  };
  const valuesOf = (i) => {
    const sets = readSets(route[i]);
    const ways = onlyBlockedLinks(i) ? incoming[i].map(linkValues) : [undefined];
    if (ways.every(Boolean)) sets.push(new Set(ways.flatMap((w) => [...w])));
    const both = sets.length ? intersect(sets) : new Set();
    return both.size ? [...both].sort() : null;
  };
  settle(indices.filter((i) => restricted[i] && kinds[i].has('role')), values, valuesOf);
  const roleAccess = (i) => {
    if (!restricted[i] || !kinds[i].has('role')) return {};
    const guards = [...route[i], ...(onlyBlockedLinks(i) ? incoming[i].flatMap((l) => l.guards) : [])];
    const unreadable = roleGuards(guards).filter((g) => !g.roles).map((g) => g.guard);
    return { roleValues: values[i], unreadableRoleGuards: [...new Set(unreadable)].sort() };
  };

  const required = screens.map(() => null);
  // 출발 화면의 값을 아직 모르면 null 이다.
  const linkSettings = (l) => {
    const own = settingParts(l.guards);
    if (own.guarded || !restricted[l.from] || !kinds[l.from].has('setting')) return own;
    return required[l.from] && { guarded: false, inherited: true, ...required[l.from] };
  };
  // 들어오는 길의 값을 하나도 모르면 null 로 두어, 서로 링크를 건 화면끼리 빈 값을 주고받지 않게 한다.
  // 읽지 못한 조건은 모든 길에 있을 때만 남긴다. 읽을 수 있는 길로 들어갈 수 있기 때문이다.
  const requiredOf = (i) => {
    const own = settingParts(route[i]);
    if (!onlyBlockedLinks(i)) return { needs: own.needs, unreadable: own.unreadable };
    const ways = incoming[i].map(linkSettings).filter(Boolean);
    if (!ways.length) return null;
    const common = intersect(ways.map((w) => new Set(w.needs.map((n) => JSON.stringify(n)))));
    return {
      needs: distinct([...own.needs, ...ways[0].needs.filter((n) => common.has(JSON.stringify(n)))]),
      unreadable: distinct([...own.unreadable, ...(ways.every((w) => w.unreadable.length) ? ways.flatMap((w) => w.unreadable) : [])]),
    };
  };
  settle(indices.filter((i) => restricted[i] && kinds[i].has('setting')), required, requiredOf);

  const byPlace = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  const shownKinds = indices.map((i) => (restricted[i] ? [...kinds[i]].sort() : []));
  const access = screens.map((_, i) => {
    const ways = incoming[i]
      .map((l) => ({ link: l, row: { from: screens[l.from].id, file: l.file, line: l.line, guards: l.guards, fromKinds: shownKinds[l.from] } }))
      .sort((a, b) => byPlace(a.row, b.row));
    const links = ways.map((w) => w.row);
    const settings = shownKinds[i].includes('setting')
      ? { settings: settingSources(route[i], onlyBlockedLinks(i) ? ways.map((w) => ({ ...w.row, settings: linkSettings(w.link) ?? settingParts(w.link.guards) })) : []) }
      : {};
    return { restricted: restricted[i], kinds: shownKinds[i], route: route[i], links, ...roleAccess(i), ...settings };
  });
  const entries = starts.map((i) => ({ screen: screens[i].id, reasons: reasons[i] }));
  return { access, entries, unknownEntryPaths };
}
