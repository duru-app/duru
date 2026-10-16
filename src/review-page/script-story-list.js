const LINK_VERDICT = { open: '이어짐', configured: '설정에 적은 이동', conditioned: '조건', broken: '링크 없음', 'off-map': '판정 못 함', unknown: '판정 못 함' };
const LINK_VERDICT_TITLE = { configured: '설정의 moves 에 적은 이동으로 이어집니다' };
const storyOf = () => state.data.stories.list.find((st) => st.id === state.story);
const candidateOf = () => state.data.candidates.list.find((c) => c.key === state.candidate);
const candidateName = (key) => state.data.candidates.list.find((c) => c.key === key)?.name ?? state.data.candidates.gone?.[key] ?? key;
const stepsText = ([first, last]) => (first === last ? `단계 ${first}` : `단계 ${first}–${last}`);
const sourceView = (source, whose) => (source.record
  ? h('div', { class: 'muted mono source', title: `${whose} 방문 기록과 단계` }, `${source.record} · ${stepsText(source.steps)}`)
  : h('div', { class: 'muted mono source', title: `${whose} 시험 보고와 그 순서를 지나간 시험` }, source.report, h('ul', { class: 'plain' }, source.tests.map((t) => h('li', {}, t)))));
const storyDate = (date) => (date.length > 10 ? fmtDate(date) : date);
const storyMarkLabel = (m) => (m.target.part ? `${m.target.story} · ${tagLabel(m.target)}` : m.target.story);
const unlistedMarks = () => state.data.marks.attached.filter((m) => m.target.story !== undefined && !state.data.stories.list.some((st) => st.id === m.target.story));
const screenOf = (id) => state.data.map.screens.find((s) => s.id === id);
const screenLabel = (id) => screenOf(id)?.path ?? id;
const statusChip = (st) => h('span', { class: `chip ${st.status}`, title: STORY_STATUS[st.status].title }, STORY_STATUS[st.status].label);
const storyChips = (st) => [
  st.broken ? h('span', { class: 'chip l-broken', title: '이웃한 두 화면을 잇는 링크가 맵에 없는 자리가 있습니다' }, '링크 없음') : null,
  st.detached ? h('span', { class: 'chip l-off-map', title: `맵에서 찾을 수 없는 화면: ${st.steps.filter((s) => !s.onMap).map((s) => s.screen).join(', ')}` }, '화면 없음') : null,
  st.unjudged ? h('span', { class: 'chip l-unknown', title: '주소를 읽지 못한 링크 때문에 판정하지 못한 자리가 있습니다' }, '판정 못 함') : null,
];

function visibleStories() {
  const on = STORY_FILTERS.filter((f) => state.storyFilters.has(f.key));
  const statuses = on.filter((f) => f.status);
  const q = state.storyQuery.trim().toLowerCase();
  return state.data.stories.list.filter((st) => (!statuses.length || statuses.some((f) => f.keep(st))) && on.every((f) => f.status || f.keep(st))
    && (!q || st.name.toLowerCase().includes(q) || st.id.toLowerCase().includes(q)));
}

const storyFilterBox = (f, redraw) => h('label', { title: f.title }, h('input', { type: 'checkbox', name: f.key, checked: state.storyFilters.has(f.key), onchange: (e) => {
  if (e.target.checked) state.storyFilters.add(f.key); else state.storyFilters.delete(f.key);
  redraw();
} }), f.label);

// 검색창을 새로 만들면 조합 중이던 한글이 끊긴다.
const storyFilters = (refill, redraw) => h('div', { class: 'filters' },
  h('input', { type: 'search', placeholder: '이름이나 ID 로 찾기', 'aria-label': '스토리 찾기', value: state.storyQuery, oninput: (e) => { state.storyQuery = e.target.value; refill(); } }),
  h('fieldset', {}, h('legend', {}, '상태 · 하나라도 맞으면'), STORY_FILTERS.filter((f) => f.status).map((f) => storyFilterBox(f, redraw))),
  h('fieldset', {}, h('legend', {}, '그리고'), STORY_FILTERS.filter((f) => !f.status).map((f) => storyFilterBox(f, redraw))));

const storyRow = (st, attrs) => h('li', attrs,
  h('span', { class: 'name' }, h('span', {}, st.name), h('div', { class: 'muted mono' }, st.id),
    h('div', { class: 'chips' }, st.status === 'pass' ? null : statusChip(st), storyChips(st), talkCount(entriesAt({ story: st.id })))),
  markChip(markOf({ story: st.id })),
  h('span', { class: 'count' }, `화면 ${st.steps.length}`));

function storyRows(row) {
  const visible = visibleStories();
  return visible.length ? visible.map(row) : [h('li', { class: 'muted' }, '해당하는 스토리가 없습니다.')];
}

const tabStoryRow = (st) => storyRow(st, { class: st.id === state.story && !state.candidate ? 'selected' : '', onclick: () => selectStory(st.id) });

function storyItems() {
  return [
    storyFilters(() => fill(document.getElementById('story-list'), storyRows(tabStoryRow)), renderLeft),
    h('ul', { class: 'screens', id: 'story-list' }, storyRows(tabStoryRow)),
  ];
}

function flowStoryRow(st) {
  const on = state.storyPath?.id === st.id;
  const pick = () => pickStory(on ? '' : st.id);
  return storyRow(st, {
    class: on ? 'selected' : '', 'data-story': st.id, role: 'button', tabindex: '0', 'aria-pressed': String(on),
    title: on ? '다시 누르면 메인 흐름으로 돌아갑니다' : '누르면 이 스토리의 단계를 차례대로 그립니다',
    onclick: pick,
    onkeydown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pick();
    },
  });
}

let paneCompose = null;

const leaveComposeButton = () => h('button', { class: 'leave-compose', title: '쓰던 순서는 그대로 두고 스토리 목록을 봅니다', onclick: leaveCompose }, '스토리 목록');

function syncComposeForm(root) {
  fill(root.querySelector('#compose-reach'), ...composeReach(state.compose));
  root.querySelector('button.save-compose').disabled = !canSaveCompose(state.compose);
}

// 쓰는 동안 단계만 다시 그리고 ID · 이름 · 메모 칸은 그대로 둔다. 다시 만들면 조합 중이던 한글이 끊긴다.
function renderStoryPane({ rebuild = false } = {}) {
  const pane = document.getElementById('flow-stories');
  if (pane.hidden) return fill(pane);
  if (!flowComposing()) {
    paneCompose = null;
    return fill(pane,
      h('div', { class: 'stories-body' },
        newStoryButton(),
        storyFilters(() => fill(document.getElementById('flow-story-list'), storyRows(flowStoryRow)), renderStoryPane),
        h('ul', { class: 'screens', id: 'flow-story-list' }, storyRows(flowStoryRow))));
  }
  const steps = pane.querySelector('.compose-steps');
  if (steps && !rebuild && paneCompose === state.compose) {
    fill(steps, composeCenter());
    return syncComposeForm(pane);
  }
  paneCompose = state.compose;
  fill(pane,
    h('div', { class: 'stories-body compose-pane' },
      h('div', { class: 'compose-head' }, leaveComposeButton()),
      h('div', { class: 'compose-steps' }, composeCenter()),
      composeForm()));
}

let slideEnd = null;

function foldStories() {
  const main = document.querySelector('main');
  main.classList.add('sliding');
  clearTimeout(slideEnd);
  slideEnd = setTimeout(() => {
    main.classList.remove('sliding');
    refitFlow();
  }, parseFloat(getComputedStyle(main).transitionDuration) * 1000 + 50);
  state.storiesFolded = !state.storiesFolded;
  render();
  document.getElementById('stories-tab').focus();
}

function discardedGroup(discarded) {
  if (!discarded.length) return null;
  return h('details', { class: 'discarded-candidates', open: state.discardedOpen, ontoggle: (e) => { state.discardedOpen = e.currentTarget.open; } },
    h('summary', { title: '버린 후보입니다. 같은 화면 순서를 여러 번 버렸으면 가장 늦게 버린 것을 보입니다.' }, `버린 후보 ${discarded.length}`),
    h('ul', { class: 'plain', id: 'discarded-list' }, discarded.map((d) => h('li', {},
      h('div', {}, d.name),
      h('div', { class: 'steps mono' }, d.screens.map(screenLabel).join(' → ')),
      judgmentMeta(d, '이유'),
      h('button', { class: 'undiscard', disabled: state.storyWriting, title: '되돌린 기록을 버린 기록 옆에 남기고, 이 화면 순서를 후보 목록에 다시 올립니다.', onclick: () => undiscard(d) }, '되돌리기')))),
    state.undiscardError ? h('p', { class: 'error undiscard-error' }, state.undiscardError) : null);
}

async function undiscard(d) {
  if (state.storyWriting) return;
  state.undiscardError = null;
  if (!(await writeStories('/api/candidates/undiscard', { screens: d.screens }))) {
    state.undiscardError = takeStoryError();
    return render();
  }
  const key = d.screens.join(' > ');
  if (state.data.candidates.list.some((c) => c.key === key)) selectCandidate(key);
  else render();
}

function candidateGroup() {
  const { list, notices, stale, discarded } = state.data.candidates;
  return [
    h('h2', { title: '방문 기록이나 시험의 실행 기록에서 나온 화면 순서입니다. 받으면 스토리 파일이 되고, 버리면 다시 나오지 않습니다.' }, `후보 ${list.length}`),
    stale
      ? h('p', { class: 'error', id: 'candidates-stale' }, stale)
      : list.length
      ? h('ul', { class: 'screens', id: 'candidate-list' }, list.map((c) => {
          const n = commentsIn(markOf({ candidate: c.key }));
          return h('li', { class: c.key === state.candidate ? 'selected' : '', onclick: () => selectCandidate(c.key) },
            h('span', { class: 'name' }, h('span', {}, c.name), h('div', { class: 'muted mono' }, c.source.record ?? c.source.report), h('div', { class: 'chips' }, storyChips(c))),
            n ? h('button', { class: 'part-count', title: '이 후보에 남긴 대화를 엽니다', onclick: (e) => { e.stopPropagation(); talkOnCandidate(c.key, true); } }, unansweredDot(entriesAt({ candidate: c.key })), `코멘트 ${n}`) : null,
            h('button', { class: 'bubble', title: '이 후보에 코멘트를 씁니다', 'aria-label': `후보 「${c.name}」에 코멘트`, onclick: (e) => { e.stopPropagation(); talkOnCandidate(c.key, false); } }, BUBBLE()),
            h('span', { class: 'count' }, `화면 ${c.steps.length}`));
        }))
      : h('p', { class: 'muted', title: '설정의 visitRecords 에 적은 방문 기록과, tests 에 적은 Playwright 보고의 실행 기록에서 나온 후보가 여기 놓입니다.' }, '없음'),
    discardedGroup(discarded),
    ...(notices.length ? [
      h('h2', { title: '형식이 틀려 건너뛴 방문 기록과 버린 후보 파일입니다.' }, `건너뛴 파일 ${notices.length}`),
      h('ul', { class: 'plain notices', id: 'candidate-notices' }, notices.map((n) => h('li', {}, h('code', {}, n.file), h('div', { class: 'error' }, n.reason)))),
    ] : []),
  ];
}

function renderPickList() {
  const c = state.compose;
  const q = c.query.trim().toLowerCase();
  const visible = state.data.map.screens.filter((sc) => !q || sc.id.toLowerCase().includes(q));
  const list = document.getElementById('pick-list');
  fill(list, ...visible.map((sc) => {
    const used = c.screens.filter((id) => id === sc.id).length;
    return h('li', { title: `${sc.path} ${sc.component}\n누르면 새 스토리의 단계로 넣습니다`, onclick: () => addComposeScreen(sc.id) },
      h('span', { class: 'name' }, h('span', {}, routeSegments(sc.path)), ' ', h('span', { class: 'muted component' }, sc.component)),
      used ? h('span', { class: 'count' }, `넣음 ${used}`) : null);
  }));
  if (!visible.length) list.append(h('li', { class: 'muted' }, '해당하는 화면이 없습니다.'));
}

function storyList() {
  const { list, notices, stale } = state.data.stories;
  return [
    newStoryButton(),
    ...(stale
      ? [h('p', { class: 'error' }, stale)]
      : list.length
      ? storyItems()
      : [h('p', { class: 'muted' }, '스토리 파일이 없습니다. 스토리 하나를 파일 하나로 ', h('code', {}, state.data.storiesDir), ' 에 둡니다.')]),
    ...candidateGroup(),
    ...markList('떨어져 나감', 'detached', state.data.marks.detached.filter((m) => m.target.story !== undefined || m.target.candidate !== undefined), (m) => (m.target.candidate !== undefined ? `후보 ${candidateName(m.target.candidate)}` : storyMarkLabel(m)),
      h('p', { class: 'muted', title: '스토리 파일이 사라진 스토리와, 받거나 버려 목록에서 빠진 후보에 남긴 코멘트' }, '없음')),
    h('h2', {}, `읽지 못한 스토리 파일 ${notices.length}`),
    notices.length
      ? h('ul', { class: 'plain notices' }, notices.map((n) => h('li', {}, h('code', {}, n.file), h('div', { class: 'error' }, n.reason))))
      : h('p', { class: 'muted' }, '형식이 틀렸거나 ID 가 겹쳐 건너뛴 파일이 여기 남습니다.'),
    unlistedMarks().length
      ? h('div', { title: '파일을 읽지 못했거나 맵이 오래되어 목록에 없는 스토리에 남은 코멘트' },
          markList('목록 밖 스토리 코멘트', 'unread-marks', unlistedMarks(), storyMarkLabel, null, selectStory))
      : null,
  ];
}

