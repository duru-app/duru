const filePlace = (file, line) => `${file}:${line ?? '?'}`;
const testPlace = (t) => filePlace(t.testFile ?? t.file, t.line);
const viaRow = (via) => h('div', { class: 'detail' }, '불러오는 파일 ', h('span', { class: 'mono via' }, via.join(', ')));
const screenHead = (s, chip = null) => [h('span', { class: 'screen-path' }, s.path), ' ', h('span', { class: 'muted' }, s.component), ...(chip ? [' ', chip] : []), h('div', { class: 'muted mono' }, s.id)];

const isTagWord = (word) => /^@\S/.test(word);
const bareTitle = (title) => title.split(' › ').map((part) => part.split(/\s+/).filter((w) => w && !isTagWord(w)).join(' ')).filter(Boolean).join(' › ') || title;
const tagsOf = (t) => t.tags ?? t.title.split(/\s+/).filter(isTagWord).map((w) => w.slice(1));
const titleWithTags = (t, hide = []) => [bareTitle(t.title), ...[...new Set(tagsOf(t))].filter((tag) => !hide.includes(tag)).map((tag) => h('span', { class: 'mono test-tag' }, tag))];

function testItem(t, { depth = false, hide = [] } = {}) {
  return h('div', { class: 'test' },
    depth ? h('span', { class: 'depth' }, DEPTH_LABELS[t.depth]) : null,
    h('span', { class: `chip ${t.status}` }, TEST_STATUS[t.status]), ' ', titleWithTags(t, depth ? [...hide, `depth:${t.depth}`] : hide), ' ',
    h('span', { class: 'muted mono' }, filePlace(t.file, t.line)),
    t.project ? h('span', { class: 'muted' }, ` · ${t.project}`) : null,
    t.detail && t.status !== 'pass' ? h('div', { class: 'detail' }, t.detail) : null);
}

function importerItem(t) {
  return h('div', { class: 'test' },
    h('span', { class: 'depth' }, DEPTH_LABELS[t.depth]),
    h('span', { class: `chip ${t.status}` }, TEST_STATUS[t.status]), ' ', titleWithTags(t, [`depth:${t.depth}`]), ' ',
    h('span', { class: 'muted mono' }, filePlace(t.testFile, t.line)),
    viaRow(t.via));
}

const partTarget = (node, t) => ({ node, part: { kind: 'test', key: t.ref } });
const conditionTarget = (node, key) => ({ node, part: { kind: 'condition', key } });
const linkTarget = (node, key) => ({ node, part: { kind: 'link', key } });
const SLOT_WORDS = {
  test: { add: '이 테스트를 꼬리표로 넣고 코멘트를 씁니다', narrow: '이 테스트를 꼬리표로 붙인 말만 대화에 남깁니다' },
  condition: { add: '이 조건을 꼬리표로 넣고 코멘트를 씁니다', narrow: '이 조건을 꼬리표로 붙인 말만 대화에 남깁니다' },
  link: { add: '이 링크를 꼬리표로 넣고 코멘트를 씁니다', narrow: '이 링크를 꼬리표로 붙인 말만 대화에 남깁니다' },
  step: { add: '이 단계를 꼬리표로 넣고 코멘트를 씁니다', narrow: '이 단계를 꼬리표로 붙인 말만 대화에 남깁니다' },
  hop: { add: '이 연결을 꼬리표로 넣고 코멘트를 씁니다', narrow: '이 연결을 꼬리표로 붙인 말만 대화에 남깁니다' },
};
const stepTarget = (story, i, screen) => ({ story, part: { kind: 'step', key: { step: i + 1, screen } } });
const hopTarget = (story, i, l) => ({ story, part: { kind: 'hop', key: { step: i + 1, from: l.from, to: l.to } } });
const commentsIn = (m) => (m ? m.history.filter((r) => r.replyTo === undefined).length : 0);
const saidIn = (m) => m.history.filter((r) => r.replyTo === undefined && r.note.trim() !== '');
const unanswered = (m, r) => r.replyTo === undefined && r.status === undefined && !m.history.some((x) => x.replyTo === r.id);
const anyUnanswered = (entries) => entries.some((m) => m.history.some((r) => unanswered(m, r)));
const entriesAt = (t) => [markOf(t)].filter(Boolean);
const unansweredDot = (entries) => (anyUnanswered(entries) ? h('span', { class: 'unanswered-dot', role: 'img', 'aria-label': '미답변 코멘트 있음', title: '미답변 코멘트가 있습니다' }) : null);

const saidCount = (entries) => new Set(entries.flatMap((m) => saidIn(m).map((r) => r.id))).size;

const onlyTag = (tags, target) => tags.length === 1 && keyOf(tags[0]) === keyOf(target);
const onceEach = (lines) => lines.filter(({ r }, i) => lines.findIndex((x) => x.r.id === r.id) === i);

function addTag(draft, target, base) {
  const tags = draft.tags ?? [base];
  if (onlyTag(tags, base)) draft.tags = [target];
  else if (!tags.some((t) => keyOf(t) === keyOf(target))) draft.tags = [...tags, target];
}

// 지금 대화의 화면 · 호출 · 스토리가 아닌 대상은 어디의 칸인지 앞에 붙인다.
function chipLabel(t, here) {
  if (t.screens !== undefined) return tagLabel(t);
  const own = t.candidate !== undefined ? here.candidate === t.candidate : t.story !== undefined ? here.story === t.story : here.node === t.node;
  if (own) return tagLabel(t);
  const where = t.candidate !== undefined ? `후보 ${candidateName(t.candidate)}` : t.story !== undefined ? `스토리 ${t.story}` : `${nodeWord(t.node)} ${screenLabel(t.node)}`;
  const whole = t.part === undefined && t.depth === undefined && t.option === undefined && t.case === undefined;
  return whole ? where : `${where} · ${tagLabel(t)}`;
}

const recordTags = (r, here) => {
  const targets = r.targets ?? (r.target ? [r.target] : []);
  return targets.length ? targets.map((t) => tagChip(chipLabel(t, here))) : [tagChip('대상 없음')];
};

let pickables = [];
const pickable = (target, name) => {
  if (!pickables.some((p) => keyOf(p.target) === keyOf(target))) pickables.push({ target, name });
};

function pickList(tags, base) {
  const own = base.node !== undefined
    ? [{ target: { node: base.node }, name: nodeWord(base.node) === '호출' ? '호출 전체' : '화면 전체' }, ...state.data.depths.map((d) => ({ target: { node: base.node, depth: d }, name: `${DEPTH_LABELS[d]} 깊이` }))]
    : [{ target: base, name: tagLabel(base) }];
  const taken = new Set(tags.map(keyOf));
  return [...own, ...pickables].filter((p, i, all) => !taken.has(keyOf(p.target)) && all.findIndex((x) => keyOf(x.target) === keyOf(p.target)) === i);
}

const AT_WORD = /(?:^|\s)@([^\s@]*)$/;

function showPicker(picker, field, draft, tags, base) {
  const before = field.value.slice(0, field.selectionStart);
  const at = before.match(AT_WORD);
  if (!at) {
    picker.hidden = true;
    return;
  }
  const start = before.length - at[1].length - 1;
  if (picker.hidden || picker.start !== start) picker.onKey = undefined;
  picker.start = start;
  const query = at[1].toLowerCase();
  const found = pickList(tags, base).filter((p) => p.name.toLowerCase().includes(query)).slice(0, 12);
  const on = Math.max(0, found.findIndex((p) => keyOf(p.target) === picker.onKey));
  if (found.length) picker.onKey = keyOf(found[on].target);
  fill(picker, found.length ? found.map((p, i) => h('li', {
    role: 'option', 'aria-selected': String(i === on), class: i === on ? 'on' : null, 'data-key': keyOf(p.target),
    onmousedown: (e) => {
      e.preventDefault();
      takePick(field, draft, p.target, base);
    },
  }, p.name)) : h('li', { class: 'muted' }, '맞는 칸이 없습니다'));
  picker.hidden = false;
  picker.caret = field.selectionStart;
  picker.takeOn = () => {
    const i = [...picker.children].findIndex((li) => li.classList.contains('on'));
    if (i >= 0 && found[i]) takePick(field, draft, found[i].target, base);
  };
}

function takePick(field, draft, target, base) {
  const end = field.selectionStart;
  const at = field.value.slice(0, end).match(AT_WORD);
  draft.note = at ? field.value.slice(0, end - at[1].length - 1) + field.value.slice(end) : field.value;
  const tags = draft.tags ?? [base];
  if (!tags.some((t) => keyOf(t) === keyOf(target))) draft.tags = [...tags, target];
  render();
  focusTalk();
}

function pickerKey(e, picker, field) {
  if (picker.hidden || e.isComposing || e.keyCode === 229) return;
  if (field.selectionStart !== picker.caret) {
    picker.hidden = true;
    return;
  }
  const items = [...picker.querySelectorAll('li[role=option]')];
  const i = items.findIndex((li) => li.classList.contains('on'));
  const move = (to) => {
    items.forEach((li, k) => {
      li.classList.toggle('on', k === to);
      li.setAttribute('aria-selected', String(k === to));
    });
    picker.onKey = items[to].dataset.key;
  };
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
    e.preventDefault();
    move((i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
  } else if (e.key === 'Enter' && items.length) {
    e.preventDefault();
    picker.takeOn();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    picker.hidden = true;
  }
}

function talkCount(entries, narrow) {
  const n = saidCount(entries);
  if (!n) return null;
  return narrow
    ? h('button', { class: 'talk-count', title: '이 줄에 붙인 말만 대화에 남깁니다', onclick: (e) => { e.stopPropagation(); narrowTalk(narrow); } }, unansweredDot(entries), `코멘트 ${n}`)
    : h('span', { class: 'talk-count' }, unansweredDot(entries), `코멘트 ${n}`);
}

const BUBBLE = () => svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('path', { d: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z' }));

function moveTalkTo(node) {
  if (state.target.node === node) return;
  if (state.draft?.tags && onlyTag(state.draft.tags, state.target)) state.draft.tags = undefined;
  state.target = { node };
  state.draft = state.draft && { status: markOf(state.target)?.current?.status ?? null, note: state.draft.note, tags: state.draft.tags };
  state.error = null;
  state.caseError = null;
}

function focusTalk() {
  const field = /** @type {HTMLTextAreaElement} */ (document.querySelector('#right-dock textarea'));
  field?.focus();
  field?.setSelectionRange(field.value.length, field.value.length);
}

function moveTalkToStory(id) {
  state.view = 'story';
  state.composing = false;
  state.candidate = null;
  state.candidateTalk = null;
  state.need = null;
  state.error = null;
  state.caseError = null;
  state.storyError = null;
  state.judgmentError = null;
  if (state.story === id) return;
  state.storyOpen.clear();
  state.storyDraft = null;
  state.story = id;
}

function tagPart(target) {
  state.talkScope = 'here';
  if (target.story !== undefined) {
    moveTalkToStory(target.story);
    state.storyDraft ??= { status: markOf({ story: target.story })?.current?.status ?? null, note: '' };
    addTag(state.storyDraft, target, { story: target.story });
  } else {
    moveTalkTo(target.node);
    state.draft ??= { status: markOf(state.target)?.current?.status ?? null, note: '' };
    addTag(state.draft, target, state.target);
  }
  render();
  focusTalk();
}

function narrowTalk(target) {
  state.talkScope = 'here';
  if (target.story !== undefined) moveTalkToStory(target.story);
  else moveTalkTo(target.node);
  state.dockKey = keyOf(shownTarget());
  state.historyFilter = keyOf(target);
  render();
}

function talkOnCandidate(key, history) {
  state.talkScope = 'here';
  if (key !== state.candidate) {
    const note = state.candidateTalk?.note;
    selectCandidate(key);
    if (note) {
      state.candidateTalk = { status: null, note };
      render();
    }
  }
  render();
  if (!history) focusTalk();
}

const bubbleButton = (target, words, name) => h('button', {
  class: 'bubble', title: words.add, 'aria-label': `「${name}」에 코멘트`,
  onclick: (e) => { e.stopPropagation(); tagPart(target); },
  onkeydown: (e) => e.stopPropagation(),
}, BUBBLE());

function slotRow(item, target, words, name = tagLabel(target)) {
  pickable(target, tagLabel(target));
  const n = commentsIn(markOf(target));
  return h('div', { class: 'part-row' },
    item,
    n ? h('button', { class: 'part-count', title: words.narrow, onclick: (e) => { e.stopPropagation(); narrowTalk(target); } }, unansweredDot(entriesAt(target)), `코멘트 ${n}`) : null,
    bubbleButton(target, words, name));
}

const partRow = (item, node, t) => slotRow(item, partTarget(node, t), SLOT_WORDS.test, bareTitle(t.title));

const judgmentKey = (t, node) => JSON.stringify([t.ref, node]);
const judgmentErrorOf = (key) => (state.judgmentError?.key === key ? h('p', { class: 'error judgment-error' }, state.judgmentError.message) : null);

const judgeRowControl = (key, selector) => /** @type {HTMLElement} */ (document.querySelector(`.judge-row[data-pair="${CSS.escape(key)}"] ${selector}`));

function renderKeepingJudgeRowFocus() {
  const focused = document.activeElement;
  const row = /** @type {HTMLElement} */ (focused?.closest?.('.judge-row'));
  const place = row && { key: row.dataset.pair, selector: `${focused.localName}.${focused.className}` };
  render();
  if (place) judgeRowControl(place.key, place.selector)?.focus();
}

const reasonDialog = /** @type {HTMLDialogElement} */ (document.getElementById('reason-ask'));
const reasonPart = (selector) => reasonDialog.querySelector(selector);
let reasonJob = null;

function syncReasonConfirm() {
  reasonPart('button.discard').disabled = reasonJob.busy || !reasonPart('textarea').value.trim();
}

function drawReason() {
  const { describe, busy, error } = reasonJob;
  const { title, subject, confirm } = describe();
  reasonPart('h2').textContent = title;
  fill(reasonPart('.subject'), ...subject);
  reasonPart('textarea').readOnly = busy;
  reasonPart('button.cancel').disabled = busy;
  reasonPart('button.discard').textContent = confirm;
  syncReasonConfirm();
  reasonPart('.error').textContent = error ?? '';
  reasonPart('.error').hidden = !error;
}

function askReason(job) {
  reasonJob = { ...job, busy: false, error: null };
  reasonPart('textarea').value = '';
  reasonPart('textarea').placeholder = job.reasonLabel;
  reasonPart('textarea').setAttribute('aria-label', job.reasonLabel);
  reasonPart('.hint').textContent = `Ctrl+Enter 로 ${job.verb}`;
  drawReason();
  reasonDialog.showModal();
  reasonPart('textarea').focus();
}

function closeReason() {
  reasonJob = null;
  reasonDialog.close();
  // 창을 연 단추가 그사이 다시 그려졌으면 초점이 닫힌 창 안에 남는다.
  if (reasonDialog.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur();
}

async function confirmReason() {
  const job = reasonJob;
  Object.assign(job, { busy: true, error: null });
  drawReason();
  const error = await job.save(reasonPart('textarea').value.trim());
  if (error) {
    Object.assign(job, { busy: false, error });
    drawReason();
    return reasonPart('textarea').focus();
  }
  closeReason();
  job.done();
}

reasonPart('textarea').addEventListener('input', syncReasonConfirm);
reasonPart('button.discard').addEventListener('click', confirmReason);
reasonPart('button.cancel').addEventListener('click', () => {
  const { refocus } = reasonJob;
  closeReason();
  refocus();
});
// Ctrl+Enter 와 Escape 는 창의 단추를 대신 누르므로, 저장하는 동안에는 단추와 똑같이 막힌다.
reasonDialog.addEventListener('keydown', (e) => {
  const send = e.key === 'Enter' && (e.ctrlKey || e.metaKey);
  if (e.key !== 'Escape' && !send) return;
  e.preventDefault();
  if (e.isComposing || e.repeat) return;
  reasonPart(send ? 'button.discard' : 'button.cancel').click();
});

function askExclude(test, nodeIds, job) {
  askReason({
    verb: '제외',
    reasonLabel: '제외하는 이유',
    describe: () => {
      const ids = nodeIds();
      const many = ids.length > 1;
      return {
        title: many ? `짝 ${ids.length}개를 제외합니다` : '이 짝을 제외합니다',
        subject: [
          h('span', { class: 'label' }, '테스트'),
          h('div', {}, test.title, ' ', h('span', { class: 'muted mono' }, testPlace(test))),
          h('span', { class: 'label' }, ['화면', '호출'].filter((word) => ids.some((id) => nodeWord(id) === word)).join('과 ')),
          h('ul', { class: 'plain' }, ids.map((id) => h('li', {}, callOf(id) ? h('span', { class: 'mono' }, id) : [screenLabel(id), ' ', h('span', { class: 'muted' }, screenOf(id)?.component)]))),
        ],
        confirm: many ? `제외 (${ids.length})` : '제외',
      };
    },
    ...job,
  });
}

function askExcludePair(t, node, key) {
  if (judgmentsInFlight.has(key)) return;
  askExclude(t, () => [node], {
    save: async (reason) => {
      const { failure, reloadError } = await postAndReload({ test: t.ref, node, kind: 'discard', reason }, key);
      if (!failure) setJudgmentError(key, reloadError);
      return failure;
    },
    done: renderKeepingJudgeRowFocus,
    refocus: () => judgeRowControl(key, 'button.discard')?.focus(),
  });
}

function judgmentForm(t, node) {
  const key = judgmentKey(t, node);
  const word = nodeWord(node);
  return h('div', { class: 'judge-row', 'data-pair': key },
    h('button', { class: 'discard', title: `이 테스트와 이 ${word}의 짝을 다시 보이지 않게 합니다. 이유를 적어야 합니다`, onclick: () => askExcludePair(t, node, key) }, '제외'),
    h('button', { class: 'hand-over', title: `이 ${word}의 테스트로 보고, 테스트에 이 ${word}의 태그를 달도록 작업 목록에 올립니다`, onclick: () => saveJudgment({ test: t.ref, node, kind: 'hand-over', reason: '' }, key) }, '포함'));
}

const judgmentMeta = (j, label) => h('div', { class: 'detail' },
  j.reason.trim() ? [`${label} `, h('span', { class: 'memo' }, j.reason)] : null,
  h('span', { class: 'muted' }, `${j.reason.trim() ? ' · ' : ''}${signedAt(j)}`));

const undoButton = (t, node) => h('button', { class: 'undo', onclick: () => saveJudgment({ test: t.ref, node, kind: 'undo' }, judgmentKey(t, node)) }, '되돌리기');

function detachedItem(t) {
  return h('div', { class: 'test' },
    h('span', { class: 'muted mono' }, t.ref.file), ' ', t.ref.title);
}

const PASS_LEVEL = { assert: '확인함', interact: '조작함', visit: '지나감', call: '호출함' };
const PASS_LEVEL_TITLE = { assert: '이 화면이 열려 있을 때 확인문을 실행했습니다', interact: '이 화면이 열려 있을 때 누르거나 입력했습니다', visit: '이 화면을 열기만 했습니다', call: '도는 동안 이 호출의 메서드와 경로에 맞는 요청을 보냈습니다' };

const UNCONFIRMED_TITLE = '이번 실행에서는 이 테스트의 trace 를 읽지 못해 이 짝을 다시 확인하지 못했습니다. 포함한 판단은 그대로입니다';

function passedItem(t) {
  return h('div', { class: 'test' },
    t.unconfirmed
      ? h('span', { class: 'chip level-visit', title: UNCONFIRMED_TITLE }, '확인 못 함')
      : h('span', { class: `chip level-${t.level}`, title: PASS_LEVEL_TITLE[t.level] }, PASS_LEVEL[t.level]), ' ',
    h('span', { class: `chip ${t.status}` }, TEST_STATUS[t.status]), ' ', titleWithTags(t), ' ',
    h('span', { class: 'muted mono' }, filePlace(t.file, t.line)),
    t.project ? h('span', { class: 'muted' }, ` · ${t.project}`) : null,
    h('div', { class: 'detail' }, '결과 파일 ', h('span', { class: 'mono' }, t.source)));
}

const byTrace = (t) => Boolean(t.level || t.unconfirmed);
const pairTestItem = (t) => (byTrace(t) ? passedItem(t) : importerItem(t));
const pairKeys = (node) => [passedOf, importersOf, discardedOf, awaitingTagOf, detachedOf].flatMap((of) => of(node)).map((t) => judgmentKey(t, node));

// 화면의 짝과 고른 호출의 짝은 오류를 저마다 제 줄 아래에 보인다.
function strayJudgmentError(s) {
  const call = state.target.node === s.id ? [] : pairKeys(state.target.node);
  const stray = state.judgmentError && ![...pairKeys(s.id), ...call].includes(state.judgmentError.key);
  return stray ? h('p', { class: 'error judgment-error' }, state.judgmentError.message) : null;
}

const PAIR_TEXT = {
  화면: {
    passed: (n) => `지나간 테스트 ${n}`,
    passedNote: '도는 동안 이 화면을 연 브라우저 테스트입니다. 이 화면의 태그가 없어서 이 화면의 테스트로 세지 않습니다.',
    detachedNote: '포함한 테스트를 결과에서 찾을 수 없습니다. 테스트의 파일이나 제목이 바뀌었거나, 이 화면의 파일을 더는 불러오지 않거나 이 화면을 더는 열지 않는 것으로 보입니다.',
  },
  호출: {
    passed: (n) => `호출한 테스트 ${n}`,
    passedNote: '도는 동안 이 호출을 보낸 브라우저 테스트입니다. 이 호출의 태그가 없어서 이 호출의 테스트로 세지 않습니다.',
    detachedNote: '포함한 테스트를 결과에서 찾을 수 없습니다. 테스트의 파일이나 제목이 바뀌었거나, 이 호출을 더는 보내지 않는 것으로 보입니다.',
  },
};

function untaggedPairs(node) {
  const text = PAIR_TEXT[nodeWord(node)];
  const order = Object.keys(PASS_LEVEL);
  const passed = [...passedOf(node)].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const importers = importersOf(node);
  const discarded = discardedOf(node);
  const awaiting = awaitingTagOf(node);
  const detached = detachedOf(node);
  const row = (t, ...rest) => h('div', { class: `pair-test ${byTrace(t) ? 'passer' : 'importer'}` }, ...rest, judgmentErrorOf(judgmentKey(t, node)));
  const openRow = (t) => row(t, partRow(pairTestItem(t), node, t), judgmentForm(t, node));
  const judgedRow = (item, t, label) => row(t, item, judgmentMeta(t.judgment, label), undoButton(t, node));
  return [
    passed.length ? h('div', { class: 'passed' },
      h('h2', {}, text.passed(passed.length)),
      h('p', { class: 'muted' }, text.passedNote),
      passed.map(openRow)) : null,
    importers.length ? h('div', { class: 'importers' },
      h('h2', {}, `불러오는 테스트 ${importers.length}`),
      h('p', { class: 'muted' }, '이 화면에 딸린 소스 파일을 불러오는 단위 테스트입니다. 이 화면의 태그가 없어서 이 화면의 테스트로 세지 않습니다.'),
      importers.map(openRow)) : null,
    awaiting.length ? h('div', { class: 'awaiting-tag' },
      h('h2', {}, `태그 대기 ${awaiting.length}`),
      awaiting.map((t) => judgedRow(pairTestItem(t), t, '메모'))) : null,
    detached.length ? h('div', { class: 'detached' },
      h('h2', {}, `떨어져 나감 ${detached.length}`),
      h('p', { class: 'muted' }, text.detachedNote),
      detached.map((t) => judgedRow(detachedItem(t), t, '메모'))) : null,
    discarded.length ? h('div', { class: 'discarded' },
      h('h2', {}, `제외한 짝 ${discarded.length}`),
      discarded.map((t) => judgedRow(pairTestItem(t), t, '이유'))) : null,
  ];
}

