function setView(view) {
  if (!state.data || state.failed) return;
  if (view !== state.view) Object.assign(state, { error: null, caseError: null, judgmentError: null });
  state.view = view;
  render();
}

// 데이터를 읽지 못한 페이지에서도 리뷰를 끝낼 수 있어야 하므로, 위쪽 단추의 잠금은 읽어 온 데이터 없이 맞춘다.
function syncHeaderLocks() {
  for (const id of ['view-list', 'view-flow', 'view-story']) /** @type {HTMLButtonElement} */ (document.getElementById(id)).disabled = state.bulkBusy;
  /** @type {HTMLButtonElement} */ (document.getElementById('end-review')).disabled = state.bulkBusy || state.ending;
}

function render() {
  if (state.ended || state.failed) return;
  pickables = [];
  checkStoryStep();
  renderHeader();
  const flow = state.view === 'flow';
  // 고른 화면이 그림에 없으면 오른쪽 칸과 그림이 서로 다른 화면을 가리키므로 선택을 해제한다.
  if (flow && state.flowPicked && !flowScreens().some((n) => n.id === state.selected)) state.flowPicked = false;
  const picked = flow && state.flowPicked;
  const diagram = composeDiagram();
  if (diagram) state.flowPicked = false;
  const main = document.querySelector('main');
  main.classList.toggle('flow', flow);
  main.classList.toggle('picked', picked);
  main.classList.toggle('compose-flow', diagram);
  fitPanes();
  document.getElementById('flow-bar').hidden = !flow;
  document.getElementById('flow').hidden = !flow && !diagram;
  document.getElementById('left').hidden = flow;
  for (const id of ['center', 'right']) document.getElementById(id).hidden = flow && !picked;
  document.getElementById('gaps').hidden = !flow || picked;
  for (const view of ['list', 'flow', 'story']) document.getElementById(`view-${view}`).className = state.view === view ? 'on' : '';
  syncHeaderLocks();
  if (flow) renderFlow();
  else renderLeft();
  if (diagram) renderFlow({ bar: false });
  if (picked || !flow) {
    renderCenter();
    renderRight();
  } else renderGaps();
  recordPlace();
}

const LIST_TABS = ['screens', 'untagged'];

function placeHash({ step = true } = {}) {
  const p = new URLSearchParams();
  if (state.view === 'flow') {
    if (state.flowPicked) p.set('screen', state.selected);
  } else if (state.view === 'story') {
    if (state.composing) p.set('new', '1');
    else if (state.candidate !== null) p.set('candidate', state.candidate);
    else if (state.need !== null) p.set('need', state.need);
    else if (state.story !== null) p.set('story', state.story);
    if (step && !state.composing && state.need === null && state.storyStep?.of === storyPlaceKey(state.candidate, state.story)) p.set('step', String(state.storyStep.step + 1));
  } else if (state.side === 'untagged') {
    if (state.untaggedTest !== null) p.set('test', state.untaggedTest);
  } else if (state.selected !== null) {
    p.set('screen', state.selected);
  }
  return `#${state.view === 'list' ? state.side : state.view}${p.size ? `?${p}` : ''}`;
}

let shownPlace = null;
let applyingPlace = false;

function recordPlace() {
  const hash = placeHash();
  const place = placeHash({ step: false });
  if (hash !== location.hash) {
    if (applyingPlace || shownPlace === null || place === shownPlace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  }
  shownPlace = place;
}

function applyPlace() {
  const [head, query] = location.hash.slice(1).split('?');
  const p = new URLSearchParams(query ?? '');
  let go = render;
  if (head === 'flow' && !p.has('story') && !(p.has('new') && !oldMap())) {
    const screen = p.get('screen');
    go = () => {
      state.flowPicked = screen !== null && flowScreens().some((n) => n.id === screen);
      if (state.flowPicked) {
        if (state.side !== 'screens') state.caseError = null;
        state.side = 'screens';
        if (screen !== state.selected) setSelected(screen);
      }
      state.view = 'flow';
      render();
    };
  } else if (head === 'story' || head === 'stories' || head === 'flow') {
    if (state.view !== 'story') state.caseError = null;
    state.view = 'story';
    const story = p.get('story');
    const candidate = p.get('candidate');
    const need = p.get('need');
    const step = Number(p.get('step'));
    state.storyStep = need === null && Number.isInteger(step) && step > 0
      ? { of: storyPlaceKey(candidate, story), step: step - 1, screen: null }
      : null;
    const storyKnown = state.data.stories.list.some((st) => st.id === story) || unlistedMarks().some((m) => m.target.story === story);
    state.composing = p.has('new') && !oldMap();
    if (state.composing) Object.assign(state, { compose: state.compose ?? newCompose(), candidate: null });
    if (candidate !== null) {
      if (candidate !== state.candidate && state.data.candidates.list.some((c) => c.key === candidate)) go = () => selectCandidate(candidate);
    } else if (need !== null) {
      if (need !== state.need && state.data.needs.list.some((n) => n.file === need)) go = () => selectNeed(need);
    } else if (state.candidate !== null || state.need !== null) go = () => selectStory(storyKnown ? story : state.story);
    else if (story !== state.story && storyKnown) go = () => selectStory(story);
  } else if (LIST_TABS.includes(head)) {
    if (state.view !== 'list' || state.side !== head) state.caseError = null;
    state.view = 'list';
    state.side = head;
    if (head !== 'screens') state.flowPicked = false;
    const screen = p.get('screen');
    const test = p.get('test');
    if (head === 'screens' && screen !== state.selected && screenOf(screen)) go = () => select(screen);
    else if (head === 'untagged' && test !== state.untaggedTest && untaggedTests().some((t) => untaggedKey(t) === test)) go = () => selectUntaggedTest(test);
  }
  applyingPlace = true;
  try {
    go();
  } finally {
    applyingPlace = false;
  }
  if (state.view === 'story' && state.storyStep !== null) showStoryPart({ kind: 'step', key: { step: state.storyStep.step + 1 } });
}

// 한 번에 판단하는 동안에는 화면의 다른 자리도 잠겨 있으므로, 뒤로 가지 않고 지금 자리를 다시 적는다.
window.addEventListener('popstate', () => {
  if (!state.data || state.ended || state.failed) return;
  if (state.bulkBusy) return history.pushState(null, '', placeHash());
  applyPlace();
});

const unsaved = (target, d) => !!d && (d.note.trim() !== '' || (d.status !== null && d.status !== (markOf(target)?.current?.status ?? null)));

function hasUnsavedMark() {
  return unsaved(state.target, state.draft) || unsaved({ story: state.story }, state.storyDraft) || unsaved({ candidate: state.candidate }, state.candidateTalk);
}

function showEnded(message) {
  state.ended = true;
  fill(document.body, h('header', {}, h('h1', {}, 'duru 리뷰')), h('p', { id: 'ended' }, message));
}

// 가운데 칸을 다시 그리면 그 안의 초점이 사라지므로, 한 번에 판단하는 단추만 그 자리에서 잠그거나 푼다.
function setEnding(ending) {
  state.ending = ending;
  syncHeaderLocks();
  for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#center .bulk-bar button'))) button.disabled = bulkButtonOff(state.bulk?.picked.size);
}

async function endReview() {
  if (state.compose?.screens.length && !confirm('저장하지 않은 새 스토리가 있습니다. 「스토리 저장」을 누르지 않으면 스토리 파일이 생기지 않습니다. 그래도 리뷰를 끝낼까요?')) return;
  if (hasUnsavedMark() && !confirm('「남기기」를 누르지 않은 코멘트가 있습니다. 남기지 않으면 작업 목록에 들어가지 않습니다. 그래도 리뷰를 끝낼까요?')) return;
  const error = document.getElementById('end-error');
  error.textContent = '';
  setEnding(true);
  try {
    let res;
    try {
      res = await fetch('/api/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } catch {
      return showEnded('리뷰 페이지 서버가 이미 닫혔습니다. 다른 창에서 리뷰를 끝냈거나 터미널에서 멈춘 것입니다. 이 창은 닫아도 됩니다.');
    }
    if (res.ok) {
      events.close();
      return showEnded('리뷰를 끝냈습니다. 작업 목록은 리뷰 페이지를 띄운 터미널로 넘어갔습니다. 이 창은 닫아도 됩니다.');
    }
    error.textContent = `리뷰를 끝내지 못했습니다: ${await res.text()}`;
  } finally {
    if (!state.ended) setEnding(false);
  }
}

document.getElementById('end-review').addEventListener('click', endReview);
document.getElementById('view-list').addEventListener('click', () => setView('list'));
document.getElementById('view-flow').addEventListener('click', () => setView('flow'));
document.getElementById('view-story').addEventListener('click', () => setView('story'));
function refitFlow() {
  const flow = document.getElementById('flow');
  if (state.ended || flow.hidden || drawnGrid === null) return;
  if (cellsPerRow(drawnGrid.count, drawnGrid.cellW, flowInnerWidth(flow) / state.zoom) !== drawnGrid.per) renderFlow();
}
let resizeFrame = null;
window.addEventListener('resize', () => {
  if (resizeFrame !== null) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    refitFlow();
  });
});

const startWidths = { left: 300, graph: null, right: 360 };
const draggedWidths = { ...startWidths };
const PANE_MIN = { left: 300, graph: 240, center: 360, right: 320 };

// 끌어서 정한 너비는 그대로 두므로 창이 다시 넓어지면 돌아온다.
function fitPanes() {
  const main = document.querySelector('main');
  if (!main || main.hidden) return;
  const flow = main.classList.contains('flow');
  const picked = !flow || main.classList.contains('picked');
  if (!picked) return main.style.removeProperty('grid-template-columns');
  const side = flow ? 'graph' : 'left';
  const keys = [side, 'right'];
  const total = main.clientWidth;
  const want = Object.fromEntries(keys.map((key) => [key, draggedWidths[key]]));
  want[side] ??= Math.max(0, (total - startWidths.right) / 2);
  const room = Object.fromEntries(keys.map((key) => [key, Math.max(0, want[key] - PANE_MIN[key])]));
  const spare = keys.reduce((sum, key) => sum + room[key], 0);
  const over = Math.min(keys.reduce((sum, key) => sum + want[key], 0) + PANE_MIN.center - total, spare);
  if (over > 0) for (const key of keys) want[key] -= over * room[key] / spare;
  main.style.gridTemplateColumns = `${want[side]}px minmax(0, 1fr) ${want.right}px`;
}

window.addEventListener('resize', fitPanes);

for (const sash of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('main > .sash'))) {
  sash.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const main = document.querySelector('main');
    const flow = main.classList.contains('flow');
    const picked = !flow || main.classList.contains('picked');
    const right = sash.id === 'sash-right';
    const key = right ? 'right' : flow ? 'graph' : 'left';
    const cols = getComputedStyle(main).gridTemplateColumns.split(' ').map(parseFloat);
    const from = cols[{ left: 0, graph: 0, right: cols.length - 1 }[key]];
    const middle = picked ? cols.length - 2 : 0;
    const sign = right ? -1 : 1;
    const most = from + cols[middle] - (picked ? PANE_MIN.center : PANE_MIN.graph);
    sash.setPointerCapture(down.pointerId);
    sash.classList.add('dragging');
    document.body.classList.add('pane-dragging');
    const move = (e) => {
      draggedWidths[key] = Math.max(PANE_MIN[key], Math.min(most, from + sign * (e.clientX - down.clientX)));
      window.dispatchEvent(new Event('resize'));
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('lostpointercapture', () => {
      sash.removeEventListener('pointermove', move);
      sash.classList.remove('dragging');
      document.body.classList.remove('pane-dragging');
    }, { once: true });
  });
}

const FIELDS = 'input, textarea, select';
/** @typedef {HTMLInputElement | HTMLTextAreaElement} TextField */
const fieldKey = (f) => [f.localName, f.type, f.name, f.placeholder, f.getAttribute('aria-label'), f.className, f.closest('[id]')?.id].join('|');
const fieldsLike = (key) => [.../** @type {NodeListOf<TextField>} */ (document.querySelectorAll(FIELDS))].filter((f) => fieldKey(f) === key);

// 다시 그리면 입력 칸이 새로 만들어지므로, 쓰던 칸과 생김새가 같은 칸으로 초점과 커서를 돌려 둔다. 같은 생김새의 칸 수가 바뀌었으면 어느 칸인지 알 수 없으므로 돌려 두지 않는다.
function fieldPlace() {
  const field = /** @type {TextField} */ (document.activeElement);
  if (!field?.matches?.(FIELDS)) return null;
  const key = fieldKey(field);
  const alike = fieldsLike(key);
  return { field, key, count: alike.length, index: alike.indexOf(field), caret: field.selectionStart == null ? null : /** @type {[number, number]} */ ([field.selectionStart, field.selectionEnd]) };
}

/** @param {ReturnType<typeof fieldPlace>} place */
function restoreField(place) {
  if (!place || place.field.isConnected) return;
  const alike = fieldsLike(place.key);
  if (alike.length !== place.count) return;
  const field = alike[place.index];
  field.focus();
  if (place.caret && field.selectionStart != null) field.setSelectionRange(...place.caret);
}

// 한글을 조합하는 중에 칸을 바꾸면 쓰던 글자가 끊긴다.
let composingField = null;
let pendingLive = null;
let pendingTimer = null;
const composingNow = () => !!composingField?.isConnected && document.activeElement === composingField;

function deferLive(kind) {
  if (pendingLive !== 'load') pendingLive = kind;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(resumeLive, 500);
}

function resumeLive() {
  clearTimeout(pendingTimer);
  const kind = pendingLive;
  pendingLive = null;
  if (kind === 'load') reloadLive();
  else if (kind === 'draw') drawLive();
}

document.addEventListener('compositionstart', (e) => { composingField = e.target; });
document.addEventListener('compositionend', () => {
  composingField = null;
  if (pendingLive) setTimeout(resumeLive);
});

async function reloadLive() {
  if (!state.data || state.ended || state.failed) return;
  if (composingNow()) return deferLive('load');
  try {
    await load();
  } catch (err) {
    state.error = `새로 남은 코멘트나 바뀐 스토리를 읽지 못했습니다: ${err.message}`;
  }
  drawLive();
}

function drawLive() {
  if (state.ended || state.failed) return;
  if (composingNow()) return deferLive('draw');
  const place = fieldPlace();
  render();
  restoreField(place);
}

// 이 페이지가 저장한 기록의 알림은 저장 뒤의 다시 읽기가 이미 담으므로 건너뛴다. 알림이 저장 응답보다 늦게 올 수도 있어, 아직 오지 않은 것은 기억해 둔다.
let ownSaves = 0;
const heardDuringSave = new Set();
const ownNotHeard = new Set();

async function trackOwnSave(save) {
  ownSaves++;
  let id = null;
  try {
    id = await save();
  } finally {
    ownSaves--;
    if (id !== null && !heardDuringSave.delete(id)) ownNotHeard.add(id);
    if (!ownSaves && heardDuringSave.size) {
      heardDuringSave.clear();
      reloadLive();
    }
  }
}

function heard(event) {
  const { id } = JSON.parse(event.data);
  if (ownNotHeard.delete(id)) return;
  if (ownSaves) return heardDuringSave.add(id);
  reloadLive();
}

// 이 페이지가 스토리를 저장하고 다시 읽는 중에 온 이벤트는 그 읽기가 끝난 뒤에 견준다.
let storiesHeardWhileWriting = null;

function storiesChanged(event) {
  if (state.storyWriting) storiesHeardWhileWriting = event.data;
  else if (event.data !== state.data?.storiesVersion) reloadLive();
}

// 끊겼다가 다시 이어지면 그 사이에 저장된 것을 못 받았을 수 있으므로 다시 읽는다.
const events = new EventSource('/api/events');
let eventsOpened = false;
events.addEventListener('open', () => {
  if (eventsOpened) reloadLive();
  eventsOpened = true;
});
events.addEventListener('message', heard);
events.addEventListener('stories', storiesChanged);
events.addEventListener('end', () => events.close());

// 리뷰를 끝낸 뒤에 늦게 실패한 읽기만 알리지 않고, 그리다 난 오류는 그대로 알린다.
load().then(applyPlace, (err) => {
  if (!state.ended) throw err;
}).catch((err) => {
  state.failed = true;
  document.querySelector('main').hidden = true;
  document.getElementById('flow').hidden = true;
  const failed = document.getElementById('failed');
  failed.textContent = `페이지를 그리지 못했습니다: ${err.message}`;
  failed.hidden = false;
});
