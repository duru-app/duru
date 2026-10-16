function clearCenterHead() {
  const head = document.getElementById('center-head');
  head.dataset.key = '';
  fill(head);
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const PAIR_STATES = [
  { list: 'importers', label: '불러옴', cls: 'config' },
  { list: 'passed', cls: 'config' },
  { list: 'awaitingTag', label: '태그 대기', cls: 'wait', noteLabel: '메모' },
  { list: 'detachedHandOvers', label: '떨어져 나감', cls: 'wait', noteLabel: '메모' },
  { list: 'discarded', label: '제외한 짝', cls: 'muted', noteLabel: '이유' },
];

function pairsOf(t) {
  const ref = JSON.stringify(t.ref);
  const pairs = [];
  for (const { list, ...rest } of PAIR_STATES) {
    for (const [id, entries] of Object.entries(state.data.tests[list] ?? {})) {
      const entry = entries.find((e) => JSON.stringify(e.ref) === ref);
      if (entry) pairs.push({ id, entry, label: PASS_LEVEL[entry.level], ...rest });
    }
  }
  return pairs.sort((a, b) => compareText(screenLabel(a.id), screenLabel(b.id)) || compareText(a.id, b.id));
}

const opensOnPage = (id) => Boolean(screenOf(id) || callOf(id)?.screens.length);

function pairItem({ id, entry, label, cls, noteLabel }) {
  const s = screenOf(id);
  const call = !s && callOf(id);
  const body = h('span', { class: 'name' },
    s ? screenHead(s) : h('div', { class: call ? 'mono' : 'muted mono' }, id),
    entry.via ? viaRow(entry.via) : null,
    entry.judgment ? judgmentMeta(entry.judgment, noteLabel) : null);
  const stateChip = h('span', { class: `chip pair-state ${cls}` }, label);
  if (!s && !call) return h('div', { class: 'step off-map pair' }, body, h('span', { class: 'chip l-off-map', title: '맵에 없는 화면이나 호출입니다' }, '맵에 없음'), stateChip);
  if (!opensOnPage(id)) return h('div', { class: 'step off-map pair' }, body, stateChip);
  const open = s
    ? { title: '화면 목록에서 이 화면을 엽니다', onclick: () => openScreen(id) }
    : { title: '이 호출을 부르는 화면을 열고 이 호출을 고릅니다', onclick: () => openCall(id) };
  return h('div', { class: `step on-map pair${state.bulkBusy ? ' locked' : ''}`, title: state.bulkBusy ? null : open.title, onclick: open.onclick }, body, stateChip);
}

function noScreensText(t) {
  if (t.format === 'playwright') {
    if (t.unmatched) return '이 테스트는 도는 동안 맵에 있는 화면을 열지도, 맵에 있는 호출을 보내지도 않았습니다.';
    const notice = (state.data.tests.traceNotices ?? []).find((n) => n.test.title === t.title && n.test.file === t.file && n.test.line === t.line);
    if (notice) return `이 테스트의 trace 파일을 읽지 못해, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. ${notice.reason}.`;
    if (t.status === 'pending') return '이 테스트는 건너뛰어 돌지 않았으므로, 어느 화면을 열고 어느 호출을 보내는지 알 수 없습니다.';
    return '이 테스트는 trace 파일 없이 돌아, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.';
  }
  if (t.testFile) return '이 테스트가 불러오는 파일로 이어진 화면이 없습니다. 화면 넷 이상이 함께 쓰는 파일과 찾지 못한 파일로는 잇지 않습니다.';
  if (t.format !== 'vitest') return `이 결과 형식(${t.format})에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.`;
  const reason = (state.data.tests.importNotices ?? []).find((n) => n.file === t.file)?.reason;
  return `테스트가 불러오는 파일을 읽지 못했습니다.${reason ? ` ${reason}.` : ''}`;
}

const isPickable = (p) => !p.entry.judgment && opensOnPage(p.id);

function redrawBulk(focusSelector) {
  renderUntaggedCenter();
  /** @type {HTMLElement} */ (document.querySelector(`#center ${focusSelector}`))?.focus();
}

// 고를 짝이 남지 않아 단추 줄이 사라지면 짝 묶음의 제목으로 간다.
function focusBulk(kind) {
  const pairs = document.querySelector('#center .test-pairs');
  const bar = pairs?.querySelector('.bulk-bar');
  /** @type {HTMLElement} */ (bar ? bar.querySelector(`button.${kind}:enabled`) ?? bar.querySelector('input') : pairs?.querySelector('h2'))?.focus();
}

// 찾기 칸처럼 다시 그려도 남는 칸의 초점은 단추로 가져오지 않는다. 가져오면 치던 Space 나 Enter 가 단추를 다시 누른다.
function showBulkResult(kind) {
  const focused = document.activeElement;
  render();
  if (!focused || focused === document.body || !focused.isConnected) focusBulk(kind);
}

function setPick(bulk, id, on) {
  if (on) bulk.picked.add(id); else bulk.picked.delete(id);
  redrawBulk(`input.pick[data-pair="${CSS.escape(id)}"]`);
}

const bulkButtonOff = (count) => state.bulkBusy || state.ending || !count;
const pickedPairs = (t, bulk) => pairsOf(t).filter((p) => isPickable(p) && bulk.picked.has(p.id));

function askExcludePicked(t, bulk) {
  askExclude(t, () => pickedPairs(t, bulk).map((p) => p.id), {
    save: async (reason) => {
      const failure = await saveBulk(t, bulk, 'discard', reason);
      if (failure) render();
      return failure;
    },
    done: () => showBulkResult('discard'),
    refocus: () => /** @type {HTMLElement} */ (document.querySelector('#center .bulk-bar button.discard'))?.focus(),
  });
}

function bulkBar(t, pickable, bulk) {
  const count = pickable.filter((p) => bulk.picked.has(p.id)).length;
  const off = bulkButtonOff(count);
  return h('div', { class: 'bulk-bar' },
    h('label', {}, h('input', { type: 'checkbox', class: 'pick-all', checked: count === pickable.length, disabled: state.bulkBusy,
      onchange: (e) => { bulk.picked = new Set(e.target.checked ? pickable.map((p) => p.id) : []); redrawBulk('input.pick-all'); } }), ' 모두 고르기'),
    h('button', { class: 'discard', title: '고른 짝을 다시 보이지 않게 합니다. 이유를 적어야 합니다', disabled: off, onclick: () => askExcludePicked(t, bulk) }, `제외 (${count})`),
    h('button', { class: 'hand-over', title: '고른 짝을 그 화면이나 호출의 테스트로 보고, 태그를 달도록 작업 목록에 올립니다', disabled: off, onclick: async () => { await saveBulk(t, bulk, 'hand-over', ''); showBulkResult('hand-over'); } }, `포함 (${count})`),
    bulk.error ? h('p', { class: 'error bulk-error' }, bulk.error) : null);
}

function renderUntaggedCenter() {
  clearCenterHead();
  const center = document.getElementById('center-body');
  if (untaggedListMissing()) return fill(center, h('p', { class: 'muted' }, '이 tests.json 에는 태그 없는 테스트 목록이 없습니다. duru rebuild 를 다시 실행하세요.'));
  const t = untaggedTests().find((x) => untaggedKey(x) === state.untaggedTest);
  if (!t) return fill(center, h('p', { class: 'muted' }, '태그 없는 테스트가 없습니다.'));
  const pairs = pairsOf(t);
  const pickable = pairs.filter(isPickable);
  const bulk = state.bulk;
  for (const id of bulk.picked) if (!pickable.some((p) => p.id === id)) bulk.picked.delete(id);
  const pickRow = (p) => h('div', { class: 'pair-row' },
    isPickable(p)
      ? h('input', { type: 'checkbox', class: 'pick', 'data-pair': p.id, checked: bulk.picked.has(p.id), disabled: state.bulkBusy, onchange: (e) => setPick(bulk, p.id, e.target.checked) })
      : h('span', { class: 'pick-space' }),
    pairItem(p));
  fill(center,
    h('div', { class: 'title-row' }, h('h3', {}, t.title), h('span', { class: `chip ${t.status}` }, TEST_STATUS[t.status])),
    h('div', { class: 'muted mono' }, testPlace(t)),
    h('div', { class: 'muted' }, `${t.format} · ${t.source}`),
    h('div', { class: 'test-pairs' },
      h('h2', { tabindex: '-1' }, `이 테스트와 화면·호출의 짝 ${pairs.length}`),
      pickable.length ? bulkBar(t, pickable, bulk) : null,
      pairs.length
        ? h('div', { class: 'story-path' }, pairs.map(pickRow))
        : h('p', { class: 'muted no-screens' }, noScreensText(t))),
    t.unmatched?.length ? h('div', { class: 'unmatched' },
      h('h2', {}, `맵에 맞는 화면이 없는 주소 ${t.unmatched.length}`),
      h('p', { class: 'muted' }, '이 테스트가 도는 동안 열었지만 맵의 어느 화면에도 맞지 않은 주소입니다. 맵을 만든 클라이언트와 테스트가 돈 클라이언트가 다르면 여기에 쌓입니다.'),
      h('ul', { class: 'plain' }, t.unmatched.map((url) => h('li', { class: 'mono' }, url)))) : null);
}

