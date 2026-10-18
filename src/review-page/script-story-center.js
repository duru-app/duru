const storyPath = (st, stepRanges, story) => [
  h('h2', {}, `화면 순서 ${st.steps.length}`),
  h('div', { class: 'story-path' }, st.steps.flatMap((step, i) => [i > 0 ? linkItem(st.links[i - 1], story, i - 1, st.stepFields?.[i]) : null, stepItem(step, i, stepRanges?.[i], story, st.stepFields?.[i])])),
];

function storyWide(st) {
  const place = { kind: 'story' };
  const written = hasWritten(st);
  return h('div', { class: written || editingAt(st.id, place) ? 'story-wide written' : 'story-wide-blank' },
    h('div', { class: 'story-wide-head' }, h('h2', { class: 'story-wide-name' }, '스토리 전체'), fieldsButton(st.id, place, written)),
    fieldsBelow(st.id, place, written ? writtenRows(st, '조건', '끝난 뒤 기대 결과') : null));
}

function savedStory(st) {
  const screens = st.steps.map((step, i) => (hasWritten(st.stepFields?.[i]) || st.stepFields?.[i]?.linkNeeds?.length ? { screen: step.screen, ...st.stepFields[i] } : step.screen));
  const { needs, expects, memo, author, date, source } = st;
  return { name: st.name, needs, screens, expects, memo, author, date, source };
}

const storyFile = (st) => h('details', { class: 'story-file', open: state.storyFileOpen, ontoggle: (e) => { state.storyFileOpen = e.target.open; } },
  h('summary', {}, `스토리 파일 ${st.file}`),
  h('p', { class: 'muted' }, 'duru 가 읽은 내용을 파일 모양으로 다시 적었습니다. 조건, 들어오는 링크 조건, 입력값이나 기대 결과가 있는 단계는 { "screen", "needs", "linkNeeds", "inputs", "expects" } 객체로, 없는 단계는 화면 ID 글자로 적습니다.'),
  h('pre', { class: 'mono' }, JSON.stringify(savedStory(st), null, 2)));

const storyName = (id) => state.data.stories.list.find((st) => st.id === id)?.name ?? id;

function needEditor(n) {
  const edit = state.needEdit?.file === n.file ? state.needEdit : null;
  if (!edit) {
    return [
      h('button', { type: 'button', class: 'edit-need', title: '공통 조건 파일의 이름과 내용을 고칩니다. 스토리는 파일 이름으로 고르므로 이름을 바꿔도 그대로 이어집니다.', onclick: () => openNeedEdit(n) }, '고치기'),
      state.needSaved === n.file ? h('p', { class: 'need-saved muted' }, `공통 조건 파일 ${needPath(n.file)} 에 썼습니다`) : null,
    ];
  }
  return [h('fieldset', { class: 'story-form need-edit', disabled: edit.saving },
    field('이름', h('input', { type: 'text', id: 'need-name', value: edit.name, oninput: (e) => { edit.name = e.target.value; } })),
    field('내용', h('textarea', { id: 'need-text', rows: 4, oninput: (e) => { edit.text = e.target.value; } }, edit.text)),
    edit.error ? h('p', { class: 'error need-error' }, edit.error) : null,
    h('div', { class: 'fields-acts' },
      edit.changedHash === null
        ? h('button', { type: 'button', class: 'save-need', title: '공통 조건 파일에 고쳐 씁니다', onclick: saveNeed }, '저장')
        : [
          h('button', { type: 'button', class: 'reread-need', title: '바뀐 공통 조건 파일의 이름과 내용을 불러오고, 적던 내용은 버립니다', onclick: () => openNeedEdit(n) }, '새로 읽기'),
          h('button', { type: 'button', class: 'overwrite-need', title: '다른 곳에서 바뀐 공통 조건 파일을 적은 이름과 내용으로 덮어씁니다', onclick: overwriteNeed }, '덮어쓰기'),
        ],
      h('button', { type: 'button', class: 'cancel-need', title: '공통 조건 파일은 그대로 둡니다', onclick: cancelNeedEdit }, '취소')))];
}

function dropLostNeed() {
  if (needOf()) return;
  const edit = state.need !== null && state.needEdit?.file === state.need ? state.needEdit : null;
  Object.assign(state, { need: null, needEdit: null });
  if (edit) state.storyError = `공통 조건 파일 ${needPath(edit.file)} ${findNeed(edit.file) ? '을 읽지 못하게 되어' : '이 없어져'} 고치던 칸을 닫았습니다. 적던 이름과 내용은 저장하지 않았습니다.`;
}

function openNeedEdit(n) {
  state.needEdit = { file: n.file, name: n.name, text: n.text, contentHash: n.contentHash, changedHash: null, error: null, saving: false };
  state.needSaved = null;
  renderCenter();
  document.getElementById('need-name')?.focus();
}

function cancelNeedEdit() {
  state.needEdit = null;
  renderCenter();
}

function overwriteNeed() {
  const edit = state.needEdit;
  edit.contentHash = edit.changedHash;
  saveNeed();
}

async function saveNeed() {
  const edit = state.needEdit;
  Object.assign(edit, { error: null, changedHash: null, saving: true });
  renderCenter();
  const { written, reread, error } = await writeOverRead('/api/needs/edit', { file: edit.file, name: edit.name, text: edit.text, contentHash: edit.contentHash });
  edit.saving = false;
  if (written) {
    state.needEdit = null;
    state.needSaved = edit.file;
    state.error = error;
  } else {
    if (reread) edit.changedHash = state.data.needs.list.find((n) => n.file === edit.file)?.contentHash ?? null;
    edit.error = error;
  }
  render();
}

const needCenter = (n) => [
  h('div', { class: 'title-row' }, h('h3', {}, n.name), h('span', { class: 'chip need-chip' }, '공통 조건')),
  h('div', { class: 'muted mono need-place' }, `${state.data.storiesDir}/${needPath(n.file)}`),
  h('p', { class: 'memo' }, n.text),
  ...needEditor(n),
  h('h2', { class: 'need-stories-head' }, `이 공통 조건을 쓰는 스토리 ${n.stories.length}`),
  n.stories.length
    ? h('ul', { class: 'screens', id: 'need-stories' }, n.stories.map((id) => h('li', { onclick: () => selectStory(id) },
        h('span', { class: 'name' }, h('span', {}, storyName(id)), h('div', { class: 'muted mono' }, id)))))
    : h('p', { class: 'muted' }, '없음'),
  h('details', { class: 'need-file', open: true },
    h('summary', {}, `공통 조건 파일 ${needPath(n.file)}`),
    h('pre', { class: 'mono' }, JSON.stringify({ name: n.name, text: n.text }, null, 2))),
];

function renderStoryCenter() {
  clearCenterHead();
  const center = document.getElementById('center-body');
  if (state.composing) return fill(center, composeCenter());
  const need = needOf();
  if (need) return fill(center, needCenter(need));
  const c = candidateOf();
  if (c) {
    return fillStoryCenter(center, c, [
      h('div', { class: 'title-row' }, h('h3', {}, c.name), storyChips(c)),
      sourceView(c.source, '후보가 나온'),
      c.skipped ? h('div', { class: 'muted skipped-inputs', title: 'CSS 선택자나 역할로 찾았거나 값이 빈 입력은 입력값에 옮기지 못했습니다' }, `옮기지 못한 입력 ${c.skipped}개`) : null,
      ...storyPath(c, c.stepRanges)]);
  }
  const st = storyOf();
  if (!st && state.story) return fill(center, h('h3', {}, state.story), h('p', { class: 'muted', title: '스토리 파일을 읽지 못했거나 맵이 오래되어 경로를 맞춰 보지 못했습니다' }, '경로 판정 없음'));
  if (!st) return fill(center, h('p', { class: 'muted' }, '스토리가 없습니다.'));
  const storyTests = ownTests(state.data.tests.stories, st.id);
  fillStoryCenter(center, st, [
    h('div', { class: 'title-row' }, h('h3', {}, st.name), statusChip(st), storyChips(st)),
    h('div', { class: 'muted mono' }, `${st.id} · ${st.file}`),
    st.source ? sourceView(st.source, '받은 후보가 나온') : null,
    h('div', { class: 'muted' }, `${st.author} · ${storyDate(st.date)}`),
    st.memo ? h('p', { class: 'memo' }, st.memo) : null,
    storyWide(st),
    h('div', { class: 'story-tests' }, h('h2', {}, `스토리 테스트 ${storyTests.length}`),
      storyTests.length ? storyTests.map((t) => testItem(t, { depth: true, hide: [`story:${st.id}`] })) : h('p', { class: 'muted' }, '없음')),
    ...savedStoryPath(st),
    storyFile(stepsFileStory(st))]);
}

const storyPlaceKey = (candidate, story) => (candidate !== null ? `candidate\n${candidate}` : `story\n${story}`);

function checkStoryStep() {
  const pressed = state.storyStep;
  if (!pressed || state.view !== 'story') return;
  const st = state.composing || needOf() ? undefined : candidateOf() ?? storyOf();
  const screen = st && pressed.of === storyPlaceKey(state.candidate, state.story) ? st.steps[pressed.step]?.screen : undefined;
  if (screen === undefined || (pressed.screen !== null && pressed.screen !== screen)) state.storyStep = null;
  else pressed.screen = screen;
}

function fillStoryCenter(center, st, cards) {
  fill(center,
    h('div', { class: 'story-top' },
      h('div', { class: 'story-top-bar' }, legendInfo('path', '스토리 경로 읽는 법', pathLegend())),
      storyLine(st)),
    cards);
  for (const info of center.querySelectorAll('[data-legend]')) applyLegend(info);
  markStoryNow();
}

const STORY_GAP = 8;

function revealStoryPart(part) {
  if (part?.kind !== 'step' && part?.kind !== 'hop') return;
  const top = document.querySelector('#center .story-top');
  if (!top) return;
  const box = /** @type {HTMLElement | null} */ (top.querySelector(`.story-line .box[data-step="${part.key.step - 1}"]`));
  state.storyStep = part.kind === 'step' && box ? { of: storyPlaceKey(state.candidate, state.story), step: Number(box.dataset.step), screen: box.dataset.screen ?? null } : null;
  markStoryNow();
  recordPlace();
  showStoryPart(part);
}

function showStoryPart(part) {
  const center = document.getElementById('center');
  const i = part.key.step - 1;
  const item = center.querySelector(part.kind === 'step' ? `.story-path > .step[data-step="${i}"]` : `.story-path > .link[data-hop="${i}"]`);
  const top = center.querySelector('.story-top');
  if (!item || !top) return;
  const r = item.getBoundingClientRect();
  const from = top.getBoundingClientRect().bottom + STORY_GAP;
  const to = center.getBoundingClientRect().bottom - center.clientTop - STORY_GAP;
  const by = r.top < from ? r.top - from : r.bottom > to ? Math.min(r.bottom - to, r.top - from) : 0;
  if (!by) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  center.scrollTo({ top: center.scrollTop + by, behavior: still ? 'auto' : 'smooth' });
}

function markStoryNow() {
  const center = document.getElementById('center');
  const top = center.querySelector('.story-top');
  if (!top) return;
  for (const card of /** @type {NodeListOf<HTMLElement>} */ (center.querySelectorAll('.story-path > .step[data-step]'))) card.classList.toggle('now', Number(card.dataset.step) === state.storyStep?.step);
  const line = /** @type {HTMLElement} */ (top.querySelector('.story-line'));
  for (const box of /** @type {NodeListOf<HTMLElement>} */ (line.querySelectorAll('.box[data-step]'))) {
    const now = Number(box.dataset.step) === state.storyStep?.step;
    box.classList.toggle('now', now);
    if (now) box.setAttribute('aria-current', 'step');
    else box.removeAttribute('aria-current');
    if (!now) continue;
    const b = box.getBoundingClientRect();
    const l = line.getBoundingClientRect();
    if (b.left < l.left) line.scrollLeft += b.left - l.left - 16;
    else if (b.right > l.right) line.scrollLeft += b.right - l.right + 16;
  }
}

function storyGaps(st) {
  const byId = new Map(flowScreens().map((n) => [n.id, n]));
  const firstStep = new Map();
  st.steps.forEach((s, i) => {
    if (s.onMap && byId.has(s.screen) && !firstStep.has(s.screen)) firstStep.set(s.screen, i);
  });
  const gaps = gapLists([...firstStep.keys()].map((id) => byId.get(id)), (n) => revealStoryPart({ kind: 'step', key: { step: firstStep.get(n.id) + 1 } }));
  return h('details', { class: 'story-gaps', open: state.storyGapsOpen, ontoggle: (e) => { state.storyGapsOpen = e.currentTarget.open; } },
    h('summary', {}, h('span', { class: 'title' }, `손볼 화면 ${gaps.count}`)),
    h('p', { class: 'muted lead' }, '이 스토리의 경로에 있는 화면 가운데 실패했거나 테스트가 없는 화면입니다. 누르면 그 단계 카드로 내려갑니다.'),
    ...gaps.groups,
    gaps.count ? null : h('p', { class: 'muted' }, '손볼 화면이 없습니다.'));
}

const stepLabel = (r) => (r.kind === 'start' ? `첫 화면 ${screenLabel(r.screen)}`
  : r.kind === 'route' ? `${screenLabel(r.screen)} 라우트` : `${screenLabel(r.from)} → ${screenLabel(r.to)}`);

function reachItem(r, scope) {
  if (r.kind === 'start') {
    return [h('h3', {}, stepLabel(r)),
      h('div', {}, '열리려면 필요한 것 ', r.kinds.map(kindChip)),
      r.roleValues ? h('div', {}, `열 수 있는 역할 ${r.roleValues.join(', ')}`)
        : r.roleValues === null ? h('div', { class: 'muted' }, '역할 미확인') : null,
      h('div', { class: 'muted' }, '들어오는 링크: 화면 목록에서')];
  }
  if (r.kind === 'route') {
    return [h('h3', {}, stepLabel(r)), h('code', {}, `${r.file}:${r.line}`), ...r.guards.map((g) => accessGuard(g, scope, state.storyOpen))];
  }
  return [h('h3', {}, stepLabel(r)),
    r.ways.length > 1 ? h('div', { class: 'muted' }, `링크 ${r.ways.length}개 중 하나`) : null,
    h('ul', { class: 'plain ways' }, r.ways.map((w, i) => wayItem(w, `${scope}\n${i}`))),
    ...(r.unknownLinks ? skippedLinks(r.unknownLinks) : [])];
}

function storyProblems(st) {
  const broken = st.links.filter((l) => l.verdict === 'broken').length;
  return [
    broken ? ['unreachable', `도달 불가 · 링크 없음 ${broken}곳`] : null,
    st.detached ? ['unjudged', '판정 못 함 · 화면 없음'] : null,
    st.unjudged ? ['unjudged', '판정 못 함 · 주소 못 읽은 링크'] : null,
  ].filter(Boolean);
}

function reachBlock(st, key) {
  return [
    storySummary(st.reach),
    h('details', { class: 'reach-raw', open: state.storyOpen.has(key), ontoggle: rememberOpen(state.storyOpen, key) },
      h('summary', {}, '조건식과 위치'),
      h('ul', { class: 'plain reach' }, st.reach.map((r, i) => h('li', { class: `reach-${r.kind}` }, reachItem(r, `${key}\n${i}`))))),
  ];
}

const STORY_ID = /^[a-z0-9_-]+$/;
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
const syncButton = (e, ready) => { e.target.closest('.story-form').querySelector('button').disabled = !ready(); };
const storyForm = (...children) => h('fieldset', { class: 'story-form', disabled: state.storyWriting }, ...children);
const field = (name, control, ...rest) => h('label', { class: 'field' }, h('span', {}, name), control, ...rest);
const storyErrorLine = () => (state.storyError ? h('p', { class: 'error story-error' }, state.storyError) : null);

function candidateActions(c) {
  return [
    h('h2', {}, '받기'),
    storyForm(h('div', { class: 'accepts' },
      h('button', { class: 'accept', title: '이 화면 순서로 스토리 파일을 씁니다.', onclick: acceptChosen }, '스토리로 받기'),
      h('button', { class: 'accept-edited', title: 'ID 와 이름을 고친 뒤에 받습니다.', onclick: () => askAccept(c, 'button.accept-edited', null) }, '고쳐서 받기')),
      h('button', { class: 'discard', title: '버린 후보 파일을 남기고, 같은 화면 순서는 다시 후보로 내지 않습니다. 이유를 적어야 합니다', onclick: () => askDiscard(c) }, '버리기')),
    storyErrorLine(),
  ];
}

function storyEdit(st) {
  if (state.storyEdit?.id !== st.id) state.storyEdit = { id: st.id, name: st.name, memo: st.memo, read: { name: st.name, memo: st.memo } };
  const d = state.storyEdit;
  for (const key of ['name', 'memo']) {
    if (d[key] === d.read[key]) d[key] = st[key];
    d.read[key] = st[key];
  }
  const canSave = () => Boolean(d.name.trim());
  return [
    h('h2', {}, '이름 · 메모'),
    storyForm(
      field('이름', h('input', { type: 'text', id: 'story-name', value: d.name, oninput: (e) => { d.name = e.target.value; syncButton(e, canSave); } })),
      field('메모', h('textarea', { id: 'story-memo', oninput: (e) => { d.memo = e.target.value; } }, d.memo)),
      h('button', { class: 'save-story', disabled: !canSave(), title: '스토리 파일의 이름과 메모를 고쳐 씁니다.', onclick: saveStoryEdit }, '저장')),
    storyErrorLine(),
  ];
}

async function whileWritingStories(write) {
  state.storyWriting = true;
  try {
    await write();
  } finally {
    state.storyWriting = false;
    const heard = storiesHeardWhileWriting;
    storiesHeardWhileWriting = null;
    if (heard !== null && heard !== state.data.storiesVersion) reloadLive();
  }
}

async function writeStories(url, body) {
  state.storyError = null;
  let written = null;
  await whileWritingStories(async () => {
    renderRight();
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      written = await res.json();
      await load();
    } catch (err) {
      state.storyError = written ? `저장했지만 다시 읽지 못했습니다: ${err.message}` : `저장하지 못했습니다: ${err.message}`;
    }
  });
  if (!written) renderRight();
  return written;
}

const storyIdProblem = (id) => (state.data.stories.list.some((st) => st.id === id) ? '같은 ID 의 스토리가 이미 있습니다.' : STORY_ID.test(id) ? null : '영문 소문자, 숫자, -, _ 만 쓸 수 있습니다.');

async function acceptAs(c, id, name) {
  if (!(await writeStories('/api/candidates/accept', { key: c.key, id, name }))) return false;
  state.candidate = null;
  state.candidateTalk = null;
  state.story = id;
  state.storyDraft = null;
  state.error = null;
  render();
  return true;
}

function takeStoryError() {
  const refused = state.storyError;
  state.storyError = null;
  renderRight();
  return refused;
}

async function acceptChosen() {
  const c = candidateOf();
  if (!c) return;
  if (storyIdProblem(slugOf(c.name))) return askAccept(c, 'button.accept', null);
  if (await acceptAs(c, slugOf(c.name), c.name)) return;
  if (state.candidate === c.key) askAccept(c, 'button.accept', takeStoryError());
}

const acceptDialog = /** @type {HTMLDialogElement} */ (document.getElementById('accept-ask'));
const acceptPart = (selector) => acceptDialog.querySelector(selector);
let acceptJob = null;

function drawAccept() {
  const { busy, error } = acceptJob;
  const problem = storyIdProblem(acceptPart('#accept-id').value);
  acceptPart('#accept-id').readOnly = busy;
  acceptPart('#accept-name').readOnly = busy;
  acceptPart('.invalid').textContent = problem ?? '';
  acceptPart('.invalid').hidden = !problem;
  acceptPart('button.cancel').disabled = busy;
  acceptPart('button.accept').disabled = busy || Boolean(problem) || !acceptPart('#accept-name').value.trim();
  acceptPart('.error').textContent = error ?? '';
  acceptPart('.error').hidden = !error;
}

function askAccept(candidate, opener, error) {
  acceptJob = { candidate, opener, busy: false, error };
  fill(acceptPart('.candidate'), h('span', { class: 'muted' }, '후보 '), candidate.name);
  acceptPart('#accept-id').value = slugOf(candidate.name);
  acceptPart('#accept-name').value = candidate.name;
  drawAccept();
  acceptDialog.showModal();
  acceptPart('#accept-id').select();
}

function closeAccept() {
  const { opener } = acceptJob;
  acceptJob = null;
  acceptDialog.close();
  /** @type {HTMLElement} */ (document.querySelector(`#right ${opener}`))?.focus();
}

async function confirmAccept() {
  const job = acceptJob;
  Object.assign(job, { busy: true, error: null });
  drawAccept();
  if (await acceptAs(job.candidate, acceptPart('#accept-id').value, acceptPart('#accept-name').value.trim())) return closeAccept();
  Object.assign(job, { busy: false, error: takeStoryError() });
  drawAccept();
  acceptPart('#accept-id').focus();
}

acceptDialog.addEventListener('input', drawAccept);
acceptPart('button.accept').addEventListener('click', confirmAccept);
acceptPart('button.cancel').addEventListener('click', closeAccept);
acceptDialog.addEventListener('keydown', (e) => {
  const send = e.key === 'Enter' && /** @type {Element} */ (e.target).matches('input');
  if ((e.key !== 'Escape' && !send) || e.isComposing) return;
  e.preventDefault();
  if (e.repeat) return;
  acceptPart(send ? 'button.accept' : 'button.cancel').click();
});

function askDiscard(c) {
  let at = -1;
  askReason({
    verb: '버리기',
    reasonLabel: '버리는 이유',
    describe: () => ({
      title: '이 후보를 버립니다',
      subject: [
        h('span', { class: 'label' }, '후보'),
        h('div', {}, c.name, ' ', h('span', { class: 'muted mono' }, c.source.record ?? c.source.report)),
        h('span', { class: 'label' }, '화면 순서'),
        h('ol', {}, c.steps.map((s) => h('li', {}, s.onMap ? [screenLabel(s.screen), ' ', h('span', { class: 'muted' }, screenOf(s.screen)?.component)] : h('span', { class: 'mono' }, s.screen)))),
      ],
      confirm: '버리기',
    }),
    save: async (reason) => {
      at = state.data.candidates.list.findIndex((x) => x.key === c.key);
      return (await writeStories('/api/candidates/discard', { key: c.key, reason })) ? null : takeStoryError();
    },
    done: () => {
      const { list } = state.data.candidates;
      state.candidate = (list[at] ?? list[at - 1])?.key ?? null;
      state.candidateTalk = null;
      render();
    },
    refocus: () => /** @type {HTMLElement} */ (document.querySelector('#right button.discard'))?.focus(),
  });
}

const hasStoryFields = (st) => hasWritten(st) || Boolean(st.stepFields?.some((f) => hasWritten(f) || f.linkNeeds?.length));

const unacceptAction = (st) => [
  h('h2', {}, '받기 되돌리기'),
  storyForm(h('button', {
    class: 'unaccept',
    title: `스토리 파일을 지우고, 같은 화면 순서를 후보 목록에 다시 올립니다.${hasStoryFields(st) ? ' 이 스토리에 적은 조건 · 입력값 · 기대 결과도 파일과 함께 사라집니다.' : ''} 이 스토리에 남은 코멘트는 「떨어져 나감」으로 갑니다.`,
    onclick: unacceptChosen,
  }, '받기 되돌리기')),
];

async function unacceptChosen() {
  const st = storyOf();
  if (!st) return;
  if (hasStoryFields(st) && !confirm(`받기를 되돌리면 스토리 파일 ${st.file} 을 지우므로, 이 스토리에 적은 조건 · 입력값 · 기대 결과도 함께 사라집니다. 그래도 되돌릴까요?`)) return;
  if (!(await writeStories('/api/stories/unaccept', { id: st.id }))) return;
  const key = st.screens.join(' > ');
  Object.assign(state, { story: null, storyDraft: null, storyEdit: null, stepsEdit: null, candidateTalk: null });
  state.candidate = state.data.candidates.list.some((c) => c.key === key) ? key : null;
  render();
}

async function saveStoryEdit() {
  const st = storyOf();
  if (!st) return;
  const written = await writeStories('/api/stories/edit', { id: st.id, name: state.storyEdit.name, memo: state.storyEdit.memo });
  if (!written) return;
  for (const edit of [openTable(), openSteps()]) {
    if (edit?.story === st.id && edit.contentHash === written.previousHash) edit.contentHash = written.contentHash;
  }
  state.storyEdit = null;
  render();
}

function reachSection(st, key) {
  const problems = storyProblems(st);
  return [
    (problems.length ? problems : [['reachable', '도달 가능']]).map(([cls, text]) => h('p', { class: `verdict ${cls}` }, text)),
    st.links.some((l) => l.ways.length && l.unknownLinks) ? h('p', { class: 'muted skipped' }, '주소 못 읽은 링크 빼고 판정') : null,
    h('h2', {}, '사전 조건'),
    st.reach.length ? reachBlock(st, key) : h('p', { class: 'muted' }, problems.length ? '판정한 구간에 조건 없음' : '조건 없음'),
  ];
}

