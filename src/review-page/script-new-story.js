// 링크에 조건이 없는 예전 맵으로는 화면 순서를 대조하지 못한다.
const oldMap = () => state.data.map.screens.some((sc) => sc.links.some((l) => !Array.isArray(l.conditions)));
const newCompose = () => ({ screens: [], at: null, selected: null, id: '', name: '', memo: '', checked: null, turn: 0, error: null, refused: null, query: '' });
const flowComposing = () => state.composing && state.view === 'flow';
const composeShown = () => state.composing && state.view !== 'list';
const composeStepsAt = () => (state.view === 'flow' ? '#flow-stories .compose-steps' : '#center');
const checkedCompose = (c) => (c.checked && c.checked.screens.join('\n') === c.screens.join('\n') ? c.checked : null);
const repeatedStep = (screens) => screens.some((id, i) => i > 0 && id === screens[i - 1]);

const newStoryButton = () => (oldMap() ? null : h('button', { class: 'new-story', title: '화면을 차례로 골라 스토리 파일을 새로 만듭니다', onclick: startCompose }, state.compose?.screens.length ? '새 스토리 이어 쓰기' : '새 스토리'));

function startCompose() {
  state.compose ??= newCompose();
  state.composing = true;
  state.candidate = null;
  state.candidateTalk = null;
  state.need = null;
  state.storyError = null;
  if (state.view === 'flow') state.flowPicked = false;
  render();
}

function leaveCompose() {
  state.composing = false;
  state.storyError = null;
  render();
}

function dropCompose() {
  state.compose = null;
  leaveCompose();
}

const canSaveCompose = (c) => STORY_ID.test(c.id) && Boolean(c.name.trim()) && c.screens.length > 0 && !repeatedStep(c.screens);

function composeReach(c) {
  const checked = checkedCompose(c);
  return [
    ...(checked ? reachSection(checked, 'compose') : [h('p', { class: 'muted' }, c.screens.length ? '경로를 맞춰 보는 중입니다.' : '화면을 넣으면 여기에서 끝까지 갈 수 있는지와 사전 조건을 보입니다.')]),
    repeatedStep(c.screens) ? h('p', { class: 'error repeated' }, '같은 화면이 이어진 자리가 있어 저장할 수 없습니다.') : null,
  ];
}

// 이름을 치는 동안 판정이 도착해도 입력 칸은 다시 만들지 않는다. 다시 만들면 조합 중이던 한글이 끊긴다.
// 흐름 그림은 판정이 나온 뒤에 한 번만 다시 그린다.
function renderCompose(focus, { drawing = false, pressed = null } = {}) {
  if (!composeShown()) return;
  if (state.view === 'flow') {
    renderStoryPane();
    if (drawing) renderFlow({ pressed });
  } else {
    renderPickList();
    renderCenter();
    const info = document.getElementById('right-info');
    if (info.querySelector('#compose-reach')) syncComposeForm(info);
    else renderRight();
  }
  if (focus) (focus.map((selector) => document.querySelector(`${composeStepsAt()} ${selector}`)).find((el) => el && !el.disabled))?.focus();
}

async function checkCompose(focus, pressed = null) {
  const c = state.compose;
  const turn = ++c.turn;
  renderCompose(focus, { drawing: !c.screens.length });
  if (!c.screens.length) return;
  let checked = null;
  let error = null;
  try {
    const res = await fetch('/api/stories/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screens: c.screens }) });
    if (!res.ok) throw new Error(await res.text());
    checked = await res.json();
  } catch (err) {
    error = `경로를 맞춰 보지 못했습니다: ${err.message}`;
  }
  if (state.compose !== c || turn !== c.turn) return;
  Object.assign(c, { checked, error });
  renderCompose(focusedStep(), { drawing: true, pressed });
}

const STEP_BUTTONS = ['step-press', 'remove', 'insert-before', 'insert-after', 'insert-cancel'];

function focusedStep() {
  const focused = document.activeElement;
  if (!focused?.closest(composeStepsAt())) return null;
  const cls = focused.matches('button') && STEP_BUTTONS.find((c) => focused.classList.contains(c));
  if (!cls) return focused.matches('.story-path') ? ['.story-path'] : null;
  const step = /** @type {HTMLElement | null} */ (focused.closest('.compose-step'));
  return [step ? `.compose-step[data-step="${step.dataset.step}"] button.${cls}` : `button.${cls}`];
}

function changeCompose(edit, focus, pressed = null) {
  const c = state.compose;
  Object.assign(c, { refused: null, error: null });
  edit(c);
  checkCompose(focus, pressed);
}

function addComposeScreen(id) {
  const c = state.compose;
  const at = c.at ?? c.screens.length;
  if (c.screens[at - 1] === id || c.screens[at] === id) {
    c.refused = '같은 화면을 이어서 넣을 수 없습니다.';
    return renderCompose();
  }
  const box = flowComposing() ? document.querySelector(`#flow .box.screen[data-key="${CSS.escape(id)}"]`)?.getBoundingClientRect() : null;
  changeCompose((d) => {
    d.screens.splice(at, 0, id);
    if (d.at !== null) d.at += 1;
    if (d.selected !== null && d.selected >= at) d.selected += 1;
  }, null, box ? { key: id, top: box.top, left: box.left } : null);
}

function composeStep(id, i, c) {
  const on = c.selected === i;
  const pick = (selected) => {
    c.selected = selected;
    renderCompose([`.compose-step[data-step="${i}"] button.step-press`]);
  };
  return h('div', { class: `step compose-step${on ? ' selected' : ''}`, 'data-step': i, onclick: selectOnClick(on, () => pick(i)) },
    stepPress(i, screenOf(id), id, on, () => pick(on ? null : i)),
    on
      ? h('span', { class: 'step-acts' },
          h('button', { class: 'remove', title: '이 단계를 제외합니다', onclick: () => changeCompose((d) => { d.screens.splice(i, 1); Object.assign(d, { at: null, selected: null }); }, ['.story-path']) }, '제외'))
      : null);
}

function composeCenter() {
  const c = state.compose;
  const checked = checkedCompose(c);
  const mark = insertMark(() => { c.at = null; renderCompose(); });
  const markAt = (at) => {
    c.at = at;
    renderCompose(['.insert-mark button.insert-cancel']);
  };
  const pending = h('div', { class: 'link l-pending' }, c.error ? '판정 못 함' : '맞춰 보는 중');
  return [
    h('div', { class: 'title-row' }, h('h3', {}, c.name.trim() || '새 스토리'), checked ? storyChips(checked) : null),
    h('p', { class: 'muted' }, `${state.view === 'flow' ? '흐름 그림에서 화면 상자를' : '왼쪽 목록에서 화면을'} 누르면 차례로 단계가 됩니다. 단계를 누르면 위아래에 「이전 단계 추가」 · 「다음 단계 추가」가, 단계 안에 「제외」가 나옵니다. 단계를 옮기려면 제외하고 맞는 자리에 다시 넣습니다. 순서를 바꿀 때마다 이웃한 화면 사이의 링크를 다시 맞춰 봅니다.`),
    c.refused ?? c.error ? h('p', { class: 'error compose-error' }, c.refused ?? c.error) : null,
    h('h2', {}, `화면 순서 ${c.screens.length}`),
    c.screens.length
      ? h('div', { class: 'story-path', tabindex: '-1' }, c.screens.flatMap((id, i) => {
          const lines = c.selected === i ? addStepLines(c.at, i, false, markAt) : null;
          return [i > 0 ? (checked ? linkItem(checked.links[i - 1]) : pending.cloneNode(true)) : null, c.at === i ? mark : lines?.before, composeStep(id, i, c), lines?.after, c.at === i + 1 && i + 1 === c.screens.length ? mark : null];
        }))
      : h('p', { class: 'muted no-steps' }, '아직 넣은 화면이 없습니다.'),
  ];
}

function composeForm() {
  const c = state.compose;
  const badId = () => Boolean(c.id) && !STORY_ID.test(c.id);
  const canSave = () => canSaveCompose(c);
  return [
    h('div', { id: 'compose-reach' }, ...composeReach(c)),
    h('h2', {}, '새 스토리 저장'),
    storyForm(
      field('ID', h('input', { type: 'text', id: 'compose-id', value: c.id, oninput: (e) => {
        c.id = e.target.value;
        e.target.nextElementSibling.hidden = !badId();
        syncButton(e, canSave);
      } }), h('small', { class: 'invalid', hidden: !badId() }, '영문 소문자, 숫자, -, _ 만 쓸 수 있습니다.')),
      field('이름', h('input', { type: 'text', id: 'compose-name', value: c.name, oninput: (e) => { c.name = e.target.value; syncButton(e, canSave); } })),
      field('메모', h('textarea', { id: 'compose-memo', oninput: (e) => { c.memo = e.target.value; } }, c.memo)),
      h('button', { class: 'save-compose', disabled: !canSave(), title: '이 화면 순서로 스토리 파일을 씁니다.', onclick: saveCompose }, '스토리 저장'),
      h('button', { class: 'drop-draft', title: '쓰던 순서와 이름을 버리고 스토리 목록으로 돌아갑니다', onclick: dropCompose }, '쓰던 것 버리기')),
    storyErrorLine(),
  ];
}

async function saveCompose() {
  const c = state.compose;
  if (!(await writeStories('/api/stories/add', { id: c.id, name: c.name, memo: c.memo, screens: c.screens }))) return;
  state.compose = null;
  state.composing = false;
  state.view = 'story';
  selectStory(c.id);
}

