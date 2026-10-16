function setView(view) {
  if (!state.data || state.failed) return;
  state.view = view;
  if (state.composing && view === 'list') state.side = 'stories';
  if (state.composing && view === 'flow') {
    state.flowPicked = false;
    leaveStoryPath();
  }
  render();
}

// 데이터를 읽지 못한 페이지에서도 리뷰를 끝낼 수 있어야 하므로, 위쪽 단추의 잠금은 읽어 온 데이터 없이 맞춘다.
function syncHeaderLocks() {
  /** @type {HTMLButtonElement} */ (document.getElementById('view-list')).disabled = state.bulkBusy;
  /** @type {HTMLButtonElement} */ (document.getElementById('view-flow')).disabled = state.bulkBusy;
  /** @type {HTMLButtonElement} */ (document.getElementById('end-review')).disabled = state.bulkBusy || state.ending;
}

function render() {
  if (state.ended || state.failed) return;
  pickables = [];
  renderHeader();
  const flow = state.view === 'flow';
  // 고른 화면이 그림에 없으면 오른쪽 칸과 그림이 서로 다른 화면을 가리키므로 선택을 해제한다.
  if (flow && state.flowPicked && !drawnScreens().some((n) => n.id === state.selected)) state.flowPicked = false;
  const picked = flow && state.flowPicked;
  const stories = flow ? pathStories().length : 0;
  const listed = flow && storiesListed();
  const folded = listed && state.storiesFolded;
  const main = document.querySelector('main');
  main.classList.toggle('flow', flow);
  main.classList.toggle('picked', picked);
  main.classList.toggle('with-stories', listed);
  main.classList.toggle('stories-folded', folded);
  const pane = document.getElementById('flow-stories');
  pane.hidden = !listed;
  pane.inert = folded;
  document.getElementById('flow-head').hidden = !listed;
  const tab = document.getElementById('stories-tab');
  tab.textContent = `스토리 ${stories} ${folded ? '▶' : '◀'}`;
  tab.title = folded ? '스토리 목록 펴기' : '스토리 목록 접기';
  tab.setAttribute('aria-expanded', String(!folded));
  fitPanes();
  for (const id of ['flow-bar', 'flow']) document.getElementById(id).hidden = !flow;
  document.getElementById('left').hidden = flow;
  for (const id of ['center', 'right']) document.getElementById(id).hidden = flow && !picked;
  document.getElementById('gaps').hidden = !flow || picked;
  document.getElementById('view-list').className = flow ? '' : 'on';
  document.getElementById('view-flow').className = flow ? 'on' : '';
  syncHeaderLocks();
  renderStoryPane();
  if (flow) renderFlow();
  else renderLeft();
  if (picked || !flow) {
    renderCenter();
    renderRight();
  } else renderGaps();
  recordPlace();
}

const PLACE_TABS = ['screens', 'stories', 'untagged'];

function placeHash() {
  const p = new URLSearchParams();
  if (state.view === 'flow') {
    if (state.composing) p.set('new', '1');
    if (state.storyPath) p.set('story', state.storyPath.id);
    if (state.flowPicked) p.set('screen', state.selected);
  } else if (state.side === 'stories') {
    if (state.composing) p.set('new', '1');
    else if (state.candidate !== null) p.set('candidate', state.candidate);
    else if (state.need !== null) p.set('need', state.need);
    else if (state.story !== null) p.set('story', state.story);
  } else if (state.side === 'untagged') {
    if (state.untaggedTest !== null) p.set('test', state.untaggedTest);
  } else if (state.selected !== null) {
    p.set('screen', state.selected);
  }
  return `#${state.view === 'flow' ? 'flow' : state.side}${p.size ? `?${p}` : ''}`;
}

let shownPlace = null;
let applyingPlace = false;

// 주소창이 아니라 직전에 그린 자리와 비교하므로, 같은 자리를 다시 그려도 방문 기록이 늘지 않는다.
function recordPlace() {
  const hash = placeHash();
  if (applyingPlace || shownPlace === null) {
    if (hash !== location.hash) history.replaceState(null, '', hash);
  } else if (hash !== shownPlace) {
    if (hash !== location.hash) history.pushState(null, '', hash);
  }
  shownPlace = hash;
}

// 화면에서 그 자리를 누른 것과 같게 움직인다.
function applyPlace() {
  const [head, query] = location.hash.slice(1).split('?');
  const p = new URLSearchParams(query ?? '');
  let go = render;
  if (head === 'flow') {
    const composing = p.has('new') && !oldMap();
    const story = !composing && pathStories().some((st) => st.id === p.get('story')) ? p.get('story') : null;
    const screen = composing ? null : p.get('screen');
    go = () => {
      state.composing = composing;
      if (composing) Object.assign(state, { compose: state.compose ?? newCompose(), candidate: null });
      if (story) {
        if (state.storyPath?.id !== story) showStoryPath(story);
      } else if (state.storyPath) leaveStoryPath();
      state.flowPicked = screen !== null && drawnScreens().some((n) => n.id === screen);
      if (state.flowPicked) {
        if (state.side !== 'screens') state.caseError = null;
        state.side = 'screens';
        if (screen !== state.selected) setSelected(screen);
        ringScreen(screen);
      } else if (state.storyPath) state.storyPath.ring = null;
      state.view = 'flow';
      render();
    };
  } else if (PLACE_TABS.includes(head)) {
    state.view = 'list';
    if (state.side !== head) state.caseError = null;
    state.side = head;
    if (head !== 'screens') state.flowPicked = false;
    const screen = p.get('screen');
    const story = p.get('story');
    const candidate = p.get('candidate');
    const need = p.get('need');
    const test = p.get('test');
    const storyKnown = state.data.stories.list.some((st) => st.id === story) || unlistedMarks().some((m) => m.target.story === story);
    state.composing = head === 'stories' && p.has('new') && !oldMap();
    if (state.composing) Object.assign(state, { compose: state.compose ?? newCompose(), candidate: null });
    if (head === 'screens' && screen !== state.selected && screenOf(screen)) go = () => select(screen);
    else if (head === 'stories' && candidate !== null) {
      if (candidate !== state.candidate && state.data.candidates.list.some((c) => c.key === candidate)) go = () => selectCandidate(candidate);
    } else if (head === 'stories' && need !== null) {
      if (need !== state.need && state.data.needs.list.some((n) => n.file === need)) go = () => selectNeed(need);
    } else if (head === 'stories' && (state.candidate !== null || state.need !== null)) go = () => selectStory(storyKnown ? story : state.story);
    else if (head === 'stories' && story !== state.story && storyKnown) go = () => selectStory(story);
    else if (head === 'untagged' && test !== state.untaggedTest && untaggedTests().some((t) => untaggedKey(t) === test)) go = () => selectUntaggedTest(test);
  }
  applyingPlace = true;
  try {
    go();
  } finally {
    applyingPlace = false;
  }
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

const startWidths = { left: 300, stories: 300, graph: null, right: 360 };
const draggedWidths = { ...startWidths };
const PANE_MIN = { left: 300, stories: 240, graph: 240, center: 360, right: 320 };
const GAPS_WIDTH = 360;

// 끌어서 정한 너비는 그대로 두므로 창이 다시 넓어지면 돌아온다.
function fitPanes() {
  const main = document.querySelector('main');
  if (!main || main.hidden) return;
  const flow = main.classList.contains('flow');
  const picked = !flow || main.classList.contains('picked');
  const listed = flow && main.classList.contains('with-stories');
  const folded = listed && state.storiesFolded;
  if (!picked && !listed) return main.style.removeProperty('grid-template-columns');
  const side = flow ? 'graph' : 'left';
  const keys = [listed && !folded ? 'stories' : null, ...(picked ? [side, 'right'] : [])].filter(Boolean);
  const total = main.clientWidth;
  const fixed = picked ? 0 : GAPS_WIDTH;
  const want = Object.fromEntries(keys.map((key) => [key, draggedWidths[key]]));
  if (picked) want[side] ??= Math.max(0, (total - fixed - (want.stories ?? 0) - startWidths.right) / 2);
  const room = Object.fromEntries(keys.map((key) => [key, Math.max(0, want[key] - PANE_MIN[key])]));
  const spare = keys.reduce((sum, key) => sum + room[key], 0);
  const over = Math.min(keys.reduce((sum, key) => sum + want[key], 0) + fixed + (picked ? PANE_MIN.center : PANE_MIN.graph) - total, spare);
  if (over > 0) for (const key of keys) want[key] -= over * room[key] / spare;
  const first = listed ? [`${folded ? 0 : want.stories}px`] : [];
  main.style.gridTemplateColumns = [...first, ...(picked ? [`${want[side]}px`, 'minmax(0, 1fr)', `${want.right}px`] : ['minmax(0, 1fr)', `${GAPS_WIDTH}px`])].join(' ');
}

window.addEventListener('resize', fitPanes);
document.getElementById('stories-tab').addEventListener('click', foldStories);

for (const sash of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('main > .sash'))) {
  sash.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const main = document.querySelector('main');
    const flow = main.classList.contains('flow');
    const picked = !flow || main.classList.contains('picked');
    const right = sash.id === 'sash-right';
    const key = sash.id === 'sash-stories' ? 'stories' : right ? 'right' : flow ? 'graph' : 'left';
    const cols = getComputedStyle(main).gridTemplateColumns.split(' ').map(parseFloat);
    const shift = main.classList.contains('with-stories') ? 1 : 0;
    const from = cols[{ stories: 0, left: 0, graph: shift, right: cols.length - 1 }[key]];
    const middle = picked ? cols.length - 2 : shift;
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
