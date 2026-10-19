/** @typedef {import('../review.ts').PageData} PageData */
const DEPTH_LABELS = { ui: 'UI/E2E', api: 'API', render: '렌더링만', code: '코드', data: '데이터', output: '산출물' };
const TEST_STATUS = { pass: '통과', fail: '실패', pending: '보류' };
const MARK_STATUS = { 'needs-more': '더 필요', missing: '없음', fine: '충분' };
const CASE_STATUS = { needed: '필요', 'not-needed': '필요 없음' };
const SERVER_STATUS = { match: '서버에 있음', 'method-mismatch': '메서드 불일치', none: '서버에 없음', unresolved: '판정 불가', unchecked: '대조 안 함' };
const UNRESOLVED_REASON = {
  'not-written': '보내는 곳에 주소가 적혀 있지 않음',
  'imported-piece': '주소 일부가 import 한 값이라 읽지 못함',
  'unknown-piece': '값을 모르는 조각이 주소에 붙어 있음',
  'other-host': 'app.server 로 확인되지 않은 호스트로 보냄',
  'no-path': '주소에 경로가 없음',
};
const GROUP_HEAD_TIP = '밑으로 이어 그린 화면이 없는 진입 화면입니다. 다른 화면으로 가는 링크가 없거나, 링크가 닿는 화면이 모두 다른 진입 화면이나 그 밑에 이미 그려져 있습니다.';
const SERVER_STATE_TIP = '서버 API 목록(serverEndpoints)이 없거나 비어 있어 API 호출을 서버와 견주지 않았습니다. 목록을 채우고 duru rebuild 를 다시 하면 견줍니다.';
const KIND_LABEL = { setting: '설정', role: '역할' };
const MIXED_KINDS = '링크마다 다름';
const VALUE_LABEL = { true: '켬', false: '끔' };
const SCREEN_FILTERS = [
  { key: 'no-tests', label: '테스트 없음만', keep: (s) => testsOf(s.id).length === 0 },
  { key: 'imported-only', label: '지나간 테스트만 있음', title: '화면 테스트는 없고, 이 화면의 소스 파일을 불러오거나 도는 동안 이 화면을 연 테스트만 있는 화면. 태그를 기다리는 짝은 세고, 제외한 짝은 세지 않습니다', keep: (s) => testsOf(s.id).length === 0 && importersOf(s.id).length + awaitingTagOf(s.id).length + passedOf(s.id).length > 0 },
  { key: 'dead', label: '죽은 화면', keep: (s) => s.dead, needsServerList: true },
  { key: 'setting', label: '특정 설정에서만 열림', keep: (s) => s.access.kinds.includes('setting') },
  { key: 'role', label: '특정 역할에서만 열림', keep: (s) => s.access.kinds.includes('role') },
  { key: 'mixed', label: MIXED_KINDS, keep: (s) => s.access.restricted && !s.access.kinds.length },
];

const STORY_STATUS = {
  pass: { label: '통과', title: '스토리 테스트가 모두 통과했습니다' },
  fail: { label: '실패', title: '실패한 스토리 테스트가 있습니다' },
  pending: { label: '보류', title: '실패한 스토리 테스트는 없고 보류한 것이 있습니다' },
  partial: { label: '일부 화면만 테스트', title: '스토리 테스트는 없고, 경로의 화면 가운데 테스트가 붙은 화면이 있습니다' },
  untested: { label: '테스트 없음', title: '스토리 테스트도, 경로의 화면에 붙은 테스트도 없습니다' },
};
// 상태는 고른 것 가운데 하나만 맞아도 남기고, 「링크 없음」은 그 결과를 한 번 더 거른다.
const STORY_FILTERS = [
  ...['untested', 'partial', 'fail'].map((key) => ({ key, ...STORY_STATUS[key], status: true, keep: (st) => st.status === key })),
  { key: 'broken', label: '링크 없음', title: '이웃한 두 화면을 잇는 링크가 맵에 없는 자리가 있는 스토리', keep: (st) => st.broken },
];
const state = { data: /** @type {PageData} */ (null), selected: null, target: null, filters: new Set(), query: '', draft: null, error: null, view: 'flow', flowPicked: false, flowFilter: 'all', flowQuery: '', zoom: 1, ended: false, failed: false, roleChoice: 'auto', pathValues: new Map(), settingsError: null, frameScreen: null, side: 'screens', story: null, storyFilters: new Set(), storyDraft: null, legends: { flow: { open: false, dismissed: false }, path: { open: false, dismissed: false } }, openGroups: new Set(), openLong: new Set(), rightView: null, storyOpen: new Set(), dockKey: null, historyOpen: false, historyFilter: null, judgmentError: null, untaggedTest: null, untaggedQuery: '', bulk: null, bulkBusy: false, ending: false, candidate: null, candidateTalk: null, storyEdit: null, storyError: null, storyWriting: false, compose: null, composing: false, caseSaving: false, caseError: null, screenInfoOpen: false, discardedOpen: false, undiscardError: null, callInfoShut: null, storyQuery: '', storyStep: null, storyGapsOpen: false, talkScope: 'here', talkFilter: 'all', reachRecord: null, storyFileOpen: false, need: null, needEdit: null, needSaved: null, fieldsEdit: null, fieldsSaved: null, stepsEdit: null, stepsSaved: null };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

const keyOf = (t) => (t.candidate !== undefined
  ? `candidate(${t.candidate})`
  : t.story !== undefined
  ? [`story(${t.story})`, t.part && `part:${t.part.kind}:${JSON.stringify(t.part.key)}`].filter(Boolean).join(' ')
  : [t.node, t.option && `${t.option.key}=${t.option.value}`, t.depth, t.case && `case:${t.case}`, t.part && `part:${t.part.kind}:${JSON.stringify(t.part.key)}`].filter(Boolean).join(' '));
const optionLabel = (o) => `${o.key} ${VALUE_LABEL[o.value]}`;
const targetName = (t) => (t.candidate !== undefined
  ? `후보 ${candidateName(t.candidate)}`
  : t.story !== undefined
  ? `스토리 ${state.data.stories.list.find((st) => st.id === t.story)?.name ?? t.story}`
  : [t.node, t.option && optionLabel(t.option), t.depth && `${DEPTH_LABELS[t.depth]} 깊이`, t.case && `경우 ${state.data.caseKinds[t.case]?.text ?? t.case}`].filter(Boolean).join(' · '));
const conditionLabel = (key) => (key.startsWith('role:') ? `역할 ${key.slice('role:'.length)}` : `설정 ${key.slice('setting:'.length)}`);
const tagLabel = (t) => {
  if (t.candidate !== undefined) return '후보';
  if (t.part?.kind === 'step') return `단계 ${t.part.key.step} ${screenLabel(t.part.key.screen)}`;
  if (t.part?.kind === 'hop') return `단계 ${t.part.key.step} → ${t.part.key.step + 1} 연결`;
  if (t.story !== undefined) return '스토리';
  if (t.part?.kind === 'condition') return conditionLabel(t.part.key);
  if (t.part?.kind === 'link') return `${t.part.key.from} 에서 오는 링크`;
  if (t.part) return `테스트 「${t.part.key.title}」`;
  return [t.option && optionLabel(t.option), t.depth && `${DEPTH_LABELS[t.depth]} 깊이`, t.case && `경우 ${state.data.caseKinds[t.case]?.text ?? t.case}`].filter(Boolean).join(' · ') || (callOf(t.node) ? '호출 전체' : '화면 전체');
};
const ownTests = (byId, id) => (byId && Object.hasOwn(byId, id) ? byId[id] : []);
const testsOf = (id) => ownTests(state.data.tests.nodes, id);
const importersOf = (id) => ownTests(state.data.tests.importers, id);
const passedOf = (id) => ownTests(state.data.tests.passed, id);
const discardedOf = (id) => ownTests(state.data.tests.discarded, id);
const awaitingTagOf = (id) => ownTests(state.data.tests.awaitingTag, id);
const detachedOf = (id) => ownTests(state.data.tests.detachedHandOvers, id);
const untaggedTests = () => state.data.tests.untagged ?? [];
const untaggedListMissing = () => !state.data.tests.untagged && state.data.tests.untaggedCount > 0;
const untaggedCount = () => state.data.tests.untagged?.length ?? state.data.tests.untaggedCount ?? 0;
const untaggedKey = (t) => JSON.stringify([t.source, t.file, t.line, t.title]);
const markOf = (t) => state.data.marks.attached.find((m) => m.key === keyOf(t));
const fmtDate = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
function othersSigned() {
  const { marks, tests, author } = state.data;
  const judged = [tests.discarded, tests.awaitingTag, tests.detachedHandOvers].flatMap((byNode) => Object.values(byNode ?? {}).flat()).map((t) => t.judgment);
  return [...marks.attached, ...marks.detached].flatMap((m) => m.history).concat(judged).some((record) => record.author !== author);
}
const signedAt = (record) => (othersSigned() ? `${record.author} · ${fmtDate(record.date)}` : fmtDate(record.date));
const markChip = (m) => (m?.current ? h('span', { class: `chip ${m.current.status}`, title: m.current.note || '' }, MARK_STATUS[m.current.status] ?? CASE_STATUS[m.current.status]) : null);
const callOf = (id) => state.data.map.calls.find((c) => c.id === id);
const nodeWord = (id) => (callOf(id) ? '호출' : '화면');
const callIdsOf = (s) => [...new Set(s.apiCalls.flatMap((c) => (c.endpoints ?? []).map((e) => e.callId)).filter(Boolean))];
const hasOption = (tests, key, value) => tests.filter((t) => t.options?.some((o) => o.key === key && o.value === value));
const optionsOf = (s, callId) => s.callOptions[callId] ?? [];

let loadsStarted = 0;
let loadApplied = 0;

// 늦게 시작한 읽기가 그 앞의 저장을 모두 담고 있으므로, 먼저 시작한 읽기가 늦게 돌아오면 버린다.
async function load() {
  const order = ++loadsStarted;
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  if (order < loadApplied) return;
  loadApplied = order;
  state.data = data;
  const { screens } = state.data.map;
  if (!screens.some((s) => s.id === state.selected)) state.flowPicked = false;
  const screen = screens.find((s) => s.id === state.selected) ?? screens[0];
  state.selected = screen?.id ?? null;
  const t = state.target;
  const targetKept = t && screen && (t.node === screen.id
    || (callIdsOf(screen).includes(t.node) && (!t.option || optionsOf(screen, t.node).some((o) => o.key === t.option.key))));
  if (!targetKept) {
    state.target = screen ? { node: screen.id } : null;
    state.draft = null;
  }
  if (!untaggedTests().some((t) => untaggedKey(t) === state.untaggedTest)) setUntaggedTest(untaggedTests().length ? untaggedKey(untaggedTests()[0]) : null);
  const stories = state.data.stories.list;
  if (!stories.some((st) => st.id === state.story) && !unlistedMarks().some((m) => m.target.story === state.story)) {
    state.story = stories[0]?.id ?? null;
    state.storyDraft = null;
  }
  if (!candidateOf()) {
    state.candidate = null;
    state.candidateTalk = null;
  }
  dropLostNeed();
  const c = state.compose;
  const kept = c?.steps.filter((step) => step.unmapped || screens.some((sc) => sc.id === step.screen));
  if (c && kept.length !== c.steps.length) {
    if (c.editing && !kept.some((step) => step.rows === c.editing.rows) && c.editing.rows !== c.wide) c.editing = null;
    Object.assign(c, { steps: kept, at: null });
    checkCompose();
  }
  dropLostTable();
  dropLostSteps();
}

const flowPickShown = () => state.view === 'flow' && state.flowPicked;
const screenPanesShown = () => (state.view === 'list' && state.side === 'screens') || flowPickShown();

function setSelected(id, target = { node: id }) {
  for (const [key, kept] of state.pathValues) {
    if (key.startsWith(`${id}\n`) && !kept.pending && kept.errors.length && !kept.opened) state.pathValues.delete(key);
  }
  if (id !== state.selected) {
    state.openGroups.clear();
    state.openLong.clear();
  }
  state.callInfoShut = null;
  state.caseError = null;
  state.selected = id;
  state.target = target;
  state.draft = null;
  state.error = null;
  state.judgmentError = null;
}

function select(id, target) {
  setSelected(id, target);
  render();
}

function selectStory(id) {
  if (id !== state.story) {
    state.storyOpen.clear();
    state.fieldsEdit = null;
    state.fieldsSaved = null;
    state.stepsEdit = null;
    state.stepsSaved = null;
  }
  state.story = id;
  state.candidate = null;
  state.candidateTalk = null;
  state.need = null;
  state.storyDraft = null;
  state.error = null;
  state.caseError = null;
  state.storyError = null;
  state.judgmentError = null;
  render();
}

function selectCandidate(key) {
  if (key !== state.candidate) {
    state.storyOpen.clear();
    state.candidateTalk = null;
  }
  state.candidate = key;
  state.need = null;
  state.error = null;
  state.caseError = null;
  state.storyError = null;
  state.judgmentError = null;
  render();
}

function selectNeed(file) {
  if (file !== state.need) Object.assign(state, { needEdit: null, needSaved: null });
  state.need = file;
  state.candidate = null;
  state.candidateTalk = null;
  state.error = null;
  state.caseError = null;
  state.storyError = null;
  state.judgmentError = null;
  render();
}

function openNeed(file) {
  state.view = 'story';
  selectNeed(file);
}

function setUntaggedTest(key) {
  state.untaggedTest = key;
  if (state.bulk?.testKey !== key) state.bulk = key === null ? null : { testKey: key, picked: new Set(), error: null };
}

function selectUntaggedTest(key) {
  if (state.bulkBusy) return;
  setUntaggedTest(key);
  state.error = null;
  state.caseError = null;
  state.judgmentError = null;
  render();
}

function setSide(side) {
  state.side = side;
  if (side !== 'screens') state.flowPicked = false;
  state.error = null;
  state.caseError = null;
  state.judgmentError = null;
  render();
}

function openScreen(id) {
  if (state.bulkBusy) return;
  if (state.view === 'story') state.view = 'list';
  state.side = 'screens';
  select(id);
}

function openCall(id) {
  if (state.bulkBusy) return;
  state.side = 'screens';
  select(callOf(id).screens[0], { node: id });
  revealCallInfo();
}

function selectTarget(t) {
  if (t.node !== state.target?.node) state.callInfoShut = null;
  state.caseError = null;
  state.target = t;
  state.draft = null;
  state.error = null;
  state.judgmentError = null;
  render();
  revealCallInfo();
}

// 호출 정보는 호출 표 아래에 있어, 고른 뒤에 칸 밖에 놓이면 가운데 칸만 그 자리로 내린다.
function revealCallInfo() {
  revealInCenter('.call-info[open] > summary');
}

function revealCases(node) {
  revealInCenter(`${callOf(node) ? '.call-info' : '.screen-info'}[open] > .cases > h2`);
}

function revealInCenter(selector) {
  const pane = document.getElementById('center');
  const el = /** @type {HTMLElement} */ (pane.querySelector(selector));
  if (!el) return;
  const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  if (top >= 0 && top + el.offsetHeight <= pane.clientHeight) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  pane.scrollTo({ top: pane.scrollTop + top - 12, behavior: still ? 'auto' : 'smooth' });
}

