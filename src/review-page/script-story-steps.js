const newStepsEdit = (st) => ({
  story: st.id,
  contentHash: st.contentHash,
  changedHash: null,
  steps: st.steps.map((s, i) => ({ key: nextRowKey(), step: i + 1, screen: s.screen, fields: st.stepFields?.[i] ?? {} })),
  at: null,
  selected: null,
  refused: null,
  removing: null,
  checked: st,
  turn: 0,
  error: null,
  saveError: null,
  saving: false,
  query: '',
});

function openSteps() {
  const edit = state.stepsEdit;
  return edit && edit.story === state.story && !state.composing && state.candidate === null && state.need === null && storyById(edit.story) ? edit : null;
}

function dropLostSteps() {
  const edit = state.stepsEdit;
  if (!edit || storyById(edit.story)) return;
  state.stepsEdit = null;
  state.storyError = `스토리 ${edit.story} 가 없어져 고치던 화면 순서를 닫았습니다. 고친 순서는 저장하지 않았습니다.`;
}

const stepScreens = (e) => e.steps.map((s) => s.screen);
const checkedSteps = (e) => (e.checked && e.checked.screens.join('\n') === stepScreens(e).join('\n') ? e.checked : null);
const unchangedSteps = (e) => e.steps.every((s, i) => s.step === i + 1) && e.steps.length === storyById(e.story).steps.length;
const linkKept = (e, i) => i > 0 && e.steps[i].step !== undefined && e.steps[i - 1].step === e.steps[i].step - 1;
const lostLinkNeeds = (e, i) => (linkKept(e, i) ? 0 : e.steps[i].fields.linkNeeds?.length ?? 0);
const keptFields = (e, i) => (linkKept(e, i) ? e.steps[i].fields : { ...e.steps[i].fields, linkNeeds: undefined });

const fieldWords = (f) => [
  f.needs?.length && `조건 ${f.needs.length}개`,
  f.inputs?.length && `입력값 ${f.inputs.length}개`,
  f.expects?.length && `기대 결과 ${f.expects.length}개`,
  f.linkNeeds?.length && `들어오는 링크 조건 ${f.linkNeeds.length}개`,
].filter(Boolean).join(' · ');

function removeLoss(e, i) {
  const own = fieldWords(keptFields(e, i));
  const next = e.steps[i + 1];
  const nextLinks = next && linkKept(e, i + 1) ? next.fields.linkNeeds?.length ?? 0 : 0;
  return [own && `이 단계에 적은 ${own}`, nextLinks && `다음 단계로 들어오는 링크 조건 ${nextLinks}개`].filter(Boolean).join('와 ');
}

function stepsProblem(e) {
  if (!e.steps.length) return '단계가 하나도 없어 저장할 수 없습니다.';
  return repeatedStep(stepScreens(e)) ? '같은 화면이 이어진 자리가 있어 저장할 수 없습니다.' : null;
}

function startSteps() {
  const st = storyOf();
  state.stepsEdit = newStepsEdit(st);
  state.stepsSaved = null;
  render();
  document.querySelector('#center .path-head')?.scrollIntoView({ block: 'nearest' });
}

function cancelSteps() {
  state.stepsEdit = null;
  render();
}

function renderSteps() {
  const e = openSteps();
  if (!e || state.view !== 'story' || !document.getElementById('pick-list')) return;
  renderPickList();
  renderCenter();
  const reach = document.querySelector('#right-info #steps-reach');
  if (reach) fill(reach, ...stepsReach(e));
  else renderRight();
}

async function checkSteps() {
  const e = state.stepsEdit;
  const turn = ++e.turn;
  renderSteps();
  if (!e.steps.length || checkedSteps(e)) return;
  let checked = null;
  let error = null;
  try {
    const res = await fetch('/api/stories/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screens: stepScreens(e) }) });
    if (!res.ok) throw new Error(await res.text());
    checked = await res.json();
  } catch (err) {
    error = `경로를 맞춰 보지 못했습니다: ${err.message}`;
  }
  if (state.stepsEdit !== e || turn !== e.turn) return;
  Object.assign(e, { checked, error });
  renderSteps();
}

function changeSteps(edit) {
  const e = state.stepsEdit;
  Object.assign(e, { refused: null, removing: null, error: null, saveError: null });
  edit(e);
  checkSteps();
}

function addStepsScreen(id) {
  const e = state.stepsEdit;
  if (e.saving) return;
  const at = e.at ?? e.steps.length;
  if (e.steps[at - 1]?.screen === id || e.steps[at]?.screen === id) {
    e.refused = '같은 화면을 이어서 넣을 수 없습니다.';
    return renderSteps();
  }
  changeSteps((d) => {
    d.steps.splice(at, 0, { key: nextRowKey(), screen: id, fields: {} });
    if (d.at !== null) d.at += 1;
  });
}

function removeStep(e, i, confirmed = false) {
  if (e.saving) return;
  if (removeLoss(e, i) && !confirmed) {
    e.removing = e.steps[i].key;
    return renderSteps();
  }
  changeSteps((d) => {
    d.steps.splice(i, 1);
    d.at = null;
    d.selected = null;
  });
  /** @type {HTMLElement | null} */ (document.querySelector('#center .story-path'))?.focus();
}

const lostLine = (n, first) => h('p', { class: 'error link-lost' }, `${first ? '첫 단계가 되어' : '앞 단계가 바뀌어'}, 저장하면 들어오는 링크 조건 ${n}개가 지워집니다.`);

const insertMark = (cancel) => h('div', { class: 'insert-mark' }, '다음에 고르는 화면이 여기 들어갑니다',
  h('button', { type: 'button', class: 'insert-cancel', title: '표시를 지웁니다. 다음에 고르는 화면은 끝에 들어갑니다', onclick: cancel }, '취소'));

const addStepLine = (cls, label, title, disabled, onclick) => h('button', { type: 'button', class: `add-step ${cls}`, disabled, title, onclick }, `+ ${label}`);

const stepHead = (sc, id) => (sc
  ? [h('span', { class: 'screen-path' }, sc.path), ' ', h('span', { class: 'muted' }, sc.component), h('span', { class: 'muted mono screen-id' }, sc.id)]
  : h('span', { class: 'muted mono' }, id));

const stepPress = (i, sc, id, on, toggle) => h('button', { type: 'button', class: 'step-press', 'aria-pressed': String(on), onclick: toggle },
  h('span', { class: 'no' }, i + 1),
  h('span', { class: 'name' }, stepHead(sc, id)));

const selectOnClick = (on, select) => (ev) => {
  if (on || /** @type {Element} */ (ev.target).closest('button, a, input, textarea, select, summary') || window.getSelection()?.toString()) return;
  select();
};

function addStepLines(at, i, disabled, mark) {
  return {
    before: at === i ? null : addStepLine('insert-before', '이전 단계 추가', '다음에 고르는 화면을 이 단계 앞에 넣습니다', disabled, () => mark(i)),
    after: at === i + 1 ? null : addStepLine('insert-after', '다음 단계 추가', '다음에 고르는 화면을 이 단계 뒤에 넣습니다', disabled, () => mark(i + 1)),
  };
}

function pickStepsCard(e, i, key) {
  if (e.selected !== key) Object.assign(e, { selected: key, removing: null });
  renderSteps();
  /** @type {HTMLElement | null} */ (document.querySelector(`#center .story-path > .step[data-step="${i}"] button.step-press`))?.focus();
}

function markSteps(e, at) {
  Object.assign(e, { at, refused: null });
  renderSteps();
  /** @type {HTMLElement | null} */ (document.querySelector('#center .insert-mark button.insert-cancel'))?.focus();
}

function stepsCard(e, i) {
  const s = e.steps[i];
  const on = e.selected === s.key;
  const written = hasWritten(s.fields) ? h('div', { class: 'step-written written' }, writtenRows(s.fields, '조건', '기대 결과')) : null;
  const lost = i === 0 && lostLinkNeeds(e, i) ? lostLine(lostLinkNeeds(e, i), true) : null;
  const warn = e.removing === s.key
    ? h('div', { class: 'remove-warn' },
        h('span', {}, `제외하면 ${removeLoss(e, i)}도 함께 지워집니다.`),
        h('button', { type: 'button', class: 'remove-anyway', onclick: () => removeStep(e, i, true) }, '제외'),
        h('button', { type: 'button', class: 'keep', onclick: () => { e.removing = null; renderSteps(); } }, '취소'))
    : null;
  return h('div', { class: `step order-step${on ? ' selected' : ''}${s.step === undefined ? ' new-step' : ''}${written || lost || warn ? ' has-written' : ''}`, 'data-step': i, onclick: selectOnClick(on, () => pickStepsCard(e, i, s.key)) },
    stepPress(i, screenOf(s.screen), s.screen, on, () => pickStepsCard(e, i, on ? null : s.key)),
    on
      ? h('span', { class: 'step-acts' },
          h('button', { type: 'button', class: 'remove', disabled: e.saving, title: removeLoss(e, i) ? `이 단계를 제외합니다. ${removeLoss(e, i)}도 함께 지워집니다` : '이 단계를 제외합니다', onclick: () => removeStep(e, i) }, '제외'))
      : null,
    written,
    lost,
    warn);
}

function stepsLink(e, i, checked) {
  const fields = keptFields(e, i);
  const row = checked
    ? linkItem(checked.links[i - 1], null, i - 1, fields)
    : h('div', { class: 'link l-pending' }, e.error ? '판정 못 함' : '맞춰 보는 중', linkWritten(fields));
  if (lostLinkNeeds(e, i)) row.append(lostLine(lostLinkNeeds(e, i), false));
  return row;
}

function stepsPath(e) {
  const checked = checkedSteps(e);
  const mark = insertMark(() => { e.at = null; renderSteps(); });
  return [
    h('div', { class: 'path-head' }, h('h2', {}, `화면 순서 ${e.steps.length}`), h('span', { class: 'editing-note' }, '순서 고치는 중')),
    h('p', { class: 'muted' }, '왼쪽 목록에서 화면을 누르면 표시한 자리에, 표시가 없으면 끝에 단계로 들어갑니다. 단계를 누르면 위아래에 「이전 단계 추가」 · 「다음 단계 추가」가, 단계 안에 「제외」가 나옵니다. 단계를 옮기려면 제외하고 맞는 자리에 다시 넣습니다. 남긴 단계의 조건 · 입력값 · 기대 결과는 그 단계에 그대로 남습니다. 순서를 바꿀 때마다 이웃한 화면 사이의 링크를 다시 맞춰 봅니다.'),
    e.refused ?? e.error ? h('p', { class: 'error steps-refused' }, e.refused ?? e.error) : null,
    e.steps.length
      ? h('div', { class: 'story-path', tabindex: '-1' }, e.steps.flatMap((s, i) => {
          const lines = s.key === e.selected ? addStepLines(e.at, i, e.saving, (at) => markSteps(e, at)) : null;
          return [i > 0 ? stepsLink(e, i, checked) : null, e.at === i ? mark : lines?.before, stepsCard(e, i), lines?.after, e.at === i + 1 && i + 1 === e.steps.length ? mark : null];
        }))
      : h('p', { class: 'muted no-steps' }, '단계가 하나도 없습니다.'),
  ];
}

function reorderButton() {
  if (oldMap()) return null;
  const busy = Boolean(openTable());
  return h('button', {
    type: 'button',
    class: 'reorder',
    disabled: busy,
    title: busy ? '열린 표를 저장하거나 취소한 뒤에 순서를 고칩니다' : '단계를 빼거나 화면을 더 넣습니다',
    onclick: startSteps,
  }, '순서 고치기');
}

function savedStoryPath(st) {
  const e = openSteps();
  if (e) return stepsPath(e);
  const [head, path] = storyPath(st, null, st.id);
  return [
    h('div', { class: 'path-head' }, head, reorderButton()),
    state.stepsSaved?.story === st.id ? h('p', { class: 'steps-saved muted' }, `스토리 파일 ${state.stepsSaved.file} 에 썼습니다`) : null,
    path,
  ];
}

function stepsButtons(e) {
  const problem = stepsProblem(e);
  const unchanged = unchangedSteps(e);
  return [
    problem ? h('p', { class: 'error steps-problem' }, problem) : null,
    e.saveError ? h('p', { class: 'error steps-error' }, e.saveError) : null,
    storyForm(h('div', { class: 'accepts' },
      e.changedHash === null
        ? h('button', { type: 'button', class: 'save-steps', disabled: Boolean(problem) || unchanged || e.saving, title: unchanged ? '아직 바꾼 것이 없습니다' : '스토리 파일의 screens 를 이 순서로 고쳐 씁니다.', onclick: saveSteps }, '순서 저장')
        : [
          h('button', { type: 'button', class: 'reread-steps', title: '바뀐 스토리 파일의 순서를 불러오고, 고친 순서는 버립니다', onclick: rereadSteps }, '새로 읽기'),
          h('button', { type: 'button', class: 'overwrite-steps', disabled: Boolean(problem), title: '다른 곳에서 바뀐 스토리 파일의 screens 를 이 순서로 덮어씁니다', onclick: overwriteSteps }, '덮어쓰기'),
        ],
      h('button', { type: 'button', class: 'drop-draft cancel-steps', disabled: e.saving, title: '고친 순서를 버리고 저장한 순서로 돌아갑니다', onclick: cancelSteps }, '취소'))),
  ];
}

function stepsReach(e) {
  const checked = checkedSteps(e);
  const waiting = h('p', { class: 'muted' }, !e.steps.length ? '화면을 넣으면 여기에서 끝까지 갈 수 있는지와 사전 조건을 보입니다.' : e.error ? '판정 못 함' : '경로를 맞춰 보는 중입니다.');
  const [verdicts, skipped, ...conditions] = checked ? reachSection(checked, `story\n${e.story}`) : [waiting, null];
  return [h('div', { class: 'steps-top' }, verdicts, skipped, ...stepsButtons(e)), ...conditions];
}

const stepsFileStory = (st) => {
  const e = openSteps();
  return e ? { ...st, steps: e.steps.map((s) => ({ screen: s.screen })), stepFields: e.steps.map((_, i) => keptFields(e, i)) } : st;
};

function rereadSteps() {
  state.stepsEdit = newStepsEdit(storyById(state.stepsEdit.story));
  render();
}

function overwriteSteps() {
  const e = state.stepsEdit;
  e.contentHash = e.changedHash;
  saveSteps();
}

async function saveSteps() {
  const e = state.stepsEdit;
  if (e.saving) return;
  Object.assign(e, { saveError: null, changedHash: null, saving: true });
  renderSteps();
  const steps = e.steps.map((s) => (s.step === undefined ? { screen: s.screen } : { step: s.step, screen: s.screen }));
  const { written, reread, error } = await writeOverRead('/api/stories/steps', { id: e.story, steps, contentHash: e.contentHash });
  e.saving = false;
  if (written) {
    state.stepsEdit = null;
    state.stepsSaved = { story: e.story, file: written.file };
    state.error = error;
  } else {
    if (reread) e.changedHash = storyById(e.story)?.contentHash ?? null;
    e.saveError = error;
  }
  render();
}
