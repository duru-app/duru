import { lookupConstant, memberChain, UNKNOWN, VARIABLE_SEGMENT } from './client.mjs';
import { parseRoleEntry } from './config.mjs';
import { parseFragment, plainText } from './parse.ts';
import { pathParts } from './path-values.mjs';

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
  const plain = new Map();
  const plainOf = (text, file) => {
    const key = `${file}\n${text}`;
    if (!plain.has(key)) plain.set(key, plainText(text, file));
    return plain.get(key);
  };
  return (guard, file) => {
    const entry = guardInits.get(file)?.get(guard);
    const texts = [entry?.source ?? guard, ...(entry?.inits ?? []).map((i) => i.init)].map((t) => plainOf(t, file));
    const kinds = rules.filter(([, re]) => texts.some((t) => re.test(t))).map(([kind]) => kind);
    return entry?.readsSettingsResult && !kinds.includes('setting') ? [...kinds, 'setting'] : kinds;
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
  const parseIn = (file, text) => {
    const key = JSON.stringify([file, text]);
    if (!parsed.has(key)) {
      try {
        parsed.set(key, parseFragment(text, file));
      } catch {
        parsed.set(key, null);
      }
    }
    return parsed.get(key);
  };

  return (guard, file) => {
    const parse = (text) => parseIn(file, text);
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

export const unreadableTarget = (to) => typeof to !== 'string' || to.includes(UNKNOWN);

const compiles = (pattern) => {
  try {
    return Boolean(new RegExp(pattern));
  } catch {
    return false;
  }
};

// path-to-regexp 1.x 가 만드는 정규식을 따르되, 대소문자는 구분하지 않고 주소의 {*} 는 어떤 변수 자리와도 맞게 한다.
function fittingPattern(parts) {
  const source = parts
    .map((part) => {
      if (typeof part === 'string') return escapeRegExp(part);
      const prefix = escapeRegExp(part.prefix);
      const anyValue = `[^${escapeRegExp(part.prefix || '/')}]+?`;
      let capture = `(?:(?:${part.pattern && compiles(part.pattern) ? part.pattern : anyValue})|${escapeRegExp(VARIABLE_SEGMENT)})`;
      if (part.repeat) capture += `(?:${prefix}${capture})*`;
      return part.optional ? `(?:${prefix}${capture})?` : prefix + capture;
    })
    .join('');
  return new RegExp(`^${source}/?$`, 'i');
}

export function linkTargets(screens) {
  const indices = screens.map((_, i) => i);
  const routes = screens.map((s) => {
    const parts = pathParts(s.path.replace(/\/$/, ''));
    return { pattern: fittingPattern(parts), head: typeof parts[0] === 'string' ? parts[0].toLowerCase() : '' };
  });
  const samePath = (to) => indices.filter((i) => screens[i].path === to);
  const addingParameters = (to) => {
    const prefix = to.replace(/\/$/, '') + '/';
    return indices.filter((i) => {
      const p = screens[i].path;
      return p.startsWith(prefix) && p.slice(prefix.length).split('/').every((seg) => seg.startsWith(':'));
    });
  };
  // 상수 경로로 시작하는 라우트만 맞춰 본다. 그러지 않으면 '*' 나 '/:section/:id' 같은 라우트가 상수 뒤에 주소를 이어 붙인 링크를 모두 가져간다.
  const fittingRoutes = (to, bare) => {
    const under = bare.replace(/\/$/, '').toLowerCase();
    return indices.filter((i) => (routes[i].head === under || routes[i].head.startsWith(`${under}/`)) && routes[i].pattern.test(to));
  };
  // 짐작으로 찾는 단계(guess)가 링크가 있는 화면(from) 하나만 찾으면 다음 단계로 넘어간다.
  const firstFound = (from, steps) => {
    let first = [];
    for (const { find, guess } of steps) {
      const found = find();
      if (found.length && !(guess && found.every((i) => i === from))) return found;
      if (!first.length) first = found;
    }
    return first;
  };
  const exactly = (find) => ({ find, guess: false });
  const guessing = (find) => ({ find, guess: true });
  return (to, tail, from) => {
    if (unreadableTarget(to)) return [];
    if (!tail) return firstFound(from, [exactly(() => samePath(to)), guessing(() => addingParameters(to))]);
    const bare = to.slice(0, -tail.length);
    return firstFound(from, [
      exactly(() => samePath(to)),
      exactly(() => fittingRoutes(to, bare)),
      guessing(() => addingParameters(to)),
      guessing(() => samePath(bare)),
      guessing(() => addingParameters(bare)),
    ]);
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
  const readRoles = roleReader(config, guardInits, constants);
  const configured = config.roleGuards ?? {};
  const rolesOf = (guard, file) => (Object.hasOwn(configured, guard) ? [...configured[guard]] : readRoles(guard, file));
  const describe = (guards, file, via) =>
    guards.map((guard) => {
      const kinds = kindsOf(guard, file);
      return { guard, kinds, ...(kinds.includes('role') ? { roles: rolesOf(guard, file) } : {}), ...(via ? { via } : {}), ...(kinds.includes('setting') ? settingsOf(guardSettings, guard, file) : {}) };
    });
  const blocks = (guards) => guards.filter((g) => g.kinds.length);
  const blocking = (guards, file, via) => blocks(describe(guards, file, via));
  // 핸들러에서 물려받은 조건은 그 핸들러를 쓰는 곳이 모두 조건 아래 있을 때만 센다.
  const held = (own, uses) => (own.length || (uses.length && uses.every((u) => u.length)) ? [...own, ...uses.flat()] : []);

  const route = screens.map((s) => blocking(s.routeGuards, s.routeFile));
  const incoming = screens.map(() => []);
  const outgoing = screens.map(() => []);
  const targetsOf = linkTargets(screens);
  const linkConditions = screens.map(() => []);
  screens.forEach((s, from) => {
    for (const l of s.links) {
      const own = describe(l.guards, l.file);
      const uses = (l.inheritedGuards ?? []).map((h) => describe(h.guards, l.file, h.via));
      linkConditions[from].push(held(own, uses));
      const guards = held(blocks(own), uses.map(blocks));
      for (const to of targetsOf(l.to, l.tail, from)) {
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
    if (blocking(r.guards, r.file).length) continue;
    for (const i of targetsOf(r.to)) reasons[i].push({ kind: 'redirect', file: r.file, line: r.line });
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
    const roleOnes = roleGuards(guards);
    const mixed = values[i] === null && roleOnes.every((g) => g.roles) && roleOnes.some((g) => Object.hasOwn(configured, g.guard));
    const unreadable = roleOnes.filter((g) => !g.roles || (mixed && !Object.hasOwn(configured, g.guard))).map((g) => g.guard);
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
  const guarding = [...route.flat(), ...linkConditions.flat(2)];
  const usedRoleGuards = new Set(roleGuards(guarding).map((g) => g.guard));
  const unknownRoleGuards = Object.keys(configured).filter((g) => !usedRoleGuards.has(g)).sort();
  return { access, entries, unknownEntryPaths, unknownRoleGuards, linkConditions };
}

const caseName = (need) => `${need.path.join('.')}${need.need === 'includes' || need.need === 'equals' ? `:${need.value}` : ''}`;
const needKey = (need) => JSON.stringify([need.root, need.path, need.need, need.value]);

// 링크로만 들어오는 화면은 모든 링크에 걸린 조건만 화면을 막는다. 조건이 없는 링크는 settings 에 오르지 않는다.
function requiredNeeds({ settings = [], links }) {
  const route = settings.filter((s) => s.from === 'route').flatMap((s) => s.needs);
  const ways = settings.filter((s) => s.from !== 'route');
  if (!ways.length || ways.length < links.length) return route;
  return [...route, ...ways[0].needs.filter((n) => ways.every((w) => w.needs.some((m) => needKey(m) === needKey(n))))];
}

// 설정 케이스의 =true 는 조건을 맞춘 테스트(열림), =false 는 맞추지 않은 테스트(막힘)다. 설정이 꺼져 있어야 열리는 조건이어도 같다.
export function screenCases(access) {
  if (!access.restricted) return [];
  const cases = [];
  if (access.kinds.includes('role')) {
    for (const role of access.roleValues ?? []) cases.push({ tag: `role:${role}`, kind: 'role', opens: true });
    cases.push({ tag: 'role:other', kind: 'role', opens: false });
  }
  const names = [...new Set(requiredNeeds(access).map(caseName))].sort();
  for (const name of names) cases.push({ tag: `setting:${name}=true`, kind: 'setting', opens: true }, { tag: `setting:${name}=false`, kind: 'setting', opens: false });
  return cases;
}
