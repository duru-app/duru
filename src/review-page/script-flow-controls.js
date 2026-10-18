const flowInnerWidth = (flow) => {
  const pad = getComputedStyle(flow);
  return flow.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
};
// 모아 놓은 진입 화면을 그린 칸 수 정보. 없으면 null 이고, 창 크기가 바뀌어도 다시 그리지 않는다.
// 폭은 한 줄에 놓이는 칸 수로만 배치에 들어가므로 그 수가 달라질 때만 다시 그린다.
let drawnGrid = null;

// 설명 상자가 열렸는지는 상태에 두고 상자 그림은 다시 그리지 않는다. 다시 그리면 단추의 초점이 사라진다.
// 마우스가 올라 있는 채로 닫으면, 마우스가 벗어났다가 다시 올라올 때까지 보이지 않는다.
const legendShown = (info) => {
  const legend = state.legends[info.dataset.legend];
  return legend.open || (!legend.dismissed && info.matches(':hover'));
};
function applyLegend(info) {
  const shown = legendShown(info);
  info.classList.toggle('shown', shown);
  info.querySelector('button').setAttribute('aria-expanded', String(shown));
}
function setLegend(info, open) {
  const legend = state.legends[info.dataset.legend];
  legend.open = open;
  legend.dismissed = !open && info.matches(':hover');
  applyLegend(info);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || state.view === 'list' || document.querySelector('dialog[open]')) return;
  const open = [...document.querySelectorAll('[data-legend]')].filter(legendShown);
  for (const info of open) setLegend(info, false);
  if (!open.length && state.view === 'flow' && state.flowPicked && !(e.target instanceof Element && e.target.closest('input, select, textarea, #center, #right'))) unpickScreen();
});
// 끌었다 놓거나 스크롤바를 눌러도 click 이 오고, 상자를 누른 채 옆으로 비껴 놓으면 click 이 빈 곳으로 온다.
const FLOW_EMPTY = '#flow, #flow .zoom-box, #flow .canvas';
let flowPress = null;
document.getElementById('flow').addEventListener('pointerdown', (e) => {
  const flow = /** @type {HTMLElement} */ (e.currentTarget);
  const r = flow.getBoundingClientRect();
  const inside = e.clientX - r.left - flow.clientLeft < flow.clientWidth && e.clientY - r.top - flow.clientTop < flow.clientHeight;
  flowPress = inside && /** @type {Element} */ (e.target).matches(FLOW_EMPTY) ? { x: e.clientX, y: e.clientY } : null;
});
document.getElementById('flow').addEventListener('click', (e) => {
  const press = flowPress;
  flowPress = null;
  if (!flowPickShown() || !press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) return;
  if (/** @type {Element} */ (e.target).matches(FLOW_EMPTY)) unpickScreen();
});

// key 는 'flow' 또는 'path' 로, 단추와 설명 상자의 이름에도 쓴다.
function legendInfo(key, label, items) {
  const info = h('span', {
    class: `${key}info`,
    'data-legend': key,
    onmouseenter: (e) => applyLegend(e.currentTarget),
    onmouseleave: (e) => { state.legends[key].dismissed = false; applyLegend(e.currentTarget); },
  },
    h('button', { class: `${key}info-button`, 'aria-label': label, 'aria-expanded': 'false', 'aria-controls': `${key}legend`, onclick: () => setLegend(info, !state.legends[key].open) }, 'i'),
    h('ul', { class: `${key}legend`, id: `${key}legend` }, items));
  return info;
}

const KEY_STATUS = [...['pass', 'fail', 'pending'].map((s) => [`s-${s}`, TEST_STATUS[s]]), ['s-none', NO_TESTS]];

function flowKey() {
  return h('ul', { class: 'flowkey', 'aria-label': '흐름도 범례' },
    KEY_STATUS.map(([status, label]) => h('li', {}, h('span', { class: `sq ${status}`, 'aria-hidden': 'true' }), h('span', { class: 'key-label' }, label))),
    h('li', { class: 'apart' },
      svg('svg', { viewBox: '0 0 26 6', 'aria-hidden': 'true' }, svg('path', { class: 'guarded', d: 'M0 3H26' })), h('span', { class: 'key-label' }, '조건 걸린 링크')),
    h('li', {},
      svg('svg', { viewBox: '0 0 26 6', 'aria-hidden': 'true' }, svg('path', { class: 'moved', d: 'M0 3H26' })), h('span', { class: 'key-label' }, LINK_VERDICT.configured)));
}

const legendPill = (cls, ...tags) => h('span', { class: `box s-none${cls}`, 'aria-hidden': 'true' }, h('span', { class: 'sq' }), h('span', { class: 'path' }, '/주소'), ...tags);

function flowLegendItems() {
  return [
    h('li', {}, h('span', { class: 'sample' }, legendPill('', h('span', { class: 'tag api' }, 'API 8'))), h('span', {}, '이 화면에서 부르는 API 호출의 수. 화면을 누르면 오른쪽에 호출마다 테스트가 보입니다')),
    h('li', {}, h('span', { class: 'sample' }, legendPill('', h('span', { class: 'tag need' }, KIND_LABEL.role)), legendPill('', h('span', { class: 'tag need' }, KIND_LABEL.setting))),
      h('span', {}, '특정 역할이나 설정에서만 열리는 화면. 무엇이 필요한지는 마우스를 올리면 보입니다')),
    h('li', {}, h('span', { class: 'sample' }, legendPill(' jump')), h('span', {}, '고른 화면에서 다른 가지에 이미 그린 화면으로 가는 링크나 설정에 적은 이동이 닿는 화면')),
    h('li', {}, h('span', { class: 'sample' }, '불러옴 N · 지나감 N'), h('span', {}, '태그 없이 이 화면을 불러오는 단위 테스트와, 도는 동안 이 화면을 연 브라우저 테스트. 마우스를 올리면 보입니다', h('small', {}, '상태 색과 테스트 수에는 넣지 않음'))),
  ];
}

const FLOW_FILTERS = [
  { key: 'all', label: '전체', keep: () => true },
  { key: 'none', label: NO_TESTS, keep: (n) => statusOf(n.counts) === 's-none' },
  { key: 'imported', label: '태그 없는 테스트만', title: '태그 붙은 테스트는 없고, 이 화면을 불러오는 단위 테스트나 도는 동안 이 화면을 연 브라우저 테스트만 있는 화면', keep: (n) => statusOf(n.counts) === 's-none' && n.imported + n.passed > 0 },
  { key: 'fail', label: TEST_STATUS.fail, keep: (n) => n.counts.fail > 0 },
  { key: 'pending', label: TEST_STATUS.pending, keep: (n) => statusOf(n.counts) === 's-pending' },
  { key: 'pass', label: TEST_STATUS.pass, keep: (n) => statusOf(n.counts) === 's-pass' },
];

function syncFlowFilters() {
  for (const button of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#flow-bar .flow-filters button'))) {
    const on = button.dataset.filter === state.flowFilter;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
}

function setFlowFilter(key) {
  state.flowFilter = state.flowFilter === key ? 'all' : key;
  syncFlowFilters();
  applyFlowEmphasis();
}

// 검색 입력창을 새로 만들면 조합 중이던 한글이 끊기고 포커스도 사라지므로 한 번 만든 입력창을 다시 붙인다.
let flowSearchInput = null;
function flowSearch() {
  flowSearchInput ??= h('input', {
    type: 'search',
    class: 'flow-search',
    placeholder: '화면 찾기',
    'aria-label': '그림에서 화면 찾기',
    oninput: (e) => {
      state.flowQuery = e.target.value;
      applyFlowEmphasis();
    },
    onkeydown: (e) => {
      if (e.key !== 'Enter' || e.isComposing || !state.flowQuery.trim()) return;
      const first = /** @type {HTMLElement} */ (document.querySelector('#flow .box.screen:not(.off)'));
      if (first) pickScreen(first.dataset.key);
    },
  });
  if (flowSearchInput.value !== state.flowQuery) flowSearchInput.value = state.flowQuery;
  flowSearchInput.title = 'Enter 를 누르면 찾은 첫 화면을 고릅니다';
  return flowSearchInput;
}

const zoomLevel = (z) => Math.floor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100 + 1e-6) / 100;
const zoomText = () => `${Math.round(state.zoom * 100)}%`;

// 위쪽 줄은 배율과 상관이 없으므로 다시 만들지 않는다.
function setZoom(z) {
  state.zoom = zoomLevel(z);
  renderFlow({ bar: false });
}

// 진입 화면을 모은 칸은 배율이 작을수록 한 줄에 놓이는 칸이 늘어 높이가 줄어든다.
function fitZoom() {
  const flow = document.getElementById('flow');
  if (!flow.querySelector('.canvas')) return;
  const fits = (z) => {
    setZoom(z);
    return flow.scrollWidth <= flow.clientWidth && flow.scrollHeight <= flow.clientHeight;
  };
  let low = Math.round(ZOOM_MIN * 100), high = 100;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid / 100)) low = mid;
    else high = mid - 1;
  }
  if (state.zoom !== low / 100) setZoom(low / 100);
}

function applyZoomInput(input, text = input.value) {
  const typed = text.trim().replace(/\s*%$/, '');
  const n = typed === '' ? NaN : Number(typed);
  if (Number.isFinite(n) && zoomLevel(n / 100) !== state.zoom) setZoom(n / 100);
  input.value = zoomText();
}

// 칸 밖을 눌러 초점이 빠질 때 바로 다시 그리면 누른 상자가 클릭이 끝나기 전에 사라지므로, 그때는 누른 것의 클릭이 끝난 뒤에 적용한다.
// 클릭 없이 끝나는 누름은 손을 뗄 때 적용한다. 끌기를 마치거나 누른 채 메뉴가 열려 끝나는 누름에는 mouseup 이 오지 않을 수 있으므로 그때도 손을 뗀 것으로 본다.
let pressedAt = null;
let leftZoomText = null;
function applyLeftZoom() {
  if (leftZoomText === null) return;
  const text = leftZoomText;
  leftZoomText = null;
  applyZoomInput(zoomBox.querySelector('.zoom-level'), text);
}
document.addEventListener('mousedown', (e) => { pressedAt = e.button === 0 ? e.target : null; }, true);
for (const type of ['mouseup', 'dragend', 'contextmenu']) {
  document.addEventListener(type, () => {
    pressedAt = null;
    if (leftZoomText !== null) setTimeout(applyLeftZoom);
  }, true);
}
addEventListener('click', applyLeftZoom);
function leaveZoomInput(input) {
  if (pressedAt && !zoomBox.contains(pressedAt)) leftZoomText = input.value;
  else applyZoomInput(input);
}

// 퍼센트 칸에 숫자를 쳐 둔 채 − 나 + 를 누르면 칸에서 초점이 빠지면서 배율이 먼저 바뀌고 그림을 다시 그린다.
// 이때 단추를 새로 만들면 누른 것이 사라지므로, 조절은 한 번만 만들고 값만 고친다.
let zoomBox = null;
function syncZoom() {
  if (!zoomBox) {
    zoomBox = h('div', { id: 'flow-zoom', class: 'zoom', role: 'group', 'aria-label': '확대와 축소' },
      h('button', { type: 'button', class: 'zoom-fit', title: '그림 전체가 보이게 맞춥니다', 'aria-label': '그림 전체가 보이게 맞춤', onclick: fitZoom }, '⛶'),
      h('button', { type: 'button', class: 'zoom-out', title: '축소', 'aria-label': '축소', onclick: () => setZoom(state.zoom - ZOOM_STEP) }, '−'),
      h('input', {
        type: 'text',
        class: 'zoom-level',
        inputmode: 'numeric',
        'aria-label': '배율 (퍼센트)',
        title: '숫자를 치고 Enter 를 누르면 그 배율이 됩니다',
        onfocus: (e) => e.target.select(),
        onkeydown: (e) => {
          if (e.isComposing) return;
          if (e.key === 'Enter') applyZoomInput(e.target);
          else if (e.key === 'Escape') {
            e.preventDefault();
            e.target.value = zoomText();
          } else return;
          e.target.select();
        },
        onblur: (e) => leaveZoomInput(e.target),
      }),
      h('button', { type: 'button', class: 'zoom-in', title: '확대', 'aria-label': '확대', onclick: () => setZoom(state.zoom + ZOOM_STEP) }, '+'));
    document.getElementById('flow').after(zoomBox);
  }
  const input = zoomBox.querySelector('.zoom-level');
  if (document.activeElement !== input) input.value = zoomText();
  zoomBox.querySelector('.zoom-out').disabled = state.zoom <= ZOOM_MIN;
  zoomBox.querySelector('.zoom-in').disabled = state.zoom >= ZOOM_MAX;
}

