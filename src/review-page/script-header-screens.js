function placeStateTip(e) {
  const tip = e.currentTarget.nextElementSibling;
  const origin = tip.offsetParent.getBoundingClientRect().left;
  const width = tip.getBoundingClientRect().width;
  const room = document.documentElement.clientWidth - 16 - width;
  tip.style.left = `${Math.max(16, Math.min(e.currentTarget.getBoundingClientRect().left, room)) - origin}px`;
}

function renderHeader() {
  const { map, tests } = state.data;
  const { screens, tested } = state.data.flow.summary;
  fill(document.getElementById('meta'),
    `화면 ${screens} · 테스트 있는 화면 ${tested} · 맵 ${fmtDate(map.meta.generatedAt)} · 테스트 연결 ${fmtDate(tests.meta.generatedAt)}`,
    map.serverNotCompared ? [
      h('button', { type: 'button', class: 'chip state', 'aria-describedby': 'server-state-tip', onmouseenter: placeStateTip, onfocus: placeStateTip }, '서버 대조 안 함'),
      h('span', { class: 'state-tip', id: 'server-state-tip', role: 'note' }, SERVER_STATE_TIP),
    ] : null);
  const b = state.data.baseline;
  const pill = document.getElementById('baseline');
  pill.hidden = !b;
  fill(pill, b ? [h('span', {}, '비교 기준'), ' ', h('strong', {}, b.label), ' ', h('code', {}, b.file)] : []);
  const author = document.getElementById('author');
  const guessed = state.data.authorSource === 'user';
  author.title = guessed ? '설정의 author 에도 git 의 user.name 에도 이름이 없어, 컴퓨터 사용자 이름으로 코멘트와 판단을 남깁니다' : '';
  fill(author, guessed ? ['작성자 ', h('strong', {}, state.data.author)] : []);
}

const listAbsentNote = (text) => (state.data.map.serverNotCompared ? [' ', h('span', { class: 'list-absent' }, text)] : null);

const activeScreenFilters = () => SCREEN_FILTERS.filter((f) => !(f.needsServerList && state.data.map.serverNotCompared));

const baselineIndexes = new WeakMap();
function baselineIndex() {
  const b = state.data.baseline;
  if (!b) return null;
  if (!baselineIndexes.has(b)) {
    baselineIndexes.set(b, {
      added: new Set(b.screens.added),
      conditions: new Map(b.screens.conditions.map((c) => [c.id, c])),
      screenCalls: new Map(b.screens.calls.map((c) => [c.id, c])),
      newCalls: new Set(b.calls.added),
      server: new Map(b.calls.server.map((c) => [c.id, c])),
    });
  }
  return baselineIndexes.get(b);
}

const screenChanged = (id) => {
  const x = baselineIndex();
  return x.added.has(id) || x.conditions.has(id) || x.screenCalls.has(id);
};

function conditionText(c) {
  if (!c.restricted) return '조건 없음';
  const guards = [...c.route.map((g) => `라우트 ${g.guard}${g.roles ? ` (${g.roles.join(', ')})` : ''}`), ...c.links.map((g) => `링크 ${g}`)];
  return guards.length ? guards.join(' · ') : '링크마다 다른 조건';
}

const callCountText = (c) => [c.added.length ? `+${c.added.length}` : null, c.removed.length ? `−${c.removed.length}` : null].filter(Boolean).join(' ');

function changeChips(id) {
  const x = baselineIndex();
  if (!x) return [];
  const { label } = state.data.baseline;
  const condition = x.conditions.get(id);
  const calls = x.screenCalls.get(id);
  return [
    x.added.has(id) ? newChip(id) : null,
    condition ? h('span', { class: 'chip change-condition', title: `${label}: ${conditionText(condition.before)}\n지금: ${conditionText(condition.after)}` }, '조건 바뀜') : null,
    calls ? h('span', { class: 'chip change-calls', title: `${label} 와 견주어 생긴 호출 ${calls.added.length}개, 없어진 호출 ${calls.removed.length}개` }, `호출 ${callCountText(calls)}`) : null,
  ];
}

function baselineFilterBox() {
  const b = state.data.baseline;
  if (!b) return null;
  const count = state.data.map.screens.filter((s) => screenChanged(s.id)).length;
  return h('div', { class: 'baseline-filter' },
    h('div', { class: 'baseline-head' }, `${b.label} 와 비교`),
    h('label', { title: '새로 생겼거나, 열리는 조건이 바뀌었거나, 부르는 호출이 생기거나 없어진 화면' },
      h('input', { type: 'checkbox', name: 'changed', checked: state.filters.has('changed'), onchange: (e) => {
        if (e.target.checked) state.filters.add('changed'); else state.filters.delete('changed');
        renderLeftList();
      } }), `바뀐 화면만 ${count}`));
}

function removedScreens() {
  const b = state.data.baseline;
  if (!b) return [];
  const { removed } = b.screens;
  return [
    h('h2', {}, `${b.label} 에만 있던 화면 ${removed.length}`),
    removed.length
      ? h('ul', { class: 'plain removed-screens' }, removed.map((x) => h('li', {},
          h('span', { class: 'gone' }, x.path ?? x.id), x.component ? [' ', h('span', { class: 'muted' }, `#${x.component}`)] : null, ' ',
          h('span', { class: 'chip change-removed' }, '없어짐'))))
      : h('p', { class: 'muted' }, '없습니다.'),
    h('p', { class: 'muted baseline-rest' }, `역할 · 설정 조건이 바뀐 화면 ${b.screens.conditions.length} · 서버 대조가 바뀐 호출 ${b.calls.server.length}`),
  ];
}

function baselineBanner(s) {
  const x = baselineIndex();
  if (!x || !screenChanged(s.id)) return null;
  const condition = x.conditions.get(s.id);
  const calls = x.screenCalls.get(s.id);
  const parts = [
    x.added.has(s.id) ? '없던 화면' : null,
    condition ? `열리는 조건 ${conditionText(condition.before)} → ${conditionText(condition.after)}` : null,
    calls ? `호출 ${[calls.added.length ? `${calls.added.length}개 생김` : null, calls.removed.length ? `${calls.removed.length}개 없어짐` : null].filter(Boolean).join(', ')}` : null,
  ];
  return h('div', { class: 'baseline-banner' }, `${state.data.baseline.label} 와 비교: ${parts.filter(Boolean).join(' · ')}`);
}

function callCompareCell(s, id) {
  const x = baselineIndex();
  const server = x.server.get(id);
  const chips = [
    x.newCalls.has(id) || x.screenCalls.get(s.id)?.added.includes(id) ? h('span', { class: 'chip change-new' }, '생김') : null,
    server ? h('span', { class: 'chip change-server' }, `서버 대조 바뀜 (${SERVER_STATUS[server.before] ?? server.before} → ${SERVER_STATUS[server.after] ?? server.after})`) : null,
  ].filter(Boolean);
  return h('td', { class: 'compare' }, chips.length ? chips : h('span', { class: 'muted' }, '—'));
}

function visibleScreens() {
  const q = state.query.trim().toLowerCase();
  const filters = activeScreenFilters();
  const changedOnly = state.data.baseline && state.filters.has('changed');
  return state.data.map.screens.filter((s) => filters.every((f) => !state.filters.has(f.key) || f.keep(s)) && (!changedOnly || screenChanged(s.id)) && (!q || s.id.toLowerCase().includes(q)));
}

const screenFilterBoxes = () => [...activeScreenFilters().map((f) => h('label', { title: f.title }, h('input', { type: 'checkbox', name: f.key, checked: state.filters.has(f.key), onchange: (e) => {
  if (e.target.checked) state.filters.add(f.key); else state.filters.delete(f.key);
  renderLeftList();
} }), f.label)), baselineFilterBox()].filter(Boolean);

function caseKindsTab(side) {
  const [undecided, review] = [undecidedTotal(), reviewTotal()];
  const parts = `미판정 ${undecided} · 검토 중 ${review}`;
  return side('cases', '경우 종류', undecided + review, parts, `경우 종류 ${undecided + review}: ${parts}`);
}

function renderLeft() {
  const { marks, map } = state.data;
  const left = document.getElementById('left');
  if (state.view === 'story') return renderStoryLeft(left);
  const side = (key, name, count, title, label = null) => h('button', { class: state.side === key ? 'on' : '', title, 'aria-label': label, disabled: state.bulkBusy, onclick: () => setSide(key) },
    h('span', { class: 'tab-name' }, name),
    // 화면에는 gap 이 띄우고, 이 빈칸은 탭의 글이 「화면 11」로 읽히게 한다.
    ' ', h('span', { class: 'tab-count' }, count));
  const tabs = h('div', { class: 'views side' },
    side('screens', '화면', map.screens.length),
    side('untagged', '태그 없음', untaggedCount(), '노드 태그도 스토리 태그도 없는 테스트'),
    caseKindList().length ? caseKindsTab(side) : null);
  if (state.side === 'cases') return fill(left, tabs, h('ul', { class: 'screens', id: 'case-kind-list' }, caseKindItems()));
  if (state.side === 'untagged') {
    if (!keptLeftList(left, tabs, 'untagged-list')) {
      fill(left,
        tabs,
        h('div', { class: 'filters' },
          h('input', { type: 'search', placeholder: '테스트 찾기', value: state.untaggedQuery, oninput: (e) => { state.untaggedQuery = e.target.value; renderUntaggedList(); } })),
        h('ul', { class: 'screens', id: 'untagged-list' }));
    }
    return renderUntaggedList();
  }
  const detached = markList('떨어져 나감', 'detached', marks.detached.filter((m) => m.target.story === undefined && m.target.candidate === undefined), (m) => (m.target.part ? `${m.target.node} · ${tagLabel(m.target)}` : m.target.screens !== undefined ? orderLabel({ screens: m.target.screens }) : m.key), h('p', { class: 'muted' }, '맵에서 사라진 노드, 화면 하나가 맵에서 사라진 화면 순서, 설정에서 빠진 경우 종류, 결과에서 사라진 테스트, 화면에서 사라진 접근 조건과 들어오는 링크에 달린 코멘트가 여기 남습니다.'));
  const list = keptLeftList(left, tabs, 'screen-list');
  if (list) {
    const search = left.querySelector(':scope > .filters > input[type=search]');
    while (search.nextSibling) search.nextSibling.remove();
    search.after(...screenFilterBoxes());
    while (list.nextSibling) list.nextSibling.remove();
    list.after(...removedScreens(), ...detached);
    return renderLeftList();
  }
  fill(left,
    tabs,
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: '화면 찾기', value: state.query, oninput: (e) => { state.query = e.target.value; renderLeftList(); } }),
      screenFilterBoxes(),
    ),
    h('ul', { class: 'screens', id: 'screen-list' }),
    removedScreens(),
    detached,
  );
  renderLeftList();
}

function renderStoryLeft(left) {
  if (walkShown()) return renderWalkLeft(left);
  const steps = openSteps();
  if (!state.composing && !steps) return fill(left, storyList());
  const picking = steps ? `steps\n${steps.story}` : 'compose';
  if (left.querySelector(':scope > ul#pick-list')?.dataset.for !== picking) {
    const draft = steps ?? state.compose;
    fill(left,
      h('div', { class: 'compose-head' }, steps ? h('strong', {}, `「${storyOf().name}」에 넣을 화면`) : [h('strong', {}, '새 스토리에 넣을 화면'), h('button', { class: 'leave-compose', title: '쓰던 순서는 그대로 두고 스토리 목록을 봅니다', onclick: leaveCompose }, '스토리 목록')]),
      h('div', { class: 'filters' },
        h('input', { type: 'search', placeholder: '화면 찾기', value: draft.query, oninput: (e) => { draft.query = e.target.value; renderPickList(); } })),
      h('ul', { class: 'screens', id: 'pick-list', 'data-for': picking }));
  }
  renderPickList();
}

function keptLeftList(left, tabs, listId) {
  const list = left.querySelector(`:scope > ul#${listId}`);
  if (list) left.firstElementChild.replaceWith(tabs);
  return list;
}

// 상태가 없는 항목은 가장 최근의 코멘트로 보인다. 그 뒤에 달린 답은 코멘트를 대신하지 않는다.
const summaryOf = (m) => m.current ?? m.history.find((r) => r.replyTo === undefined) ?? m.history[0];
const summaryLines = (r) => [h('span', { class: 'muted' }, signedAt(r)), r.note ? h('div', {}, r.note) : null];

function markList(title, cls, marks, label, empty, pick = null) {
  return [
    h('h2', {}, `${title} ${marks.length}`),
    marks.length
      ? h('ul', { class: `plain ${cls}` }, marks.map((m) => h('li', pick ? { class: m.target.story === state.story ? 'selected' : '', onclick: () => pick(m.target.story) } : {},
          markChip(m), ' ', h('code', {}, label(m)), h('br'),
          ...summaryLines(summaryOf(m)))))
      : empty,
  ];
}

const routeSegments = (path) => path.split(/(?=\/)/).flatMap((seg, i) => [i ? h('wbr') : null, h('span', { class: 'seg' }, seg)]);

function screenItem(s, { selected, onclick }) {
  const n = testsOf(s.id).length;
  const waiting = awaitingTagOf(s.id).length;
  return h('li', { class: selected ? 'selected' : '', title: `${s.path} ${s.component}`, onclick },
    h('span', { class: 'name' }, h('span', {}, routeSegments(s.path)), ' ', h('span', { class: 'muted component' }, s.component)),
    h('span', { class: 'badges' },
      s.dead ? h('span', { class: 'chip dead', title: '서버에 없는 호출이 있습니다' }, '죽은 화면') : null,
      changeChips(s.id),
      markChip(markOf({ node: s.id })),
      talkCount(attachedTalk({ node: s.id })),
      h('span', { class: `count${n ? '' : ' none'}` }, n ? `테스트 ${n}` : '테스트 없음'),
      importersOf(s.id).length ? h('span', { class: 'count importer-count', title: '이 화면의 소스 파일을 불러오는 단위 테스트' }, `불러옴 ${importersOf(s.id).length}`) : null,
      passedOf(s.id).length ? h('span', { class: 'count passed-count', title: '이 화면의 태그 없이, 도는 동안 이 화면을 연 브라우저 테스트' }, `지나감 ${passedOf(s.id).length}`) : null,
      waiting ? h('span', { class: 'count awaiting-count', title: '이 화면의 테스트로 포함해 태그를 기다리는 테스트' }, `태그 대기 ${waiting}`) : null));
}

function renderLeftList() {
  const visible = visibleScreens();
  const list = document.getElementById('screen-list');
  fill(list, ...visible.map((s) => screenItem(s, { selected: s.id === state.selected, onclick: () => select(s.id) })));
  if (!visible.length) list.append(h('li', { class: 'muted' }, '해당하는 화면이 없습니다.'));
}

function renderUntaggedList() {
  const list = document.getElementById('untagged-list');
  if (untaggedListMissing()) return fill(list, h('li', { class: 'muted' }, '목록이 없습니다.'));
  const q = state.untaggedQuery.trim().toLowerCase();
  const visible = untaggedTests().filter((t) => !q || t.title.toLowerCase().includes(q) || testPlace(t).toLowerCase().includes(q));
  fill(list, ...visible.map((t) => h('li', { class: `${untaggedKey(t) === state.untaggedTest ? 'selected' : ''}${state.bulkBusy ? ' locked' : ''}`, onclick: () => selectUntaggedTest(untaggedKey(t)) },
    h('span', { class: `chip ${t.status}` }, TEST_STATUS[t.status]),
    h('span', { class: 'name' }, h('span', { class: 'title' }, t.title), ' ', h('span', { class: 'muted mono' }, testPlace(t))))));
  if (!visible.length) list.append(h('li', { class: 'muted' }, '해당하는 테스트가 없습니다.'));
}

