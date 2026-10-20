const GAP = 8, COL_GAP = 50, CELL_GAP = 24, GROUP_SPACE = 24, GROUP_HEAD_H = 28;
const STUB = 10, LANE_PAD = 4, LANE_CURVE = 32;
const ZOOM_MIN = 0.3, ZOOM_MAX = 1.5, ZOOM_STEP = 0.1;

function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const c of children) el.append(c instanceof Node ? c : String(c));
  return el;
}

const screensIn = (roots) => roots.flatMap((n) => [n, ...screensIn(n.children)]);

const flowScreens = () => screensIn([...state.data.flow.roots, ...state.data.flow.unreached]);

const NO_TESTS = '테스트 없음';
const statusOf = (c) => (c.fail ? 's-fail' : c.pending ? 's-pending' : c.pass ? 's-pass' : 's-none');
const STATUS_WORD = { 's-pass': TEST_STATUS.pass, 's-fail': TEST_STATUS.fail, 's-pending': TEST_STATUS.pending, 's-none': NO_TESTS };
const countText = (c) => (c.pass + c.fail + c.pending
  ? [c.pass ? h('span', { class: 'ok' }, `✓${c.pass} `) : null, c.fail ? h('span', { class: 'ng' }, `✕${c.fail} `) : null, c.pending ? h('span', { class: 'wait' }, `○${c.pending}`) : null]
  : NO_TESTS);
const guardText = (alternatives) => alternatives.map((alt) => alt.map((g) => g.guard).join(' & ')).join(' 또는 ');

// 전체 경로는 상자의 title 에 있다.
const needText = (n, { short = false } = {}) => {
  const path = (short ? n.path.slice(-2) : n.path).join('.');
  if (n.need === 'includes') return short ? `${quoted(n.value)} (${path} 에)` : `${path} 에 ${quoted(n.value)}`;
  if (n.need === 'equals') return short ? `${quoted(n.value)} (${path})` : `${path} = ${quoted(n.value)}`;
  return `${path} ${{ on: '켬', off: '끔', present: '있음' }[n.need]}`;
};

const withMore = (items) => (items.length > 1 ? `${items[0]} 외 ${items.length - 1}` : items[0]);
const overlap = (lists) => lists.reduce((left, values) => left.filter((v) => values.includes(v)));
const unreadText = (u) => `${u.guard} (${settingReasonText(u.reason)})`;
const unreadRolesTip = (guards) => `읽지 못한 역할 조건: ${guards.join(', ')}`;
const unsettledTip = (text) => `정하지 못한 설정 조건: ${text}`;

// bare 는 문구 한 줄로 적지 못한 종류(「설정 필요」, 「링크마다 다름」)다.
function openNeeds({ access }, { bySlot = false } = {}) {
  const { roleValues, unreadableRoleGuards = [], settings, kinds = [], restricted = false } = access;
  const lines = [];
  const tips = [];
  if (roleValues !== undefined) {
    const unread = unreadableRoleGuards.length ? `미확인 ${unreadableRoleGuards.length}` : null;
    if (roleValues) {
      lines.push({ kind: 'role', text: `역할 ${withMore(roleValues)}`, flag: unread });
      if (bySlot) tips.push(...roleValues.map((r) => ({ text: `필요한 역할: ${r}`, slot: `role:${r}` })));
      else tips.push(`필요한 역할: ${roleValues.join(', ')}`);
    } else {
      lines.push({ kind: 'role', text: '역할 미확인' });
      tips.push('필요한 역할: 미확인');
    }
    if (unread) tips.push(unreadRolesTip(unreadableRoleGuards));
  }
  if (settings) {
    const hasValue = (x) => x.need === 'includes' || x.need === 'equals';
    const needs = [...new Map(settings.flatMap((x) => x.needs).map((x) => [needText(x), x]))]
      .sort(([, a], [, b]) => Number(hasValue(b)) - Number(hasValue(a)));
    const unread = [...new Set(settings.flatMap((x) => x.unreadable).map(unreadText))];
    const flag = unread.length ? `미확인 ${unread.length}` : null;
    if (needs.length || unread.length) lines.push({ kind: 'setting', text: needs.length ? `설정 ${withMore(needs.map(([, x]) => needText(x, { short: true })))}` : '설정 미확인', flag });
    tips.push(...needs.map(([full, x]) => (bySlot && x.condition ? { text: `필요한 설정: ${full}`, slot: x.condition } : `필요한 설정: ${full}`)));
    tips.push(...unread.map(unsettledTip));
  }
  const bareKinds = kinds.filter((k) => !lines.some((l) => l.kind === k));
  const bare = bareKinds.length ? `${bareKinds.map((k) => KIND_LABEL[k]).join('·')} 필요` : !kinds.length && restricted ? MIXED_KINDS : null;
  return { lines, tips, bare };
}

// 한 링크나 라우트의 조건은 모두 맞아야 하므로 역할 값은 겹치는 것만 남는다. 겹치는 값이 없으면 빈 목록이다.
function guardsAccess(guards) {
  const roleGuards = guards.filter((g) => g.kinds.includes('role'));
  const readable = roleGuards.filter((g) => g.roles);
  const settingGuards = guards.filter((g) => g.kinds.includes('setting'));
  return {
    restricted: guards.length > 0,
    kinds: ['setting', 'role'].filter((k) => guards.some((g) => g.kinds.includes(k))),
    ...(roleGuards.length ? { roleValues: readable.length ? overlap(readable.map((g) => g.roles)) : null, unreadableRoleGuards: roleGuards.filter((g) => !g.roles).map((g) => g.guard) } : {}),
    ...(settingGuards.length ? { settings: [{ needs: settingGuards.flatMap((g) => g.settings ?? []), unreadable: settingGuards.filter((g) => !g.settings).map((g) => ({ guard: g.guard, reason: g.settingsReason })) }] } : {}),
  };
}

// 화면 칸은 맵처럼 겹치는 역할이 없는 링크도 「역할 미확인」으로 적는다.
function linkAccess(guards) {
  const access = guardsAccess(guards);
  return access.roleValues?.length === 0 ? { ...access, roleValues: null } : access;
}

// 링크의 조건 목록에는 핸들러를 쓰는 곳마다의 조건(via)이 한데 섞여 와서, 어느 곳의 조건인지 알 수 없다.
// 링크 자신의 조건이 없고 물려받은 조건이 하나뿐일 때만 핸들러를 쓰는 곳이 하나여서 그 조건이 꼭 필요하다. 그 밖의 물려받은 조건은 정할 수 없다.
function heldGuards(guards) {
  const own = guards.filter((g) => !g.via);
  const inherited = guards.filter((g) => g.via);
  return !own.length && inherited.length === 1 ? { sure: inherited, undecided: [] } : { sure: own, undecided: inherited };
}

// roles 는 역할을 묻지 않으면 undefined, 묻지만 값을 하나도 읽지 못했으면 null 이다.
function wayNeeds(guards) {
  const { sure, undecided } = heldGuards(guards);
  const access = guardsAccess(sure);
  const [setting = { needs: [], unreadable: [] }] = access.settings ?? [];
  const roleDoubt = undecided.some((g) => g.kinds.includes('role'));
  return {
    roles: access.roleValues === undefined && roleDoubt ? null : access.roleValues,
    unreadRoles: access.unreadableRoleGuards ?? [],
    roleDoubt,
    settings: setting.needs,
    unsettled: setting.unreadable.map(unreadText),
    undecided,
  };
}

// 같은 줄에서 같은 화면으로 가는 링크가 여럿이면 맵에 적힌 순서대로 짝짓는다.
function wayGuards(r) {
  const rows = screenOf(r.to).access.links.filter((l) => l.from === r.from);
  const taken = new Map();
  return r.ways.map((w) => {
    const place = `${w.file}:${w.line}`;
    const nth = taken.get(place) ?? 0;
    taken.set(place, nth + 1);
    return rows.filter((l) => l.file === w.file && l.line === w.line)[nth]?.guards ?? [];
  });
}

// 사용자의 역할은 하나뿐이라 어느 길이든 허락하면 지나가므로 역할은 길마다 허락하는 값을 합친다.
// 합친 값은 모든 길의 역할을 읽었을 때만 지나는 역할을 빠짐없이 담고(bound), 그중 역할을 다 읽은 길이 허락하는 값만 확실하다.
// 확실하지 않은 값이 모든 길에 걸린 읽지 못한 역할 조건 때문이 아니면 partial 이다.
function wayRoles(ways) {
  if (ways.some((w) => w.roles === undefined)) return { roles: undefined, unreadRoles: [], bound: false, partial: false };
  const read = ways.filter((w) => w.roles);
  const unreadRoles = ways[0].unreadRoles.filter((u) => ways.every((w) => w.unreadRoles.includes(u)));
  const sure = new Set(read.filter((w) => !w.unreadRoles.length && !w.roleDoubt).flatMap((w) => w.roles));
  const bound = read.length === ways.length;
  const exact = bound && read.every((w) => w.roles.every((v) => sure.has(v)));
  const explained = bound && ways.every((w) => !w.roleDoubt && w.unreadRoles.every((u) => unreadRoles.includes(u)));
  return { roles: read.length ? [...new Set(read.flatMap((w) => w.roles))].sort() : null, unreadRoles, bound, partial: read.length > 0 && !exact && !explained };
}

const settingKey = (x) => `${x.root}\n${needText(x)}`;
const roleKey = (roles) => (roles === undefined ? '' : roles === null ? '?' : `=${[...roles].sort().join(',')}`);
const restKey = (n) => [...new Set([...n.settings.map(settingKey), ...n.unsettled])].sort().join('\n');
const commonSettings = (ways) => ({
  settings: ways[0].settings.filter((x) => ways.every((w) => w.settings.some((y) => settingKey(y) === settingKey(x)))),
  unsettled: ways[0].unsettled.filter((u) => ways.every((w) => w.unsettled.includes(u))),
});
const NO_NEEDS = { roles: undefined, unreadRoles: [], bound: false, partial: false, settings: [], unsettled: [], undecided: [], bare: null };

// 링크 단계는 링크 하나만 지나면 되므로 모든 링크가 함께 요구하는 것만 단계의 요구로 남긴다.
// 함께 요구하는 것만으로 지나가는 링크가 없고 설정 요구가 링크마다 다르면 나머지는 「링크마다 다름」이다.
// 정할 수 없는 물려받은 조건이나 읽지 못한 역할 조건이 걸린 링크는 더 요구할 수 있어, 함께 요구하는 것만으로 지나간다는 근거가 되지 못한다.
function waysNeeds(ways) {
  if (ways.some((w) => w.roles === undefined && !restKey(w) && !w.undecided.length)) return NO_NEEDS;
  const common = { ...wayRoles(ways), ...commonSettings(ways), undecided: ways.flatMap((w) => w.undecided) };
  const sameRest = (w) => restKey(w) === restKey(common);
  const exact = ways.every(sameRest)
    || ways.some((w) => sameRest(w) && !w.undecided.length && !w.unreadRoles.length && roleKey(w.roles) === roleKey(common.roles));
  return { ...common, bare: exact ? null : MIXED_KINDS };
}

// 맵은 링크마다의 설정 요구를 들어오는 링크와 같은 순서로 적되, 설정 요구가 없는 링크는 건너뛴다.
// 링크 자신에 설정 조건이 없으면 그 요구는 링크를 건 화면에서 물려받은 것이다.
function inheritedSources(access) {
  const sources = (access.settings ?? []).filter((x) => x.from !== 'route');
  let next = 0;
  return access.links.map((row) => {
    const source = sources[next];
    const own = row.guards.some((g) => g.kinds.includes('setting'));
    if (!source || source.from !== row.from || source.file !== row.file || source.line !== row.line || !(own || source.inherited)) return null;
    next += 1;
    return own ? null : source;
  });
}

// 역할은 맵이 같은 규칙으로 정한 값을 쓴다. 맵은 물려받은 조건을 모두 세므로, 정할 수 없는 물려받은 역할 조건이 있으면 그 값은 지나는 역할을 빠짐없이 담지 못한다.
function startNeeds(r) {
  const { id, access } = screenOf(r.screen);
  const route = wayNeeds(access.route);
  const blocked = !state.data.map.entries.some((e) => e.screen === id) && access.links.length > 0
    && access.links.every((l) => l.guards.length || isRestricted(l.from));
  const inherited = inheritedSources(access);
  const ways = blocked ? access.links.map((row, i) => {
    const way = wayNeeds(row.guards);
    return inherited[i] ? { ...way, settings: inherited[i].needs, unsettled: inherited[i].unreadable.map(unreadText) } : way;
  }) : [];
  const links = ways.length ? commonSettings(ways) : { settings: [], unsettled: [] };
  const undecided = ways.flatMap((w) => w.undecided);
  const roleDoubt = ways.some((w) => w.roleDoubt);
  const settings = [...new Map([...route.settings, ...links.settings].map((x) => [settingKey(x), x])).values()];
  const unsettled = [...new Set([...route.unsettled, ...links.unsettled])];
  const shown = {
    setting: settings.length || unsettled.length || undecided.some((g) => g.kinds.includes('setting')),
    role: access.roleValues !== undefined || roleDoubt,
  };
  const missing = access.kinds.filter((k) => !shown[k]);
  const exact = access.kinds.length && ways.every((w) => restKey(w) === restKey(links));
  return {
    roles: access.roleValues,
    unreadRoles: access.unreadableRoleGuards ?? [],
    bound: Boolean(access.roleValues) && !roleDoubt,
    partial: Boolean(access.roleValues) && roleDoubt,
    settings,
    unsettled,
    undecided,
    bare: !exact ? MIXED_KINDS : missing.length ? `${missing.map((k) => KIND_LABEL[k]).join('·')} 필요` : null,
  };
}

function stepNeeds(r) {
  if (r.kind === 'start') return startNeeds(r);
  return waysNeeds(r.kind === 'route' ? [wayNeeds(r.guards)] : wayGuards(r).map(wayNeeds));
}

// 같음은 느슨한 비교(==)로 읽혔을 수도 있어 종류가 같은 두 값만 어긋난다고 보고, 켬과 거짓인 값의 같음도("0" == 0) 어긋난다고 보지 않는다.
const offClash = (off, x) => off.need === 'off' && (['on', 'present', 'includes'].includes(x.need) || (x.need === 'equals' && Boolean(x.value)));
const settingClash = (a, b) => offClash(a, b) || offClash(b, a)
  || (a.need === 'equals' && b.need === 'equals' && typeof a.value === typeof b.value && a.value !== b.value);

// 지나는 역할을 빠짐없이 담은 단계가 있으면 그 단계들로만 겹치는 값을 구해야, 겹치는 값이 없을 때 지나는 역할이 없다고 말할 수 있다.
function storyNeeds(reach) {
  const steps = reach.map((r) => ({ label: stepLabel(r), ...stepNeeds(r) }));
  const read = steps.filter((s) => s.roles);
  const bound = read.filter((s) => s.bound);
  const roles = (bound.length ? bound : read).map((s) => s.roles);
  const allowed = roles.length ? overlap(roles) : [];
  const unreadRoles = [...new Set(steps.flatMap((s) => s.unreadRoles))];
  const roleNotes = [
    ...steps.filter((s) => s.roles === null && !s.unreadRoles.length).map((s) => `역할 미확인 (${s.label})`),
    ...steps.filter((s) => s.partial).map((s) => `역할 일부만 읽음 (${s.label})`),
  ];
  const settings = [...new Map(steps.flatMap((s) => s.settings).map((x) => [settingKey(x), x])).values()];
  const pathKey = (x) => JSON.stringify([x.root, x.path]);
  const clashing = settings.filter((x) => settings.some((y) => pathKey(x) === pathKey(y) && settingClash(x, y)));
  const handlers = new Map();
  for (const g of steps.flatMap((s) => s.undecided)) handlers.set(g.via, [...new Set([...(handlers.get(g.via) ?? []), g.guard])]);
  return {
    roles: allowed.length || bound.length ? allowed : undefined,
    roleSteps: bound,
    roleFlag: unreadRoles.length + roleNotes.length,
    settings: settings.filter((x) => !clashing.includes(x)),
    clashes: [...new Set(clashing.map(pathKey))].map((key) => clashing.filter((x) => pathKey(x) === key)),
    withRoot: new Set(settings.map((x) => x.root)).size > 1,
    bare: steps.filter((s) => s.bare).map((s) => `${s.label} ${s.bare}`),
    leftOut: [
      ...roleNotes,
      ...(unreadRoles.length ? [unreadRolesTip(unreadRoles)] : []),
      ...[...new Set(steps.flatMap((s) => s.unsettled))].map(unsettledTip),
      ...[...handlers].map(([via, guards]) => `${via} 를 쓰는 곳에 따라 다른 조건: ${guards.join(', ')}`),
    ],
  };
}

const rolesText = (roles) => (roles.length ? `역할 ${roles.join(' 또는 ')}` : '지나는 역할 없음');

function storySummary(reach) {
  const n = storyNeeds(reach);
  const settingText = (x) => (n.withRoot ? `${x.root}.${needText(x)}` : needText(x));
  const lines = [
    n.roles === undefined ? null
      : n.roles.length ? needLine({ text: rolesText(n.roles), flag: n.roleFlag ? `미확인 ${n.roleFlag}` : null })
        : [bareLine('모든 단계를 지나는 역할 없음'), h('ul', { class: 'plain step-roles' }, n.roleSteps.map((s) => h('li', {}, `${s.label}: ${rolesText(s.roles)}`)))],
    ...n.settings.map((x) => needLine({ text: `설정 ${settingText(x)}` })),
    ...n.clashes.map((same) => bareLine(`서로 어긋나는 설정: ${same.map(settingText).join(' / ')}`)),
    ...n.bare.map(bareLine),
  ].flat().filter(Boolean);
  return h('div', { class: 'reach-summary' },
    lines,
    !lines.length && !n.leftOut.length ? h('p', { class: 'muted none' }, '설정이나 역할로 막는 조건 없음') : null,
    n.leftOut.length ? h('div', { class: 'left-out' }, h('div', {}, '요약에 넣지 못한 조건'), h('ul', { class: 'plain' }, n.leftOut.map((t) => h('li', {}, t)))) : null);
}

const needLine = (l) => h('div', { class: 'need' }, h('span', { class: 'text' }, l.text), l.flag ? h('span', { class: 'flag' }, l.flag) : null);
const bareLine = (text) => h('div', { class: 'need bare' }, text);

