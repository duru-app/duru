function hereTalk() {
  if (state.view !== 'story' && state.side === 'cases') return state.caseNode === null ? null : { label: `이 ${nodeWord(state.caseNode)}`, target: { node: state.caseNode } };
  if (state.view !== 'story') return state.target && { label: `이 ${nodeWord(state.target.node)}`, target: state.target };
  if (state.candidate && !state.composing) return { label: '이 후보', target: { candidate: state.candidate } };
  if (state.need && !state.composing) return null;
  if (state.composing) return { label: '이 화면 순서', target: composeTarget() };
  return { label: '이 스토리', target: state.story && !state.candidate ? { story: state.story } : null };
}

function scopeButtons() {
  const here = hereTalk();
  if (!here) return null;
  const pick = (scope) => () => {
    if (state.talkScope === scope) return;
    state.talkScope = scope;
    render();
  };
  return h('div', { class: 'talk-scope', role: 'group', 'aria-label': '대화 범위' },
    h('button', { type: 'button', 'aria-pressed': String(state.talkScope === 'here'), disabled: state.storyWriting, onclick: pick('here') }, here.target ? `${here.label} ${saidCount(attachedTalk(here.target))}` : here.label),
    h('button', { type: 'button', 'aria-pressed': String(state.talkScope === 'all'), disabled: state.storyWriting, onclick: pick('all') }, `전체 ${saidCount(talkMarks())}`));
}

const TALK_FILTERS = [
  { key: 'all', label: '모두', keep: () => true },
  { key: 'unanswered', label: '미답변', keep: unanswered },
  ...Object.entries(MARK_STATUS).map(([key, label]) => ({ key, label, keep: (m, r) => m.current?.status === key && saidIn(m).find((x) => x.status === key)?.id === r.id })),
  { key: 'changes', label: '변경 기록' },
];
const PICK_STATUS = { needed: '켬', 'not-needed': '끔' };

function pickWord(r, history) {
  if (r.of === undefined) return { text: PICK_STATUS[r.status] ?? r.status, title: null };
  return acceptsProposal(r, history)
    ? { text: '받아들임', title: '에이전트의 「대상 아님」을 받아들였습니다' }
    : { text: '되돌림', title: '에이전트의 「대상 아님」을 되돌렸습니다' };
}
const talkMarks = () => state.data.marks.attached.filter((m) => !isPick(m));

const noTarget = (t) => t.node === undefined && t.story === undefined && t.candidate === undefined && t.screens === undefined;
const groupOf = (t) => (noTarget(t) ? 'general()' : t.candidate !== undefined ? `candidate(${t.candidate})` : t.screens !== undefined ? keyOf(t) : t.story !== undefined ? `story(${t.story})` : t.node);
const groupTitle = (t) => (noTarget(t) ? '대상 없음' : t.candidate !== undefined
  ? `후보 ${candidateName(t.candidate)}`
  : t.screens !== undefined
  ? orderLabel({ screens: t.screens })
  : t.story !== undefined
  ? `스토리 ${state.data.stories.list.find((st) => st.id === t.story)?.name ?? t.story}`
  : callOf(t.node) ? `호출 ${t.node}` : screenLabel(t.node));
const firstLine = (note) => note.split('\n').find((line) => line.trim() !== '') ?? '';

function allTalk() {
  const lines = talkMarks().flatMap((m) => saidIn(m).map((r) => ({ m, r })));
  const shownFilters = TALK_FILTERS.filter((f) => f.key !== 'changes' || Object.keys(state.data.caseKinds).length > 0);
  const filter = shownFilters.find((f) => f.key === state.talkFilter) ?? shownFilters[0];
  const unansweredCount = onceEach(lines.filter(({ m, r }) => unanswered(m, r))).length;
  const filters = h('div', { class: 'talk-filters', role: 'group', 'aria-label': '대화 거르기' }, shownFilters.map((f) => h('button', {
    type: 'button',
    'aria-pressed': String(f.key === filter.key),
    onclick: () => {
      state.talkFilter = f.key;
      render();
    },
  }, f.key === 'unanswered' ? `${f.label} ${unansweredCount}` : f.label)));
  if (!filter.keep) return h('div', { class: 'talk all-talk' }, filters, changeList());
  const groups = new Map();
  for (const line of lines.filter(({ m, r }) => filter.keep(m, r)).sort((a, b) => byDate(b.r, a.r))) {
    const key = groupOf(line.m.target);
    if (!groups.has(key)) groups.set(key, []);
    if (!groups.get(key).some((x) => x.r.id === line.r.id)) groups.get(key).push(line);
  }
  const lineItem = ({ m, r }) => {
    const replies = m.history.filter((x) => x.replyTo === r.id).sort(byDate);
    const meta = h('span', { class: 'meta' },
      unanswered(m, r) ? h('span', { class: 'unanswered-dot', role: 'img', 'aria-label': '미답변', title: '미답변 코멘트' }) : null,
      r.status ? h('span', { class: `chip ${r.status}` }, MARK_STATUS[r.status]) : null,
      noTarget(m.target) ? null : tagChip(tagLabel((r.targets ?? [r.target]).find((t) => t && keyOf(t) === m.key) ?? m.target)),
      h('span', {}, signedAt(r)),
      replies.length ? h('span', {}, `· 답 ${replies.length}`) : null);
    // 대상 없는 말과 화면 순서에 남긴 말은 옮겨 갈 칸이 없으므로 여기서 글 전체와 답을 보인다.
    if (noTarget(m.target) || m.target.screens !== undefined) {
      return h('div', { class: 'talk-line general', 'data-record': r.id }, meta, h('div', {}, r.note),
        replies.length ? h('ul', { class: 'plain replies' }, replies.map((x) => h('li', { class: 'reply' }, h('span', { class: 'muted' }, signedAt(x)), h('div', {}, x.note)))) : null);
    }
    return h('button', { type: 'button', class: 'talk-line', 'data-record': r.id, onclick: () => reachTalk(m.target, r.id, { record: r.id, group: groupOf(m.target) }) }, meta, h('span', { class: 'first' }, firstLine(r.note)));
  };
  return h('div', { class: 'talk all-talk' },
    filters,
    groups.size
      ? [...groups.entries()].map(([key, group]) => h('div', { class: 'talk-group', 'data-group': key }, h('h3', { class: group[0].m.target.node !== undefined ? 'mono' : null }, groupTitle(group[0].m.target)), group.map(lineItem)))
      : h('p', { class: 'muted' }, lines.length ? '거른 조건에 맞는 말이 없습니다.' : '아직 남긴 말이 없습니다.'));
}

function changeList() {
  const picks = state.data.marks.attached.filter(isPick).flatMap((m) => m.history.map((r) => ({ m, r }))).sort((a, b) => byDate(b.r, a.r));
  if (!picks.length) return h('p', { class: 'muted' }, '경우 종류를 켜고 끈 기록이 없습니다.');
  return h('div', { class: 'talk-changes' }, picks.map(({ m, r }) => h('button', {
    type: 'button',
    class: 'talk-line',
    'data-record': r.id,
    onclick: () => {
      if (!callOf(m.target.node)) state.screenInfoOpen = true;
      reachTalk(m.target, null, { record: r.id, group: null });
      revealCases(m.target.node);
    },
  },
    h('span', { class: 'meta' },
      h('span', { class: `chip ${r.status}`, title: pickWord(r, m.history).title }, pickWord(r, m.history).text),
      tagChip(tagLabel(m.target)),
      h('span', {}, `${r.author} · ${fmtDate(r.date)}`)),
    h('span', { class: 'first mono' }, groupTitle(m.target)),
    r.note.trim() ? h('span', { class: 'first' }, firstLine(r.note)) : null)));
}

/** @param {{ record: string, group: string | null }} pressed */
function reachTalk(target, recordId, pressed) {
  const screen = target.node === undefined ? null : screenOf(target.node) ? target.node : callOf(target.node)?.screens[0];
  if (screen === undefined) return;
  linePressed = pressed;
  state.talkScope = 'here';
  state.reachRecord = recordId;
  state.historyFilter = null;
  if (target.node === undefined) {
    state.view = 'story';
    state.composing = false;
    state.dockKey = keyOf(target.candidate !== undefined ? target : { story: target.story });
    if (target.candidate !== undefined) return selectCandidate(target.candidate);
    selectStory(target.story);
    return revealStoryPart(target.part);
  }
  state.side = 'screens';
  if (state.view === 'flow' && flowScreens().some((n) => n.id === screen)) {
    state.flowPicked = true;
    select(screen, { node: target.node });
    return showBox(screen);
  }
  state.view = 'list';
  select(screen, { node: target.node });
}

function revealRecord() {
  const id = state.reachRecord;
  if (id === null) return;
  state.reachRecord = null;
  const item = document.querySelector(`#right [data-record="${CSS.escape(id)}"]`);
  if (!item) return;
  item.classList.add('reached');
  item.scrollIntoView({ block: 'nearest' });
}

// 태그가 여럿 달린 코멘트는 그룹마다 한 줄씩 나오므로, 누른 그룹에 있는 줄을 찾는다.
function revealLine({ record, group }) {
  const lines = [...document.querySelectorAll(`#right .all-talk [data-record="${CSS.escape(record)}"]`)];
  const line = lines.find((l) => l.closest('.talk-group')?.getAttribute('data-group') === group) ?? lines[0];
  if (!line) return;
  line.classList.add('reached');
  line.scrollIntoView({ block: 'nearest' });
}

function renderScreenRight(info, dock) {
  const s = state.data.map.screens.find((x) => x.id === state.selected);
  if (!s) {
    fill(info);
    return fill(dock);
  }
  const call = state.target.node === s.id ? null : callOf(state.target.node);
  fill(info, talkPanel(state.target));
  fill(dock, markForm(state.target, 'draft', targetLabelOf(state.target, call)));
}

const talkIn = (marks, target) => marks.filter((m) => !isPick(m) && (target.candidate !== undefined ? m.target.candidate === target.candidate
  : target.screens !== undefined ? m.key === keyOf(target)
  : target.story !== undefined ? m.target.story === target.story : m.target.story === undefined && m.target.node === target.node));
const talkOf = (target) => talkIn([...state.data.marks.attached, ...state.data.marks.detached], target);
const attachedTalk = (target) => talkIn(state.data.marks.attached, target);

const byDate = (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

function tagChip(label, remove) {
  return h('span', { class: 'tag' }, h('span', { class: 'tag-label' }, label), remove ? h('button', { type: 'button', title: '꼬리표 빼기', 'aria-label': `${label} 꼬리표 빼기`, onclick: remove }, '×') : null);
}

function talkThread(target) {
  const talk = talkOf(target);
  const shown = state.historyFilter ? talk.filter((m) => m.key === state.historyFilter) : talk;
  const recordItem = (m, r) => h('li', { class: r.replyTo !== undefined ? 'reply' : null, 'data-record': r.id },
    r.status ? [h('span', { class: `chip ${r.status}` }, MARK_STATUS[r.status]), ' '] : null,
    r.replyTo === undefined ? [...recordTags(r, target), ' '] : null,
    h('span', { class: 'muted' }, signedAt(r)),
    r.note ? h('div', {}, r.note) : null,
    ...repliesOf(m, r));
  const repliesOf = (m, r) => {
    const replies = m.history.filter((x) => x.replyTo === r.id).sort(byDate);
    return replies.length ? [h('ul', { class: 'plain replies' }, replies.map((x) => recordItem(m, x)))] : [];
  };
  const answered = (m, r) => r.replyTo !== undefined && m.history.some((x) => x.id === r.replyTo);
  const topLevel = onceEach(shown.flatMap((m) => m.history.filter((r) => !answered(m, r)).map((r) => ({ m, r })))).sort((a, b) => byDate(a.r, b.r));
  const all = onceEach(talk.flatMap((m) => m.history.filter((r) => !answered(m, r)).map((r) => ({ m, r }))));
  const history = all.length ? h('ul', { class: 'plain history' }, topLevel.map(({ m, r }) => recordItem(m, r))) : null;
  const filter = state.historyFilter && history && h('div', { class: 'history-filter' },
    '걸러 보는 중 ', tagChip(tagLabel(talk.find((m) => m.key === state.historyFilter)?.target ?? target)),
    h('button', { type: 'button', onclick: () => { state.historyFilter = null; render(); } }, '모두 보기'));
  return { history, filter };
}

function talkPanel(target) {
  const { history, filter } = talkThread(target);
  return h('div', { class: 'talk' },
    h('h2', {}, '에이전트와 대화'),
    filter,
    history ?? h('p', { class: 'muted' }, '아직 대화가 없습니다.'));
}

function markForm(target, draftKey, label) {
  const mark = markOf(target);
  state[draftKey] ??= { status: mark?.current?.status ?? null, note: '' };
  const draft = state[draftKey];
  const tags = (draft.tags ?? [target]).map((t) => (t.screens !== undefined && target.screens !== undefined ? target : t));
  const statusOn = onlyTag(tags, target) && target.candidate === undefined && target.screens === undefined;
  const savable = () => draft.note.trim() !== '' || (statusOn && !!draft.status);
  const save = h('button', { class: 'save', disabled: !savable(), onclick: () => saveMark(tags, draftKey, statusOn) }, '남기기');
  const statuses = Object.entries(MARK_STATUS).map(([k, text]) => {
    const button = h('button', { class: statusOn && draft.status === k ? 'on' : '', disabled: !statusOn, title: statusOn ? null : target.candidate !== undefined ? '후보에는 상태를 매기지 않습니다. 스토리로 받은 뒤에 매깁니다' : target.screens !== undefined ? '화면 순서에는 상태를 매기지 않습니다' : '상태는 꼬리표가 화면 · 호출 · 깊이 · 스토리 하나뿐일 때만 매깁니다', onclick: () => {
      draft.status = draft.status === k ? null : k;
      for (const b of statuses) b.classList.toggle('on', b === button && draft.status === k);
      save.disabled = !savable();
    } }, text);
    return button;
  });
  const untag = (t) => () => {
    const rest = tags.filter((x) => keyOf(x) !== keyOf(t));
    draft.tags = rest.length || keyOf(t) === keyOf(target) ? rest : undefined;
    render();
  };
  const picker = h('ul', { class: 'plain tag-pick', role: 'listbox', 'aria-label': '꼬리표 고르기', hidden: true });
  const field = h('textarea', {
    placeholder: '코멘트 — 상태 없이 글만 남겨도 됩니다. @ 로 꼬리표를 더합니다',
    oninput: (e) => {
      draft.note = e.target.value;
      save.disabled = !savable();
      showPicker(picker, field, draft, tags, target);
    },
    onkeydown: (e) => pickerKey(e, picker, field),
    onkeyup: () => { if (!picker.hidden && field.selectionStart !== picker.caret) showPicker(picker, field, draft, tags, target); },
    onclick: () => showPicker(picker, field, draft, tags, target),
    onblur: () => { picker.hidden = true; },
  }, draft.note);
  return h('div', { class: 'mark-form' },
    h('div', { class: 'talk-head' }, h('div', { class: 'tags' }, '꼬리표 ', tags.length
      ? tags.map((t) => tagChip(keyOf(t) === keyOf(target) ? label : chipLabel(t, target), untag(t)))
      : [h('span', { class: 'muted', title: '어느 칸에도 붙이지 않고 묻습니다. 「전체」의 「대상 없음」에 나옵니다' }, '없음'), h('button', { type: 'button', class: 'retag', onclick: () => {
        draft.tags = undefined;
        render();
        focusTalk();
      } }, `${label} 다시 붙이기`)])),
    h('div', { class: 'statuses' }, statuses),
    h('div', { class: 'tag-field' }, field, picker),
    state.error ? h('p', { class: 'error' }, state.error) : null,
    h('div', { class: 'save-row' }, save));
}

