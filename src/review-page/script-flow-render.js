function renderFlowBar(screens) {
  const bar = document.getElementById('flow-bar');
  const searching = flowSearchInput !== null && document.activeElement === flowSearchInput;
  const tested = screens.filter((n) => statusOf(n.counts) !== 's-none').length;
  const picked = state.flowPicked ? screenOf(state.selected) : null;
  fill(bar,
    h('strong', { class: 'flowsummary' }, `테스트 있는 화면 ${tested}/${screens.length}`),
    h('span', { class: 'flow-filters', role: 'group', 'aria-label': '상태로 거르기' }, FLOW_FILTERS.map((f) => h('button', { type: 'button', 'data-filter': f.key, title: f.title, onclick: () => setFlowFilter(f.key) },
      f.label, ' ', h('span', { class: 'count' }, String(screens.filter(f.keep).length))))),
    flowComposing() ? null : newStoryButton(),
    flowSearch(),
    picked ? h('span', { class: 'picking' }, '고른 화면 ', h('strong', {}, picked.path), ' ', h('button', { type: 'button', class: 'unpick', onclick: unpickScreen }, '선택 해제')) : null,
    h('div', { class: 'flowguide' }, flowKey(), legendInfo('flow', '흐름도 읽는 법', flowLegendItems())));
  syncFlowFilters();
  if (searching) flowSearchInput.focus();
}

function applyFlowEmphasis() {
  const flow = document.getElementById('flow');
  const screens = flowScreens();
  const byId = new Map(screens.map((n) => [n.id, n]));
  const picked = state.flowPicked ? byId.get(state.selected) ?? null : null;
  let related = null;
  let jumps = new Set();
  if (picked) {
    const parentOf = new Map(screens.flatMap((n) => n.children.map((c) => [c.id, n.id])));
    related = new Set(screensIn([picked]).map((n) => n.id));
    for (let id = parentOf.get(picked.id); id !== undefined; id = parentOf.get(id)) related.add(id);
    jumps = new Set(picked.jumps.map((j) => j.to).filter((id) => !related.has(id)));
  }
  const filter = FLOW_FILTERS.find((f) => f.key === state.flowFilter);
  const q = state.flowQuery.trim().toLowerCase();
  const found = (n) => !q || `${n.label}\n${n.component}\n${n.id}`.toLowerCase().includes(q);
  for (const box of /** @type {NodeListOf<HTMLElement>} */ (flow.querySelectorAll('.box.screen'))) {
    const n = byId.get(box.dataset.key);
    box.classList.toggle('picked', n === picked);
    box.setAttribute('aria-pressed', String(n === picked));
    box.classList.toggle('dim', related !== null && !related.has(n.id) && !jumps.has(n.id));
    box.classList.toggle('jump', jumps.has(n.id));
    box.classList.toggle('off', !filter.keep(n) || !found(n));
  }
  for (const line of /** @type {NodeListOf<SVGPathElement>} */ (flow.querySelectorAll('.canvas svg path[data-from]'))) {
    const on = related !== null && related.has(line.dataset.from) && related.has(line.dataset.to);
    line.classList.toggle('on', on);
    line.classList.toggle('dim', related !== null && !on);
  }
}

function gapLists(screens, pick) {
  const failing = screens.filter((n) => n.counts.fail > 0);
  const untested = screens.filter((n) => statusOf(n.counts) === 's-none');
  const group = (title, list) => (list.length
    ? [h('h3', {}, `${title} ${list.length}`), h('ul', { class: 'screens gap-list' }, list.map((n) => screenItem({ id: n.id, path: n.label, component: n.component, dead: n.dead }, { selected: false, onclick: () => pick(n) })))]
    : null);
  return { count: failing.length + untested.length, groups: [group(TEST_STATUS.fail, failing), group(NO_TESTS, untested)] };
}

function renderGaps() {
  const gaps = gapLists(flowScreens(), (n) => pickScreen(n.id));
  fill(document.getElementById('gaps'),
    h('h2', {}, `빈틈 ${gaps.count}`),
    h('p', { class: 'muted lead' }, flowComposing()
      ? '실패했거나 테스트가 없는 화면입니다. 누르면 새 스토리의 단계로 넣습니다.'
      : '실패했거나 테스트가 없는 화면입니다. 누르면 그림에서 그 화면에 이어진 길만 진하게 남기고 그 화면을 엽니다.'),
    ...gaps.groups,
    gaps.count ? null : h('p', { class: 'muted' }, '빈틈이 없습니다.'));
}

function composeOverlay() {
  const c = flowComposing() ? state.compose : null;
  if (!c?.screens.length) return null;
  const st = checkedCompose(c) ?? { steps: c.screens.map((screen) => ({ screen, onMap: true })), links: [] };
  return { st };
}

function keepPressedBox(flow, pressed) {
  const box = flow.querySelector(`.box.screen[data-key="${CSS.escape(pressed.key)}"]`);
  if (!box) return;
  const r = box.getBoundingClientRect();
  flow.scrollTop += r.top - pressed.top;
  flow.scrollLeft += r.left - pressed.left;
  if (document.activeElement === document.body) box.focus({ preventScroll: true });
}

function renderFlow({ bar = true, pressed = null } = {}) {
  const flow = document.getElementById('flow');
  if (state.ended || flow.hidden) return;
  // 상자를 재는 동안 캔버스 높이가 0 이 되어 스크롤이 맨 위로 밀리므로 위치를 정한 뒤 되돌린다.
  const { scrollTop, scrollLeft } = flow;
  const canvases = [];
  const draw = (trees, options) => {
    const c = canvas(trees, options);
    canvases.push(c);
    return c.el;
  };
  if (bar) renderFlowBar(flowScreens());
  syncZoom();
  const { roots, unreached, summary } = state.data.flow;
  const story = composeOverlay();
  fill(flow,
    roots.length ? draw(roots, { group: true, story })
      : h('p', { class: 'muted' }, summary.screens ? '진입 화면을 찾지 못했습니다. 설정 파일의 entryPaths 에 적어 주세요.' : '화면이 없습니다.'),
    unreached.length ? [h('h2', {}, `진입 화면에서 닿지 않는 화면 ${screensIn(unreached).length}`), draw(unreached, { story })] : null);
  // 단계마다 모든 캔버스를 다 읽은 뒤에 쓰므로, 한 캔버스에 쓴 것 때문에 다음 캔버스를 읽다가 레이아웃을 다시 계산하지 않는다.
  const width = flowInnerWidth(flow) / state.zoom;
  for (const c of canvases) c.measureWidths();
  for (const c of canvases) c.fit(width);
  for (const c of canvases) c.measureHeights();
  drawnGrid = canvases.map((c) => c.place()).find(Boolean) ?? null;
  applyFlowEmphasis();
  Object.assign(flow, { scrollTop, scrollLeft });
  if (pressed && flowComposing()) keepPressedBox(flow, pressed);
  for (const info of document.querySelectorAll('[data-legend]')) applyLegend(info);
  recordPlace();
}

