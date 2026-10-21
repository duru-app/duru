// 링크에 조건이 없는 예전 맵으로는 화면 순서를 대조하지 못한다.
const oldMap = () => state.data.map.screens.some((sc) => sc.links.some((l) => !Array.isArray(l.conditions)));
const newCompose = () => ({ steps: [], gaps: [], wide: { needs: [], expects: [] }, at: null, selected: null, id: '', name: '', memo: '', checked: null, turn: 0, error: null, refused: null, query: '', editing: null, diagram: 'whole', walked: false, walk: null, pane: null, walkNote: null });
// 앱에서 받은 주소에 맞는 화면이 맵에 없으면 그 경로를 화면 자리에 두고 unmapped 로 표시한다.
const newStep = (screen, more = {}) => ({ screen, rows: { needs: [], inputs: [], expects: [] }, urls: [], skipped: 0, unmapped: false, ...more });
const composeScreens = (c) => c.steps.map((step) => step.screen);
const composeShown = () => state.composing && state.view === 'story';
const composeDiagram = () => composeShown() && !state.compose.walk;
const checkedCompose = (c) => (c.checked && c.checked.screens.join('\n') === composeScreens(c).join('\n') ? c.checked : null);
const repeatedStep = (screens) => screens.some((id, i) => i > 0 && id === screens[i - 1]);

const newStoryButton = () => (oldMap() ? null : h('button', { class: 'new-story', title: '화면을 차례로 골라 스토리 파일을 새로 만듭니다', onclick: startCompose }, state.compose?.steps.length ? '새 스토리 이어 쓰기' : '새 스토리'));

function startCompose() {
  state.compose ??= newCompose();
  state.composing = true;
  state.candidate = null;
  state.candidateTalk = null;
  state.need = null;
  state.storyError = null;
  setView('story');
}

function leaveCompose() {
  state.composing = false;
  state.storyError = null;
  render();
}

function dropCompose() {
  state.compose = null;
  state.composeTalk = null;
  leaveCompose();
}

const canSaveCompose = (c) => STORY_ID.test(c.id) && Boolean(c.name.trim()) && c.steps.length > 0 && !repeatedStep(composeScreens(c)) && !c.walk;

// 흐름 그림은 판정이 나온 뒤에 한 번만 다시 그린다.
function renderCompose(focus, { drawing = false, pressed = null } = {}) {
  if (!composeShown()) return;
  if (composingNow()) return deferLive('draw');
  const place = fieldPlace();
  if (state.compose.walk) renderLeft();
  else {
    renderPickList();
    renderCenter();
  }
  renderRight();
  restoreField(place);
  if (drawing && !state.compose.walk) renderFlow({ bar: false, pressed });
  if (focus) (focus.map((selector) => document.querySelector(`#center ${selector}`)).find((el) => el && !el.disabled))?.focus();
}

async function checkCompose(focus, pressed = null) {
  const c = state.compose;
  const turn = ++c.turn;
  c.gaps = c.gaps.filter(([a, b]) => gapAt(c, a, b) !== null);
  renderCompose(focus, { drawing: !c.steps.length });
  if (!c.steps.length) return;
  let checked = null;
  let error = null;
  try {
    const res = await fetch('/api/stories/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screens: composeScreens(c) }) });
    if (!res.ok) throw new Error(await res.text());
    checked = await res.json();
  } catch (err) {
    error = `경로를 맞춰 보지 못했습니다: ${err.message}`;
  }
  if (state.compose !== c || turn !== c.turn) return;
  Object.assign(c, { checked, error });
  if (checked) c.gaps = c.gaps.filter(([a]) => checked.links[c.steps.indexOf(a)]?.verdict === 'broken');
  renderCompose(focusedStep(), { drawing: true, pressed });
}

const STEP_BUTTONS = ['step-press', 'remove', 'insert-before', 'insert-after', 'insert-cancel'];

function focusedStep() {
  const focused = document.activeElement;
  if (!focused?.closest('#center')) return null;
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

function addComposeScreen(id, fromBox = false) {
  const c = state.compose;
  const at = c.at ?? c.steps.length;
  if (c.steps[at - 1]?.screen === id || c.steps[at]?.screen === id) {
    c.refused = '같은 화면을 이어서 넣을 수 없습니다.';
    return renderCompose();
  }
  const box = fromBox ? document.querySelector(`#flow .box.screen[data-key="${CSS.escape(id)}"]`)?.getBoundingClientRect() : null;
  changeCompose((d) => {
    d.steps.splice(at, 0, newStep(id));
    if (d.at !== null) d.at += 1;
    if (d.selected !== null && d.selected >= at) d.selected += 1;
  }, null, box ? { key: id, top: box.top, left: box.left } : null);
}

function removeComposeStep(i) {
  changeCompose((d) => {
    if (d.editing?.rows === d.steps[i].rows) d.editing = null;
    d.steps.splice(i, 1);
    Object.assign(d, { at: null, selected: null });
  }, ['.story-path']);
}

// ---------- 새 스토리에 적는 조건 · 입력값 · 기대 결과 ----------

const editingRows = (c, rows) => c.editing?.rows === rows;

function rowsWritten(rows) {
  const fields = fieldsToSend(rows);
  return hasWritten(fields) ? fields : null;
}

function composeFieldsButton(c, kind, rows) {
  if (editingRows(c, rows)) return null;
  const written = Boolean(rowsWritten(rows));
  return h('button', {
    type: 'button',
    class: 'edit-fields',
    title: `${FIELDS_TITLE[kind]} ${written ? '고칩니다' : '적습니다'}. 스토리를 저장할 때 함께 씁니다`,
    'aria-label': `${FIELDS_LABEL[kind]} ${written ? '고치기' : '적기'}`,
    onclick: (e) => {
      e.stopPropagation();
      c.editing = { place: { kind }, rows, error: null };
      redrawTable('button.add-line');
    },
  }, PENCIL());
}

function composeFieldsBelow(c, rows, needLabel, expectLabel) {
  if (!editingRows(c, rows)) {
    const fields = rowsWritten(rows);
    return fields ? h('div', { class: 'step-written written', onclick: (e) => e.stopPropagation() }, writtenRows(fields, needLabel, expectLabel, { kind: 'compose' })) : null;
  }
  const edit = c.editing;
  return h('div', { class: 'fields-edit', onclick: (e) => e.stopPropagation() },
    h('fieldset', {},
      FIELD_PARTS[edit.place.kind].map(([key, label]) => fieldsPart(edit, key, label)),
      edit.error ? h('p', { class: 'error fields-error' }, edit.error) : null,
      h('div', { class: 'fields-acts' },
        h('button', { type: 'button', class: 'close-fields', title: '표를 닫습니다. 적은 내용은 스토리를 저장할 때 함께 씁니다', onclick: () => { c.editing = null; renderCenter(); } }, '닫기'))));
}

function composeWide(c) {
  const shown = Boolean(rowsWritten(c.wide)) || editingRows(c, c.wide);
  return h('div', { class: shown ? 'story-wide written' : 'story-wide-blank' },
    h('div', { class: 'story-wide-head' }, h('h2', { class: 'story-wide-name' }, '스토리 전체'), composeFieldsButton(c, 'story', c.wide)),
    composeFieldsBelow(c, c.wide, '조건', '끝난 뒤 기대 결과'));
}

const walkedLines = (step) => [
  step.urls.length ? h('div', { class: 'walked muted mono', title: '앱에서 이 단계에 머문 동안 받은 주소' }, step.urls.join(' → ')) : null,
  step.skipped ? h('div', { class: 'muted skipped-inputs', title: '비밀번호 칸이거나, 안내 글 · 라벨 · 테스트 ID 가 없거나 글로 적을 수 없는 칸이라 값을 적지 않은 입력' }, `값을 적지 않은 입력 ${step.skipped}개`) : null,
];

function composeStep(step, i, c) {
  const on = c.selected === i;
  const pick = (selected) => {
    c.selected = selected;
    renderCompose([`.compose-step[data-step="${i}"] button.step-press`]);
  };
  const sc = screenOf(step.screen);
  const below = [...walkedLines(step), composeFieldsBelow(c, step.rows, '조건', '기대 결과')].filter(Boolean);
  return h('div', { class: `step compose-step${on ? ' selected' : ''}${sc ? '' : ' off-map'}${below.length ? ' has-written' : ''}`, 'data-step': i, onclick: selectOnClick(on, () => pick(i)) },
    stepPress(i, sc, step.screen, on, () => pick(on ? null : i)),
    sc ? null : h('span', { class: 'chip l-off-map' }, '맵에 없는 화면'),
    on
      ? h('span', { class: 'step-acts' },
          h('button', { class: 'remove', title: '이 단계를 제외합니다', onclick: () => removeComposeStep(i) }, '제외'))
      : null,
    composeFieldsButton(c, 'step', step.rows),
    below);
}

const COMPOSE_GUIDE = {
  whole: '왼쪽 목록에서 화면을, 아래 흐름 그림에서 화면 상자를 누르면 차례로 단계가 됩니다. 단계를 누르면 위아래에 「이전 단계 추가」 · 「다음 단계 추가」가, 단계 안에 「제외」가 나옵니다. 단계를 옮기려면 제외하고 맞는 자리에 다시 넣습니다. 순서를 바꿀 때마다 이웃한 화면 사이의 링크를 다시 맞춰 봅니다.',
  line: '왼쪽 목록에서 화면을 누르면 차례로 단계가 됩니다. 아래 그림은 지금 순서를 한 줄로 그린 것이라, 그림의 화면 상자를 눌러 단계로 넣으려면 「전체 그림에서 보기」를 누릅니다. 단계를 누르면 위아래에 「이전 단계 추가」 · 「다음 단계 추가」가, 단계 안에 「제외」가 나옵니다. 순서를 바꿀 때마다 이웃한 화면 사이의 링크를 다시 맞춰 봅니다.',
};

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
    h('div', { class: 'title-row' }, h('h3', {}, c.name.trim() || '새 스토리'), ...(checked ? [walkChip(checked), ...reachChips(checked)] : []), walkStart()),
    h('p', { class: 'muted' }, COMPOSE_GUIDE[c.diagram]),
    c.walkNote ? h('p', { class: `walk-note ${c.walkNote.error ? 'error' : 'muted'}` }, c.walkNote.text) : null,
    c.refused ?? c.error ? h('p', { class: 'error compose-error' }, c.refused ?? c.error) : null,
    checked ? needsFold(checked, 'compose') : waitingLine(c.steps, c.error),
    repeatedStep(composeScreens(c)) ? h('p', { class: 'error repeated' }, '같은 화면이 이어진 자리가 있어 저장할 수 없습니다.') : null,
    h('div', { class: 'story-save' }, ...composeForm()),
    composeWide(c),
    h('h2', {}, `화면 순서 ${c.steps.length}`),
    c.steps.length
      ? h('div', { class: 'story-path', tabindex: '-1' }, c.steps.flatMap((step, i) => {
          const lines = c.selected === i ? addStepLines(c.at, i, false, markAt) : null;
          return [i > 0 ? (checked ? linkItem(checked.links[i - 1], undefined, i - 1, undefined, gapPick(c, i)) : pending.cloneNode(true)) : null, c.at === i ? mark : lines?.before, composeStep(step, i, c), lines?.after, c.at === i + 1 && i + 1 === c.steps.length ? mark : null];
        }))
      : h('p', { class: 'muted no-steps' }, '아직 넣은 화면이 없습니다.'),
  ];
}

function composeForm() {
  const c = state.compose;
  const badId = () => Boolean(c.id) && !STORY_ID.test(c.id);
  const canSave = () => canSaveCompose(c);
  return [
    h('h2', {}, '새 스토리 저장'),
    storyForm(
      field('ID', h('input', { type: 'text', id: 'compose-id', name: 'compose-id', value: c.id, oninput: (e) => {
        c.id = e.target.value;
        e.target.nextElementSibling.hidden = !badId();
        syncButton(e, canSave);
      } }), h('small', { class: 'invalid', hidden: !badId() }, '영문 소문자, 숫자, -, _ 만 쓸 수 있습니다.')),
      field('이름', h('input', { type: 'text', id: 'compose-name', name: 'compose-name', value: c.name, oninput: (e) => { c.name = e.target.value; syncButton(e, canSave); } })),
      field('메모', h('textarea', { id: 'compose-memo', name: 'compose-memo', oninput: (e) => { c.memo = e.target.value; } }, c.memo)),
      h('button', { class: 'save-compose', disabled: !canSave(), title: c.walk ? '「기록 끝」을 누른 뒤에 저장합니다.' : '이 화면 순서로 스토리 파일을 씁니다.', onclick: saveCompose }, '스토리 저장'),
      h('button', { class: 'drop-draft', disabled: Boolean(c.walk), title: c.walk ? '「기록 끝」을 누른 뒤에 버립니다' : '쓰던 순서와 이름을 버리고 스토리 목록으로 돌아갑니다', onclick: dropCompose }, '쓰던 것 버리기')),
    storyErrorLine(),
  ];
}

function gapAt(c, a, b) {
  const k = c.steps.indexOf(a) + 1;
  return k > 0 && c.steps[k] === b ? k : null;
}

function gapPick(c, k) {
  const [a, b] = [c.steps[k - 1], c.steps[k]];
  const isOn = () => c.gaps.some((g) => g[0] === a && g[1] === b);
  const flip = (focus) => {
    const at = gapAt(c, a, b);
    if (at === null) return;
    const on = !isOn();
    c.gaps = on ? [...c.gaps, [a, b]] : c.gaps.filter((g) => g[0] !== a || g[1] !== b);
    pressGapChips(at - 1, on);
    renderCompose(focus ? [`.link[data-hop="${at - 1}"] button.gap-pick`] : null);
  };
  return { on: isOn(), toggle: () => flip(true), toggleInFlow: () => flip(false) };
}

const writtenFields = (rows) => Object.fromEntries(Object.entries(rowsWritten(rows) ?? {}).filter(([, list]) => list.length));

function composeTarget() {
  const c = state.compose;
  if (!c?.steps.length) return null;
  const gaps = c.gaps.map(([a]) => c.steps.indexOf(a) + 1).sort((a, b) => a - b).map((k) => [k, k + 1]);
  const steps = c.steps.flatMap((step, i) => (rowsWritten(step.rows) ? [{ step: i + 1, ...writtenFields(step.rows) }] : []));
  return { screens: composeScreens(c), ...(gaps.length && { gaps }), ...(steps.length && { steps }) };
}

function sentStep(step) {
  const fields = rowsWritten(step.rows);
  return fields ? { screen: step.screen, ...writtenFields(step.rows) } : step.screen;
}

function unpickedCompose(c) {
  const at = (kind, rows, where) => {
    const unpicked = unpickedLine({ place: { kind }, rows });
    return unpicked && `${where} ${unpicked}`;
  };
  return at('story', c.wide, '스토리 전체:') ?? c.steps.map((step, i) => at('step', step.rows, `${i + 1} 번째 단계:`)).find(Boolean) ?? null;
}

async function saveCompose() {
  const c = state.compose;
  const unpicked = unpickedCompose(c);
  if (unpicked) {
    state.storyError = `저장하지 않았습니다: ${unpicked}`;
    return redrawStory();
  }
  const { needs, expects } = fieldsToSend(c.wide);
  if (!(await writeStories('/api/stories/add', { id: c.id, name: c.name, memo: c.memo, needs, expects, screens: c.steps.map(sentStep) }))) return;
  state.compose = null;
  state.composeTalk = null;
  state.composing = false;
  state.view = 'story';
  selectStory(c.id);
}
