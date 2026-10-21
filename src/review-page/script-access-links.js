function callDetails(call, s) {
  const { option: picked, depth } = state.target;
  const tests = (picked ? hasOption(testsOf(call.id), picked.key, picked.value) : testsOf(call.id)).filter((t) => !depth || t.depth === depth);
  const sites = s.apiCalls.filter((c) => (c.endpoints ?? []).some((e) => e.callId === call.id));
  const option = picked && call.options.find((o) => o.key === picked.key);
  return [
    option ? h('h2', {}, '옵션을 찾은 자리') : null,
    option ? h('ul', { class: 'plain option-sites' },
      option.sites.map((site) => h('li', {}, h('code', {}, `${site.file}:${site.line}`), ' ', h('span', { class: 'muted mono' }, site.screen))),
      option.sources.includes('type') ? h('li', {}, '본문 타입에서 읽음 ', h('span', { class: 'muted mono' }, call.apiFunctions.join(', '))) : null,
      option.sources.includes('config') ? h('li', {}, '설정에 적음 ', h('span', { class: 'muted mono' }, 'bodyOptions')) : null) : null,
    h('h2', {}, '서버 대조', listAbsentNote('목록 없음')),
    h('div', {}, verdictChip(call.server), ' ', call.server.path ? h('code', {}, call.server.path) : null),
    call.server.candidates ? h('ul', { class: 'plain' }, call.server.candidates.map((c) => h('li', {}, '서버에는 ', h('code', {}, c)))) : null,
    h('h2', {}, `테스트 ${tests.length}`),
    tests.length ? h('div', {}, tests.map((t) => partRow(testItem(t, { hide: [`call:${call.id}`, ...(depth ? [`depth:${depth}`] : [])] }), call.id, t))) : h('p', { class: 'muted' }, '없음'),
    ...untaggedPairs(call.id),
    h('h2', {}, '이 화면에서 부르는 곳'),
    h('ul', { class: 'plain' }, sites.map((c) => h('li', {}, h('code', {}, c.fn), ' ', h('span', { class: 'muted mono' }, `${c.file}:${c.line}`)))),
    h('h2', {}, `이 호출을 쓰는 화면 ${call.screens.length}`),
    h('ul', { class: 'plain' }, call.screens.map((id) => h('li', {}, h('code', {}, id)))),
  ];
}

const kindChip = (k) => h('span', { class: `chip kind-${k}` }, KIND_LABEL[k]);
const mixedChip = () => h('span', { class: 'chip kind-mixed' }, MIXED_KINDS);
const isRestricted = (id) => Boolean(state.data.map.screens.find((x) => x.id === id)?.access.restricted);
const LONG_GUARD = 80;
const rememberOpen = (set, key) => (e) => { if (e.currentTarget.open) set.add(key); else set.delete(key); };
const guardCode = (text, scope = null, opened = state.openLong) => {
  if (text.length <= LONG_GUARD) return h('code', {}, text);
  const key = `${scope}\n${text}`;
  const kept = scope === null ? {} : { open: opened.has(key), ontoggle: rememberOpen(opened, key) };
  return h('details', { class: 'long-guard', ...kept },
    h('summary', {}, h('code', { class: 'head' }, `${text.slice(0, LONG_GUARD)}…`)), h('code', { class: 'full' }, text));
};
const accessGuard = (g, scope, opened = state.openLong) => h('div', { class: 'guard' },
  guardCode(g.via ? inheritedText(g.guard, g.via) : g.guard, scope, opened), ' ', g.kinds.map(kindChip));

// 맵에 링크가 어떤 순서로 적혀 있든 같은 순서로 나온다.
// 같은 조건식도 파일마다 뜻이 다를 수 있어 묶는 기준에는 조건식이 풀린 결과를 함께 넣는다.
function linkGroups(links) {
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const meaning = (g) => JSON.stringify([g.guard, g.kinds, g.roles ?? null, g.settings ?? null, g.settingsReason ?? null]);
  const groups = new Map();
  for (const l of links) {
    const guards = [...new Map(l.guards.map((g) => [g.guard, g])).values()].sort((a, b) => byText(a.guard, b.guard));
    const key = guards.map(meaning).join('\n');
    if (!groups.has(key)) groups.set(key, { key, text: guards.map((g) => g.guard).join('\n'), guards, links: [] });
    groups.get(key).links.push(l);
  }
  for (const g of groups.values()) g.links.sort((a, b) => byText(a.from, b.from) || byText(a.file, b.file) || a.line - b.line);
  return [...groups.values()].sort((a, b) => Number(b.guards.length === 0) - Number(a.guards.length === 0) || b.links.length - a.links.length || byText(a.text, b.text) || byText(a.key, b.key));
}

function linkHead(l) {
  const head = h('span', { class: 'slot-text' }, h('code', { class: 'from' }, l.from), ' ', h('span', { class: 'muted mono' }, `${l.file}:${l.line}`));
  const target = l.part && linkTarget(state.selected, l.part);
  return target ? slotRow(head, target, SLOT_WORDS.link) : head;
}

function linkGroup({ key, guards, links }) {
  const { lines, bare } = openNeeds({ access: linkAccess(guards) });
  const words = [...lines.map((l) => (l.flag ? `${l.text} (${l.flag})` : l.text)), bare].filter(Boolean);
  return h('details', { class: 'link-group', open: state.openGroups.has(key), ontoggle: rememberOpen(state.openGroups, key) },
    h('summary', {}, h('span', { class: 'cond' }, guards.length ? words.join(' · ') : '조건 없음'), ' ', h('span', { class: 'count muted' }, `링크 ${links.length}`)),
    h('ul', { class: 'plain' }, links.map((l) => h('li', {},
      linkHead(l),
      l.guards.map((g) => accessGuard(g, `${key}\n${l.from} ${l.file}:${l.line}`)),
      l.fromKinds.length || isRestricted(l.from)
        ? h('div', { class: 'from-kinds muted' }, '링크를 건 화면에 필요한 것 ', l.fromKinds.length ? l.fromKinds.map(kindChip) : mixedChip())
        : null))));
}

const settingCaseName = (tag) => tag.slice('setting:'.length, tag.lastIndexOf('='));
const CASE_LABEL = {
  role: (c) => (c.opens ? `역할 ${c.tag.slice('role:'.length)} — 열림` : '여는 역할이 아닌 역할 — 막힘'),
  setting: (c) => `설정 ${settingCaseName(c.tag)} ${c.opens ? '맞춤 — 열림' : '맞추지 않음 — 막힘'}`,
  case: (c) => state.data.caseKinds[c.tag.slice('case:'.length)].text,
};
const caseValues = (c) => (c.kind === 'case' ? state.data.caseKinds[c.tag.slice('case:'.length)].values : []);
/** @param {import('../config.ts').CasePick} pick */
const pickText = ({ screen, methods, api }) => [screen && `화면 경로 ${screen}`, methods && `메서드 ${methods.join(' · ')}`, api && `요청 주소 ${api}`].filter(Boolean).join(' · ');
const ruleText = (kind, index, pick = state.data.caseKinds[kind].picks[index]) => `${pickText(pick)} (설정 caseKinds.${kind}.picks ${index + 1}번째 줄)`;
const rulesText = (kind, indices) => indices.map((i) => ruleText(kind, i)).join('\n');
const nowRules = (kind) => (state.data.caseKinds[kind].picks.length ? `지금 규칙: ${rulesText(kind, state.data.caseKinds[kind].picks.map((_, i) => i))}` : '지금 규칙 없음');
const targetWord = (id) => (nodeWord(id) === '호출' ? '요청' : '화면');

function pickedBy(kind, id) {
  const kindTargets = state.data.caseTargets[kind];
  const unused = kindTargets?.unused[id];
  if (unused) return { state: 'unused', rules: [], mark: unused };
  return kindTargets?.nodes[id] ?? { state: 'undecided', rules: [], mark: null };
}

const takenOut = (by) => by.state === 'not-needed' || by.state === 'unused';

function outTitle(kind, by) {
  const { mark } = by;
  if (by.state === 'unused') return `${fmtDate(mark.date)} 에 규칙에서 뺐습니다\n${nowRules(kind)}`;
  if (!mark.rule) return `${fmtDate(mark.date)} 에 대상 아님으로 정했습니다`;
  return `${fmtDate(mark.date)} 에 규칙에서 뺐습니다\n${ruleText(kind, mark.rule.index, mark.rule.pick)}`;
}

function pickChip(kind, by) {
  const { mark } = by;
  if (by.state === 'rule') return h('span', { class: 'chip pick-rule', title: `규칙이 골랐습니다: ${rulesText(kind, by.rules)}` }, '규칙');
  if (by.state === 'needed') return h('span', { class: 'chip pick-person', title: `${fmtDate(mark.date)} 에 골랐습니다${by.rules.length ? `\n규칙도 골랐습니다: ${rulesText(kind, by.rules)}` : ''}` }, mark.author);
  if (!takenOut(by)) return null;
  return h('span', { class: `chip ${by.state === 'unused' ? 'pick-unused' : 'pick-out'}`, title: outTitle(kind, by) }, `대상 아님 · ${mark.author}`);
}

function askTakeOut(id, kind, refocus) {
  const word = targetWord(id);
  askReason({
    verb: '빼기',
    reasonLabel: '규칙에서 빼는 이유',
    describe: () => ({
      title: `이 ${word}을 규칙에서 뺍니다`,
      subject: [
        h('span', { class: 'label' }, '경우 종류'),
        h('div', {}, state.data.caseKinds[kind].text, ' ', h('span', { class: 'muted mono' }, `case:${kind}`)),
        h('span', { class: 'label' }, word),
        h('div', {}, callOf(id) ? h('span', { class: 'mono' }, id) : [screenLabel(id), ' ', h('span', { class: 'muted' }, screenOf(id)?.component)]),
        h('span', { class: 'label' }, '규칙'),
        h('div', { class: 'muted' }, rulesText(kind, pickedBy(kind, id).rules)),
      ],
      confirm: '빼기',
    }),
    save: (reason) => takeOut({ node: id, case: kind }, reason),
    done: render,
    refocus: () => /** @type {HTMLElement} */ (document.querySelector(refocus))?.focus(),
  });
}

async function takeOut(target, note) {
  let error = null;
  state.caseError = null;
  await trackOwnSave(async () => {
    let id;
    try {
      id = await postPick(target, 'not-needed', note);
    } catch (err) {
      error = `저장하지 못했습니다: ${err.message}`;
      return null;
    }
    try {
      await load();
    } catch (err) {
      state.caseError = { node: target.node, message: `「${targetName(target)}」 코멘트는 저장했지만 다시 읽지 못했습니다: ${err.message}` };
    }
    return id;
  });
  return error;
}

function caseSection(node) {
  const kinds = Object.entries(state.data.caseKinds);
  if (!node.cases.length && !kinds.length) return null;
  const tests = testsOf(node.id);
  const testsWith = (tag) => tests.filter((t) => t.cases?.includes(tag));
  const word = targetWord(node.id);
  const by = Object.fromEntries(kinds.map(([kind]) => [kind, pickedBy(kind, node.id)]));
  const busy = state.caseSaving || state.bulkBusy;
  const scope = `#center .${callOf(node.id) ? 'call-info' : 'screen-info'} > .cases`;
  const head = (label, kind) => {
    const chip = kind ? pickChip(kind, by[kind]) : null;
    return h('div', { class: 'case-head' }, h('div', { class: 'case' }, label), chip);
  };
  const takeOutButton = (kind) => h('button', {
    type: 'button',
    class: 'take-out',
    'data-kind': kind,
    title: `이유를 적고, 이 ${word}에는 이 경우를 시험하지 않아도 된다고 표시합니다`,
    disabled: busy,
    onclick: () => askTakeOut(node.id, kind, `${scope} .take-out[data-kind="${kind}"]`),
  }, `이 ${word}은 규칙에서 빼기…`);
  const caseRow = (c) => {
    const kind = c.kind === 'case' ? c.tag.slice('case:'.length) : null;
    const values = caseValues(c);
    return h('li', { title: values.length ? null : `@${c.tag}` },
      head(CASE_LABEL[c.kind](c), kind),
      kind && by[kind].rules.length ? takeOutButton(kind) : null,
      values.length
        ? h('ul', { class: 'plain case-values' }, values.map((v) => h('li', { title: `@${c.tag}=${v}` },
          h('code', { class: 'case-value' }, v),
          depthCounts(testsWith(`${c.tag}=${v}`), '테스트 없음'))))
        : depthCounts(testsWith(c.tag), '테스트 없음'));
  };
  const leftOutRow = (kind, text) => h('li', { class: `case-left-out ${by[kind].state}` },
    head(text, kind),
    h('p', { class: 'case-reason' }, '이유 ', h('span', { class: 'memo' }, by[kind].mark.note)),
    by[kind].state === 'unused' ? h('p', { class: 'case-unused' }, `규칙이 이 ${word}을 더는 고르지 않아, 이 표시는 쓰이지 않습니다`) : null);
  const decideButton = (kind, yes) => {
    const tip = yes ? `대상 — 이 ${word}에서 이 경우를 시험합니다` : `대상 아님… — 이유를 적고 이 ${word}에서는 시험하지 않습니다`;
    return h('button', {
      type: 'button',
      class: `decide ${yes ? 'yes' : 'no'}`,
      title: tip,
      'aria-label': tip,
      disabled: busy,
      onclick: () => (yes ? pickCase({ node: node.id, case: kind }, 'needed') : askNotTarget(node.id, kind, `${scope} .case-undecided-row[data-kind="${kind}"] button.no`)),
    }, yes ? '✓' : '✕');
  };
  const undecidedRow = (kind, text) => {
    const held = markOf({ node: node.id, case: kind })?.current;
    return h('li', { class: 'case-undecided-row', 'data-kind': kind },
      h('span', { class: 'kind-text' }, text), h('span', { class: 'chip undecided' }, '미판정'), held ? null : h('span', { class: 'muted' }, '아직 아무도 정하지 않았습니다'),
      decideButton(kind, true), decideButton(kind, false),
      held ? h('div', { class: 'case-held-lines' }, heldText(held)) : null);
  };
  const undecidedHere = (kind) => kindTargetsOf(kind)?.nodes[node.id]?.state === 'undecided';
  const picked = new Map(node.cases.filter((c) => c.kind === 'case').map((c) => [c.tag.slice('case:'.length), c]));
  const rows = [
    ...node.cases.filter((c) => c.kind !== 'case').map(caseRow),
    ...kinds.map(([kind, { text }]) => (picked.has(kind) ? caseRow(picked.get(kind)) : takenOut(by[kind]) && !undecidedHere(kind) ? leftOutRow(kind, text) : null)).filter(Boolean),
    ...kinds.filter(([kind]) => undecidedHere(kind)).map(([kind, { text }]) => undecidedRow(kind, text)),
  ];
  return h('div', { class: 'cases' },
    h('h2', {}, '경우별 테스트'),
    rows.length ? h('ul', { class: 'plain' }, rows) : null,
    kinds.length ? [
      h('p', { class: 'muted' }, `이 ${nodeWord(node.id)}에서 시험할 경우 종류`),
      h('div', { class: 'case-kinds' }, kinds.map(([kind, { text, values }]) => {
        const on = picked.has(kind);
        const ruled = on && by[kind].rules.length > 0;
        const tag = values.length ? values.map((v) => `@case:${kind}=${v}`).join('\n') : `@case:${kind}`;
        return h('button', {
          type: 'button',
          class: on ? 'on' : '',
          'data-kind': kind,
          'aria-pressed': String(on),
          title: ruled ? `${tag}\n누르면 이유를 적고 규칙에서 뺍니다` : tag,
          disabled: busy,
          onclick: () => (ruled ? askTakeOut(node.id, kind, `${scope} .case-kinds button[data-kind="${kind}"]`) : pickCase({ node: node.id, case: kind }, on ? 'not-needed' : 'needed')),
        }, text);
      })),
      state.caseError?.node === node.id ? h('p', { class: 'error' }, state.caseError.message) : null,
    ] : null);
}

async function pickCase(target, status) {
  if (state.caseSaving || state.bulkBusy) return;
  return trackOwnSave(() => savePick(target, status));
}

async function postPick(target, status, note = undefined) {
  const res = await fetch('/api/marks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, status, note }) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).id;
}

async function savePick(target, status) {
  state.error = null;
  state.caseError = null;
  state.caseSaving = true;
  renderCenter();
  let id;
  try {
    id = await postPick(target, status);
  } catch (err) {
    state.caseSaving = false;
    state.caseError = { node: target.node, message: `「${targetName(target)}」 코멘트를 저장하지 못했습니다: ${err.message}` };
    if (!state.ended) renderCenter();
    return null;
  }
  try {
    await load();
  } catch (err) {
    state.caseError = { node: target.node, message: `「${targetName(target)}」 코멘트는 저장했지만 다시 읽지 못했습니다: ${err.message}` };
  }
  state.caseSaving = false;
  render();
  return id;
}

function openSummary(s) {
  const { lines, tips, bare } = openNeeds(s, { bySlot: true });
  return h('div', { class: 'open-needs' },
    h('h2', {}, '접근 조건'),
    s.access.restricted ? [...lines.map(needLine), bare ? bareLine(bare) : null] : h('p', { class: 'muted' }, '설정이나 역할 없이 열립니다.'),
    tips.length ? h('ul', { class: 'plain tips muted' }, tips.map((t) => h('li', {}, typeof t === 'string' ? t
      : slotRow(h('span', { class: 'slot-text' }, t.text), conditionTarget(s.id, t.slot), SLOT_WORDS.condition)))) : null,
    s.access.route.length ? h('div', { class: 'route' }, h('h3', {}, '라우트에서 막는 조건'), s.access.route.map((g) => accessGuard(g, 'route'))) : null);
}

const inScreenGuards = ({ routeGuards, access }) => {
  const blocking = new Set(access.route.map((g) => g.guard));
  return routeGuards.filter((g) => !blocking.has(g));
};

const movedChip = () => h('span', { class: 'chip l-configured', title: LINK_VERDICT_TITLE.configured }, LINK_VERDICT.configured);
const movesOf = (side, id) => (state.data.map.moves ?? []).filter((m) => m[side] === id);
const moveItem = (end, m) => h('li', { class: 'move' }, end, ' ', movedChip(), ' ', h('span', { class: 'muted' }, m.reason));

function accessDetails(s) {
  const { links } = s.access;
  const moves = movesOf('to', s.id);
  const inScreen = inScreenGuards(s);
  return h('div', { class: 'access' },
    h('h2', {}, `들어오는 링크 ${links.length + moves.length}`),
    links.length ? linkGroups(links).map(linkGroup) : null,
    moves.length ? h('ul', { class: 'plain moves' }, moves.map((m) => moveItem(h('code', { class: 'from' }, m.from), m))) : null,
    links.length + moves.length ? null : h('p', { class: 'muted' }, '없음'),
    inScreen.length ? h('div', { class: 'in-screen' },
      h('h2', {}, '화면 안 조건 — 화면을 여는 것은 막지 않습니다'),
      inScreen.map((g) => h('div', { class: 'guard' }, guardCode(g, 'in-screen')))) : null);
}

function screenDetails(s) {
  const moves = movesOf('from', s.id);
  return [
    accessDetails(s),
    h('h2', {}, '소스 위치'),
    h('ul', { class: 'plain' },
      h('li', {}, '라우트 ', h('code', {}, `${s.routeFile}:${s.line}`)),
      h('li', {}, '컴포넌트 ', s.componentFile ? h('code', {}, s.componentFile) : h('span', { class: 'muted' }, '찾지 못함'))),
    h('h2', {}, `나가는 링크 ${s.links.length + moves.length}`),
    s.links.length + moves.length ? h('ul', { class: 'plain' },
      s.links.map((l) => h('li', {},
        h('code', {}, l.to), ' ', h('span', { class: 'muted mono' }, `${l.file}:${l.line}`), h('div', {}, guardList(l)))),
      moves.map((m) => moveItem(h('code', {}, m.to), m))) : h('p', { class: 'muted' }, '없음'),
    h('h2', {}, `읽는 설정값 ${s.settingReads.length}`),
    s.settingReads.length ? h('ul', { class: 'plain' }, s.settingReads.map((r) => h('li', {},
      h('code', {}, r.key), ' ', h('span', { class: 'muted mono' }, `${r.file}:${r.line}`)))) : h('p', { class: 'muted' }, '없음'),
  ];
}

