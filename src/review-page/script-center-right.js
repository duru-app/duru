function renderStoryRight(info, dock) {
  if (state.composing) {
    const order = composeTarget();
    if (!order) {
      fill(info, h('div', { class: 'talk' }, h('h2', {}, '에이전트와 대화'), h('p', { class: 'muted compose-talk' }, '화면을 고르면 그 순서가 꼬리표로 붙어, 사이를 채워 달라고 에이전트에게 부탁할 수 있습니다.')));
      return fill(dock, composeTalkForm());
    }
    fill(info, talkPanel(order));
    return fill(dock, markForm(order, 'composeTalk', tagLabel(order)));
  }
  if (needOf()) {
    fill(dock);
    return fill(info);
  }
  const c = candidateOf();
  if (c) {
    fill(info, talkPanel({ candidate: c.key }));
    return fill(dock, markForm({ candidate: c.key }, 'candidateTalk', '후보'));
  }
  if (state.story === null) {
    fill(info);
    return fill(dock);
  }
  fill(info, talkPanel({ story: state.story }));
  fill(dock, markForm({ story: state.story }, 'storyDraft', '스토리'));
}

const composeTalkForm = () => h('fieldset', { class: 'mark-form', disabled: true, title: '화면을 고른 뒤에 남길 수 있습니다' },
  h('div', { class: 'statuses' }, Object.values(MARK_STATUS).map((text) => h('button', { type: 'button' }, text))),
  h('textarea', { 'aria-label': '코멘트', placeholder: '화면을 고른 뒤에 코멘트를 남길 수 있습니다' }),
  h('div', { class: 'save-row' }, h('button', { type: 'button', class: 'save' }, '남기기')));

function renderCenter() {
  if (state.view === 'story') return renderStoryCenter();
  if (state.side === 'untagged') return renderUntaggedCenter();
  if (state.side === 'cases') return renderCaseCenter();
  const center = document.getElementById('center-body');
  const s = state.data.map.screens.find((x) => x.id === state.selected);
  renderCenterHead(s);
  if (!s) return fill(center, h('p', { class: 'muted' }, '화면이 없습니다.'));
  const tests = testsOf(s.id);
  const rows = [{ label: '화면 전체', target: { node: s.id }, tests: [] }]
    .concat(state.data.depths.map((d) => ({ label: DEPTH_LABELS[d], target: { node: s.id, depth: d }, tests: tests.filter((t) => t.depth === d) })));
  fill(center,
    baselineBanner(s),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '깊이'), h('th', {}, '테스트'), h('th', {}, '상태'))),
      h('tbody', {}, rows.map((r) => h('tr', {
        class: keyOf(r.target) === keyOf(state.target) ? 'selected' : '',
        onclick: () => selectTarget(r.target),
      },
        h('td', { class: 'depth' }, r.label, talkCount(entriesAt(r.target), r.target)),
        h('td', {}, r.target.depth ? (r.tests.length ? r.tests.map((t) => partRow(testItem(t, { hide: [`screen:${s.id}`, `depth:${t.depth}`] }), s.id, t)) : h('span', { class: 'muted' }, '없음')) : h('span', { class: 'muted' }, `테스트 ${tests.length}개`)),
        h('td', { class: 'mark' }, markChip(markOf(r.target)) ?? h('span', { class: 'muted' }, '—')))))),
    strayJudgmentError(s),
    untaggedPairs(s.id),
    callTable(s),
    callInfo(s),
    screenInfo(s),
  );
}

const targetLabelOf = ({ option, depth }, call) => [option && optionLabel(option), depth && `${DEPTH_LABELS[depth]} 깊이`].filter(Boolean).join(' · ') || (call ? '호출 전체' : '화면 전체');

function callInfo(s) {
  const call = state.target.node === s.id ? null : callOf(state.target.node);
  if (!call) return null;
  return h('details', { class: 'call-info', open: state.callInfoShut !== call.id, ontoggle: (e) => { state.callInfoShut = e.currentTarget.open ? null : call.id; } },
    h('summary', {}, h('span', { class: 'title' }, '호출 정보'), ' ', h('span', { class: 'target-id' }, h('span', { class: 'mono' }, call.id), ' ', h('strong', {}, targetLabelOf(state.target, call)))),
    caseSection(call),
    callDetails(call, s));
}

function screenInfo(s) {
  return h('details', { class: 'screen-info', open: state.screenInfoOpen, ontoggle: (e) => { state.screenInfoOpen = e.currentTarget.open; } },
    h('summary', {}, h('span', { class: 'title' }, '화면 정보'), ' ',
      h('span', { class: 'counts muted' }, `들어오는 링크 ${s.access.links.length + movesOf('to', s.id).length} · 나가는 링크 ${s.links.length + movesOf('from', s.id).length} · 읽는 설정값 ${s.settingReads.length}`)),
    openSummary(s),
    caseSection(s),
    screenDetails(s));
}

const serverText = (server) => (server.status === 'match' && server.labels?.length
  ? `${SERVER_STATUS.match} (${server.labels.join(', ')})`
  : SERVER_STATUS[server.status] ?? server.status);

function verdictChip(server) {
  return h('span', { class: `chip v-${server.status}`, title: server.candidates ? `서버에는 ${server.candidates.join(' / ')}` : null }, serverText(server));
}

function callRows(s) {
  const rows = [];
  const seen = new Set();
  for (const c of s.apiCalls) {
    const site = `${c.fn} · ${c.file}:${c.line}`;
    if (!c.endpoints) {
      rows.push({ site, problem: 'API 함수를 찾지 못함' });
      continue;
    }
    for (const e of c.endpoints) {
      if (!e.callId) rows.push({ site, problem: `${e.method ?? '?'} ${e.url ?? '주소를 계산하지 못함'}`, server: e.server });
      else if (!seen.has(e.callId)) {
        seen.add(e.callId);
        rows.push({ call: callOf(e.callId) });
      }
    }
  }
  return rows;
}

function countsOf(tests) {
  const counts = { pass: 0, fail: 0, pending: 0 };
  for (const t of tests) counts[t.status] += 1;
  return tests.length ? countText(counts) : h('span', { class: 'muted' }, '—');
}

function cell(target, tests, empty) {
  return h('td', {
    class: `cell${keyOf(target) === keyOf(state.target) ? ' selected' : ''}`,
    onclick: () => selectTarget(target),
  },
    h('div', {}, !tests.length && empty ? h('span', { class: 'none' }, empty) : countsOf(tests)),
    markChip(markOf(target)),
    talkCount(entriesAt(target), target));
}

// 「옵션 지정 없음」 줄은 표시 대상이 아니라서 칸을 눌러도 고를 수 없다.
function optionRows(s, call, depths) {
  const options = optionsOf(s, call.id);
  if (!options.length) return [];
  const tests = testsOf(call.id);
  const byDepth = (list) => depths.map((d) => list.filter((t) => t.depth === d));
  const rows = options.flatMap((o) => [true, false].map((value) => {
    const target = { node: call.id, option: { key: o.key, value } };
    const matching = hasOption(tests, o.key, value);
    const split = byDepth(matching);
    return h('tr', { class: `option${matching.length ? '' : ' gap'}` },
      h('td', { class: 'call' }, h('div', {}, optionLabel(target.option)),
        o.sources.includes('type') ? h('span', { class: 'chip config', title: 'API 메서드가 보내는 본문의 타입에서 읽은 옵션' }, '본문 타입') : null,
        o.sources.includes('config') ? h('span', { class: 'chip config', title: '설정 bodyOptions 에 적은 옵션' }, '설정') : null),
      cell(target, matching, '테스트 없음'),
      depths.map((d, i) => cell({ ...target, depth: d }, split[i])),
      compareGap());
  }));
  const unspecified = tests.filter((t) => !t.options?.length);
  rows.push(h('tr', { class: 'option' },
    h('td', { class: 'call', title: '옵션 태그를 달지 않은 테스트' }, h('div', {}, '옵션 지정 없음')),
    [unspecified, ...byDepth(unspecified)].map((list) => h('td', { class: 'count' }, h('div', {}, countsOf(list)))),
    compareGap()));
  return rows;
}

// 같은 빈자리를 옵션을 받는 호출의 옵션 칸에서 표시하므로, 여기서도 표시를 받으면 작업 목록에 두 번 오른다. 그래서 이 줄은 눌러도 고를 수 없다.
function resultOptionRows(call, depths) {
  const { callLinks = [], unknownCallLinks = [] } = state.data.map;
  return [...callLinks, ...unknownCallLinks].filter((l) => l.to === call.id).flatMap((l) => {
    const from = callOf(l.from);
    const fromId = opensOnPage(l.from)
      ? h('a', { href: '#', class: 'mono', title: '이 호출을 부르는 화면을 열고 이 호출을 고릅니다', onclick: (e) => { e.preventDefault(); openCall(l.from); } }, l.from)
      : h('span', { class: 'mono' }, l.from);
    const head = h('tr', { class: 'option result-head' },
      h('td', { class: 'call', colspan: depths.length + 2 + (state.data.baseline ? 1 : 0) },
        h('div', {}, h('span', { class: 'result-title' }, '이 결과를 바꾸는 옵션'), ' ', fromId, from ? null : h('span', { class: 'chip l-off-map' }, '맵에 없는 호출')),
        h('div', { class: 'muted' }, l.note)));
    if (!from) return [head];
    if (!from.options.length) return [head, h('tr', { class: 'option' }, h('td', { class: 'call' }, h('div', { class: 'muted' }, '옵션 없음')), h('td', { colspan: depths.length + 1 }), compareGap())];
    const output = testsOf(l.from).filter((t) => t.depth === 'output');
    return [head, ...from.options.flatMap((o) => [true, false].map((value) => {
      const matching = hasOption(output, o.key, value);
      return h('tr', { class: `option${matching.length ? '' : ' gap'}` },
        h('td', { class: 'call' }, h('div', {}, optionLabel({ key: o.key, value }))),
        h('td', {}),
        depths.map((d) => (d === 'output'
          ? h('td', { class: 'count' }, h('div', {}, matching.length ? countsOf(matching) : h('span', { class: 'none' }, '테스트 없음')))
          : h('td', {}))),
        compareGap());
    }))];
  });
}

function pickCall(id) {
  selectTarget({ node: id });
  if (document.activeElement !== document.body) return;
  const names = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('table.calls button.call-name'));
  [...names].find((b) => b.textContent === id)?.focus({ preventScroll: true });
}

const compareGap = () => (state.data.baseline ? h('td', { class: 'compare' }) : null);

function removedCallRows(s, depths) {
  const calls = baselineIndex()?.screenCalls.get(s.id);
  return (calls?.removed ?? []).map((id) => h('tr', { class: 'removed-call' },
    h('td', { class: 'call' }, h('div', { class: 'mono gone' }, id)),
    h('td', { colspan: depths.length + 1 }, '—'),
    h('td', { class: 'compare' }, h('span', { class: 'chip change-removed' }, '없어짐'))));
}

function callTable(s) {
  const rows = callRows(s);
  const depths = state.data.depths;
  const removed = removedCallRows(s, depths);
  if (!rows.length && !removed.length) return [h('h2', {}, 'API 호출'), h('p', { class: 'muted' }, '부르는 API 호출이 없습니다.')];
  const baseline = state.data.baseline;
  return [
    h('h2', {}, `API 호출 ${rows.length}`, listAbsentNote('서버 목록 없음')),
    h('table', { class: 'calls' },
      h('thead', {}, h('tr', {}, h('th', {}, '호출'), h('th', {}, '전체'), depths.map((d) => h('th', {}, DEPTH_LABELS[d])), baseline ? h('th', {}, `${baseline.label} 와 비교`) : null)),
      h('tbody', {}, rows.flatMap((r) => {
        if (!r.call) {
          return h('tr', {},
            h('td', { class: 'call' }, h('div', { class: 'mono' }, r.problem), r.server ? verdictChip(r.server) : null,
              r.server?.status === 'unresolved' ? h('span', { class: 'unresolved-reason' }, UNRESOLVED_REASON[r.server.reason]) : null,
              h('div', { class: 'muted mono' }, r.site)),
            h('td', { class: 'muted', colspan: depths.length + 1 }, '호출 노드가 없어 테스트를 붙이거나 코멘트를 남길 수 없습니다'),
            compareGap());
        }
        const tests = testsOf(r.call.id);
        const sent = passedOf(r.call.id).length;
        return [h('tr', {},
          h('td', { class: 'call pick', onclick: () => pickCall(r.call.id) },
            h('div', { class: 'mono' }, h('button', { type: 'button', class: 'call-name', title: '이 호출을 고르고 호출 정보를 엽니다' }, r.call.id)), verdictChip(r.call.server),
            sent ? h('span', { class: 'sent-count', title: '이 호출의 태그 없이, 도는 동안 이 호출을 보낸 브라우저 테스트' }, `호출함 ${sent}`) : null),
          cell({ node: r.call.id }, tests),
          depths.map((d) => cell({ node: r.call.id, depth: d }, tests.filter((t) => t.depth === d))),
          baseline ? callCompareCell(s, r.call.id) : null),
          ...optionRows(s, r.call, depths),
          ...resultOptionRows(r.call, depths)];
      }), removed)),
  ];
}

const inheritedText = (guard, via) => `${guard} (${via} 로 물려받음)`;

function guardList(item) {
  const own = item.guards.map((g) => h('code', { class: 'guard' }, g));
  const inherited = (item.inheritedGuards ?? []).flatMap((ig) => ig.guards.map((g) => h('code', { class: 'guard' }, inheritedText(g, ig.via))));
  return own.length || inherited.length ? [...own, ...inherited] : [h('span', { class: 'muted' }, '조건 없음')];
}

function renderRight() {
  renderPointPane();
  const info = document.getElementById('right-info');
  const dock = document.getElementById('right-dock');
  if (state.view !== 'story' && state.side === 'untagged') {
    fill(info);
    return fill(dock);
  }
  const all = state.talkScope === 'all';
  const view = all ? 'all' : state.view !== 'story' && state.side === 'cases' ? `cases\n${state.caseNode}` : state.view !== 'story' ? `${state.selected}\n${state.target?.node}` : state.composing ? 'compose' : state.candidate ? `candidate(${state.candidate})` : state.need ? `need(${state.need})` : `story(${state.story})`;
  const shown = shownTarget();
  const dockKey = shown ? keyOf(shown) : null;
  if (dockKey !== state.dockKey) state.historyFilter = null;
  state.dockKey = dockKey;
  if (all) {
    fill(info, allTalk());
    fill(dock);
  } else (state.view === 'story' ? renderStoryRight : state.side === 'cases' ? renderCaseRight : renderScreenRight)(info, dock);
  const scope = scopeButtons();
  if (scope) info.prepend(scope);
  if (view !== state.rightView) {
    info.scrollTop = 0;
    document.getElementById('right').scrollTop = 0;
  }
  state.rightView = view;
  if (!all) revealRecord();
}

