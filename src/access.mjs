import { UNKNOWN } from './client.mjs';
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

function guardKinds(config, guardInits) {
  const alt = (names) => names.map(escapeRegExp).join('|');
  const rules = [];
  const roles = config.roleIdentifiers ?? [];
  if (roles.length) rules.push(['role', new RegExp(`(?<![\\w$])(?:${roles.map(rolePattern).join('|')})(?![\\w$])`)]);
  const settings = config.settingsRoots ?? [];
  if (settings.length) rules.push(['setting', new RegExp(`(?<![\\w$])(?:${alt(settings)})\\s*\\??\\.`)]);
  return (guard, file) => {
    const texts = [guard, ...(guardInits.get(file)?.get(guard) ?? [])];
    return rules.filter(([, re]) => texts.some((t) => re.test(t))).map(([kind]) => kind);
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

export function screenAccess(screens, redirects, config, guardInits) {
  const kindsOf = guardKinds(config, guardInits);
  const blocking = (guards, file, via) =>
    guards.flatMap((guard) => {
      const kinds = kindsOf(guard, file);
      return kinds.length ? [{ guard, kinds, ...(via ? { via } : {}) }] : [];
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

  const kinds = screens.map((_, i) => new Set(route[i].flatMap((g) => g.kinds)));
  const allLinksBlocked = (i) => incoming[i].length > 0 && incoming[i].every((l) => l.guards.length > 0 || restricted[l.from]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of indices) {
      if (!restricted[i] || !allLinksBlocked(i)) continue;
      for (const l of incoming[i]) {
        for (const k of [...l.guards.flatMap((g) => g.kinds), ...(restricted[l.from] ? kinds[l.from] : [])]) {
          if (kinds[i].has(k)) continue;
          kinds[i].add(k);
          changed = true;
        }
      }
    }
  }

  const byPlace = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  const shownKinds = indices.map((i) => (restricted[i] ? [...kinds[i]].sort() : []));
  const access = screens.map((_, i) => ({
    restricted: restricted[i],
    kinds: shownKinds[i],
    route: route[i],
    links: incoming[i]
      .map((l) => ({ from: screens[l.from].id, file: l.file, line: l.line, guards: l.guards, fromKinds: shownKinds[l.from] }))
      .sort(byPlace),
  }));
  const entries = starts.map((i) => ({ screen: screens[i].id, reasons: reasons[i] }));
  return { access, entries, unknownEntryPaths };
}
