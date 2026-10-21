const CASE_GROUPS = [
  { key: 'writes', label: '쓰기 요청', hint: '메서드를 모르는 요청도 여기에 둡니다' },
  { key: 'reads', label: '조회 요청' },
  { key: 'screens', label: '화면' },
];
const METHOD_COLORS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const caseKindList = () => Object.keys(state.data.caseKinds);
const kindTargetsOf = (kind) => state.data.caseTargets[kind];
const caseGroupOf = (id) => {
  const call = callOf(id);
  return !call ? 'screens' : call.method === 'GET' ? 'reads' : 'writes';
};
const caseOrder = (a, b) => CASE_GROUPS.findIndex((g) => g.key === caseGroupOf(a)) - CASE_GROUPS.findIndex((g) => g.key === caseGroupOf(b)) || compareText(a, b);
const gapCount = (kind) => (state.data.caseGaps[kind] ?? []).reduce((n, g) => n + g.tags.length, 0);
const undecidedTotal = () => caseKindList().reduce((n, kind) => n + kindTargetsOf(kind).undecided.length, 0);
const reviewTotal = () => caseKindList().reduce((n, kind) => n + kindTargetsOf(kind).review.length, 0);
const PERSON = () => svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('path', { d: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.5 14c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5' }));

function isNewNode(id) {
  const x = baselineIndex();
  return Boolean(x && (x.added.has(id) || x.newCalls.has(id)));
}

const newUndecided = (kind) => kindTargetsOf(kind).undecided.filter(isNewNode);
const freshTip = (n) => `미판정 가운데 ${state.data.baseline.label} 지도에 없던 화면과 요청 ${n}개입니다`;

function newChip(id) {
  const tip = `${state.data.baseline.label} 지도에 없던 ${callOf(id) ? '요청' : '화면'}입니다`;
  return h('span', { class: 'chip change-new', title: tip, 'aria-label': `신규: ${tip}` }, '신규');
}

function kindCounts(kind) {
  const counts = { rule: 0, person: 0, agent: 0, out: 0 };
  for (const t of Object.values(kindTargetsOf(kind).nodes)) {
    if (t.state === 'rule') counts.rule++;
    else if (t.state === 'needed') counts[t.mark.via === undefined ? 'person' : 'agent']++;
    else if (t.state === 'not-needed') counts.out++;
  }
  return { ...counts, picked: counts.rule + counts.person + counts.agent, undecided: kindTargetsOf(kind).undecided.length, fresh: newUndecided(kind).length, review: kindTargetsOf(kind).review.length, gaps: gapCount(kind) };
}

function heldByPerson(kind, id) {
  const current = markOf({ node: id, case: kind })?.current;
  return current && current.via === undefined ? current : null;
}

function heldText(mark, history) {
  if (mark.of !== undefined && !acceptsProposal(mark, history)) return h('p', { class: 'case-held' }, `${mark.author} 가 ${fmtDate(mark.date)} 에 에이전트 판정을 되돌렸습니다`);
  if (!mark.rule) return h('p', { class: 'case-held' }, `${mark.author} 가 ${fmtDate(mark.date)} 에 이유 없이 뺐습니다`);
  return [
    h('p', { class: 'case-held' }, `${mark.author} 가 ${fmtDate(mark.date)} 에 규칙에서 뺐지만 규칙이 더는 고르지 않습니다`),
    mark.note ? h('p', { class: 'case-reason' }, '예전 이유 ', h('span', { class: 'memo' }, mark.note)) : null,
  ];
}

function heldLine(kind, id) {
  const mark = heldByPerson(kind, id);
  return mark ? heldText(mark, markOf({ node: id, case: kind }).history) : null;
}

function setCaseKind(kind) {
  if (kind === state.caseKind) return;
  Object.assign(state, { caseKind: kind, caseNode: null, caseDraft: null, caseFilter: null, caseBulkError: null, reviewError: null });
  state.casePicked.clear();
  state.reviewPicked.clear();
}

function dropLostCase() {
  const kinds = caseKindList();
  if (!kinds.includes(state.caseKind)) setCaseKind(kinds[0] ?? null);
  if (!kinds.length && state.side === 'cases') state.side = 'screens';
  if (state.caseNode !== null && !kindTargetsOf(state.caseKind)?.nodes[state.caseNode]) Object.assign(state, { caseNode: null, caseDraft: null });
  const undecided = new Set(state.caseKind === null ? [] : kindTargetsOf(state.caseKind).undecided);
  for (const id of state.casePicked) if (!undecided.has(id)) state.casePicked.delete(id);
  const review = new Set(state.caseKind === null ? [] : kindTargetsOf(state.caseKind).review);
  for (const id of state.reviewPicked) if (!review.has(id)) state.reviewPicked.delete(id);
  if (typeof state.caseFilter === 'number' && !state.data.caseKinds[state.caseKind]?.picks[state.caseFilter]) state.caseFilter = null;
  const view = undecidedView();
  if (view && ![...undecided].some((id) => view(state.caseKind, id))) state.caseFilter = null;
}

function selectCaseKind(kind) {
  if (state.bulkBusy) return;
  setCaseKind(kind);
  state.error = null;
  render();
}

function selectCaseNode(id) {
  if (state.bulkBusy || id === state.caseNode) return;
  Object.assign(state, { caseNode: id, caseDraft: null, error: null });
  render();
}

function caseKindItems() {
  return caseKindList().map((kind) => {
    const counts = kindCounts(kind);
    return h('li', { class: `${kind === state.caseKind ? 'selected' : ''}${state.bulkBusy ? ' locked' : ''}`, 'data-kind': kind, onclick: () => selectCaseKind(kind) },
      h('span', { class: 'name' },
        h('span', {}, state.data.caseKinds[kind].text), ' ', h('span', { class: 'muted mono' }, `case:${kind}`),
        h('span', { class: 'kind-counts muted' }, `대상 ${counts.picked} · ${counts.review ? `검토 중 ${counts.review} · ` : ''}미판정 ${counts.undecided}`,
          counts.fresh ? [' ', h('span', { class: 'kind-new', title: freshTip(counts.fresh) }, `(신규 ${counts.fresh})`)] : null, ` · 빈칸 ${counts.gaps}`)));
  });
}

function methodMark(call) {
  const known = METHOD_COLORS.includes(call.method);
  return h('span', { class: `method${known ? ` m-${call.method.toLowerCase()}` : ''}`, title: known ? null : '메서드를 읽지 못한 요청입니다' }, known ? call.method : '?');
}

function caseNodeName(id) {
  const call = callOf(id);
  const opens = opensOnPage(id);
  const name = h(opens ? 'button' : 'span', opens ? {
    type: 'button',
    class: 'node-name mono',
    title: call ? '이 요청을 부르는 화면을 열고 이 요청을 고릅니다' : '화면 목록에서 이 화면을 엽니다',
    disabled: state.bulkBusy,
    onclick: (e) => {
      e.stopPropagation();
      if (call) openCall(id); else openScreen(id);
    },
  } : { class: 'node-name mono' }, call ? call.path ?? id : screenLabel(id));
  const where = call
    ? `보내는 화면 ${call.screens.length ? call.screens.map(screenLabel).join(' · ') : '없음'}`
    : `컴포넌트 ${screenOf(id)?.component ?? ''}`;
  return h('span', { class: 'case-node' }, h('span', { class: 'case-node-head' }, call ? methodMark(call) : null, name), h('span', { class: 'muted where' }, where));
}

const nodeNameText = (id) => (callOf(id) ? id : screenLabel(id));

function caseRowItem(kind, id, ...rest) {
  return h('li', {
    class: `case-row${id === state.caseNode ? ' selected' : ''}`,
    'data-node': id,
    onclick: (e) => { if (!e.target.closest('input, button, label')) selectCaseNode(id); },
  }, ...rest);
}

function decidedRow(kind, id) {
  const by = pickedBy(kind, id);
  return caseRowItem(kind, id, h('span', { class: 'pick-space' }), h('span', { class: 'case-row-body' },
    h('span', { class: 'case-row-head' }, caseNodeName(id), pickChip(kind, by)),
    by.state === 'not-needed' ? h('p', { class: 'case-reason' }, `${fmtDate(by.mark.date)} · 이유 `, h('span', { class: 'memo' }, by.mark.note)) : null));
}

function caseSectionBox(kind, key, title, ids, extra = null) {
  const openKey = `${kind}\n${key}`;
  return h('details', { class: `case-list ${key}`, open: state.caseOpen.has(openKey), ontoggle: rememberOpen(state.caseOpen, openKey) },
    h('summary', {}, h('span', { class: 'title' }, `${title} ${ids.length}`)),
    extra,
    ids.length ? h('ul', { class: 'plain' }, ids.map((id) => decidedRow(kind, id))) : h('p', { class: 'muted' }, '없음'));
}

function ruleLines(kind) {
  const { picks } = state.data.caseKinds[kind];
  if (!picks.length) return h('p', { class: 'muted case-rules' }, '규칙이 없어 모든 화면과 호출이 후보입니다.');
  const { rules, nodes } = kindTargetsOf(kind);
  return h('ul', { class: 'plain case-rules' }, rules.map((r, i) => {
    const picked = [...r.screens, ...r.calls];
    const out = picked.filter((id) => nodes[id]?.state === 'not-needed').length;
    const on = state.caseFilter === i;
    return h('li', {}, h('button', {
      type: 'button',
      class: 'rule-line',
      'data-rule': String(i),
      'aria-pressed': String(on),
      title: on ? '누르면 대상 목록을 모두 보입니다' : '누르면 대상 목록에 이 규칙이 고른 것만 보입니다',
      disabled: state.bulkBusy,
      onclick: () => {
        state.caseFilter = on ? null : i;
        if (!on) state.caseOpen.add(`${kind}\nneeded`);
        renderCaseCenter();
      },
    },
      h('span', { class: 'rule-text' }, `${i + 1}. ${pickText(r.pick)}`),
      h('span', { class: 'muted' }, ` 고름 ${picked.length}${out ? ` · 대상 아님으로 뺌 ${out}` : ''}`),
      picked.length ? null : h('span', { class: 'chip rule-empty' }, '아무것도 고르지 못함')));
  }));
}

function summaryBoxes(counts) {
  const box = (n, label, sub = null, title = null) => h('div', { class: 'case-count', title }, h('strong', {}, String(n)), h('span', { class: 'muted' }, label), sub ? h('span', { class: 'muted sub' }, sub) : null);
  return h('div', { class: 'case-counts' },
    box(counts.picked, '대상', `규칙 ${counts.rule} · 사람 ${counts.person} · 에이전트 ${counts.agent}`, '규칙이 고른 것에 사람이나 에이전트가 「대상」을 다시 적으면 그쪽으로 셉니다'),
    box(counts.out, '대상 아님'),
    counts.review ? box(counts.review, '검토 중', null, '에이전트가 「대상 아님」으로 정해 리뷰어를 기다리는 후보입니다. 받아들이기 전까지는 그 전의 판정을 따릅니다') : null,
    box(counts.undecided, '미판정', counts.fresh ? `신규 ${counts.fresh}` : null, counts.fresh ? freshTip(counts.fresh) : null),
    box(counts.gaps, '시험 없는 값 칸', null, '대상인 화면과 요청에서 아직 어느 테스트도 달지 않은 경우 태그의 수입니다'));
}

const UNDECIDED_VIEWS = { person: heldByPerson, new: (kind, id) => isNewNode(id) };
const undecidedView = () => (typeof state.caseFilter === 'string' ? UNDECIDED_VIEWS[state.caseFilter] : null);
const visibleUndecided = (kind) => {
  const view = undecidedView();
  return kindTargetsOf(kind).undecided.filter((id) => !view || view(kind, id));
};
const pickedShown = (kind) => visibleUndecided(kind).filter((id) => state.casePicked.has(id));

function redrawCases(focusName) {
  renderCaseCenter();
  /** @type {HTMLElement} */ (document.querySelector(`#center input[name="${CSS.escape(focusName)}"]`))?.focus();
}

function setCasePicks(ids, on, focusName, picks = state.casePicked) {
  for (const id of ids) if (on) picks.add(id); else picks.delete(id);
  redrawCases(focusName);
}

const caseBarOff = (count) => state.bulkBusy || state.ending || !count;

function syncCaseBar() {
  const shown = state.caseKind === null ? 0 : pickedShown(state.caseKind).length;
  for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#center .case-bar button'))) button.disabled = caseBarOff(shown);
  for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#center .review-bar button'))) button.disabled = caseBarOff(state.reviewPicked.size);
}

function pickBox(name, ids, label, picks = state.casePicked) {
  const picked = ids.filter((id) => picks.has(id)).length;
  const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', name, 'aria-label': label, checked: ids.length > 0 && picked === ids.length, disabled: state.bulkBusy || !ids.length,
    onchange: (e) => setCasePicks(ids, e.target.checked, name, picks) }));
  box.indeterminate = picked > 0 && picked < ids.length;
  return box;
}

function undecidedRow(kind, id) {
  return caseRowItem(kind, id,
    h('input', { type: 'checkbox', name: id, 'aria-label': `${nodeNameText(id)} 고르기`, checked: state.casePicked.has(id), disabled: state.bulkBusy, onchange: (e) => setCasePicks([id], e.target.checked, id) }),
    h('span', { class: 'case-row-body' },
      h('span', { class: 'case-row-head' }, h('span', { class: 'chip undecided' }, '미판정'), caseNodeName(id), isNewNode(id) ? newChip(id) : null),
      heldLine(kind, id)));
}

function proposalLines(mark) {
  return [
    h('p', { class: 'case-proposal' }, `${mark.author} · ${fmtDate(mark.date)}`),
    h('p', { class: 'case-reason' }, '이유 ', h('span', { class: 'memo' }, mark.note)),
  ];
}

function reviewRow(kind, id) {
  const target = kindTargetsOf(kind).nodes[id];
  const name = `review:${id}`;
  return caseRowItem(kind, id,
    h('input', { type: 'checkbox', name, 'aria-label': `${nodeNameText(id)} 고르기`, checked: state.reviewPicked.has(id), disabled: state.bulkBusy, onchange: (e) => setCasePicks([id], e.target.checked, name, state.reviewPicked) }),
    h('span', { class: 'case-row-body' },
      h('span', { class: 'case-row-head' }, h('span', { class: 'chip review', title: '리뷰어가 받아들이기 전까지는 그 전의 판정을 따릅니다' }, '검토 중'), caseNodeName(id), target.state === 'undecided' ? null : pickChip(kind, target)),
      proposalLines(target.review)));
}

function reviewPart(kind) {
  const ids = kindTargetsOf(kind).review;
  if (!ids.length) return null;
  const count = ids.filter((id) => state.reviewPicked.has(id)).length;
  const off = caseBarOff(state.reviewPicked.size);
  const answerButton = (answer, icon, label) => h('button', { type: 'button', class: answer, title: label, 'aria-label': label, disabled: off, onclick: () => answerPicks(kind, answer) }, `${icon} ${count}`);
  return h('div', { class: 'case-review' },
    h('h2', { tabindex: '-1' }, `검토 중 ${ids.length}`),
    h('div', { class: 'review-bar' },
      h('label', {}, pickBox('pick-all-reviews', ids, '모두 고르기', state.reviewPicked), ' 모두 고르기'),
      count ? [answerButton('accept', '✓', '받아들이기'), answerButton('revert', '✕', '되돌리기')] : null,
      state.reviewError ? h('p', { class: 'error case-bar-error' }, state.reviewError) : null),
    CASE_GROUPS.map((g) => {
      const group = ids.filter((id) => caseGroupOf(id) === g.key);
      if (!group.length) return null;
      return h('div', { class: `case-group ${g.key}` },
        h('div', { class: 'case-group-head' }, h('label', {}, pickBox(`review-group:${g.key}`, group, `${g.label} 모두 고르기`, state.reviewPicked), ` ${g.label} ${group.length}`)),
        h('ul', { class: 'plain' }, group.map((id) => reviewRow(kind, id))));
    }));
}

function undecidedPart(kind) {
  const all = kindTargetsOf(kind).undecided;
  const shown = visibleUndecided(kind);
  const held = all.filter((id) => heldByPerson(kind, id)).length;
  const fresh = newUndecided(kind).length;
  const count = pickedShown(kind).length;
  const off = caseBarOff(count);
  const viewButton = (view, cls, title, label, ...content) => h('button', {
    type: 'button',
    class: cls,
    'aria-pressed': String(state.caseFilter === view),
    title,
    'aria-label': label,
    disabled: state.bulkBusy,
    onclick: () => {
      state.caseFilter = state.caseFilter === view ? null : view;
      renderCaseCenter();
    },
  }, ...content);
  return h('div', { class: 'case-undecided' },
    h('h2', { tabindex: '-1' }, `미판정 ${all.length}`),
    held || fresh ? h('div', { class: 'case-views' },
      held ? viewButton('person', 'person-only', '직접 판정: 사람이 남긴 표시 때문에 미판정에 머문 후보만 봅니다. 에이전트는 사람이 남긴 표시를 바꾸지 않습니다', `직접 판정 ${held}`, PERSON(), ` ${held}`) : null,
      fresh ? viewButton('new', 'new-only', `${state.data.baseline.label} 지도에 없던 후보만 봅니다`, `신규 ${fresh}: ${state.data.baseline.label} 지도에 없던 후보만 보기`, `신규 ${fresh}`) : null) : null,
    all.length ? h('div', { class: 'case-bar' },
      h('label', {}, pickBox('pick-all-cases', shown, '모두 고르기'), ' 모두 고르기'),
      count ? [
        h('button', { type: 'button', class: 'pick-needed', title: '고른 후보에서 이 경우를 시험합니다', disabled: off, onclick: () => saveCasePicks(kind, 'needed', '') }, `대상 (${count})`),
        h('button', { type: 'button', class: 'pick-out', title: '이유를 적고, 고른 후보에서는 이 경우를 시험하지 않습니다', disabled: off, onclick: () => askCaseOut(kind) }, `대상 아님… (${count})`),
      ] : null,
      state.caseBulkError ? h('p', { class: 'error case-bar-error' }, state.caseBulkError) : null) : null,
    CASE_GROUPS.map((g) => {
      const ids = shown.filter((id) => caseGroupOf(id) === g.key);
      if (!ids.length) return null;
      return h('div', { class: `case-group ${g.key}` },
        h('div', { class: 'case-group-head' }, h('label', {}, pickBox(`group:${g.key}`, ids, `${g.label} 모두 고르기`), ` ${g.label} ${ids.length}`), g.hint ? h('span', { class: 'muted hint' }, g.hint) : null),
        h('ul', { class: 'plain' }, ids.map((id) => undecidedRow(kind, id))));
    }),
    all.length ? null : h('p', { class: 'muted' }, '미판정 후보가 없습니다.'));
}

function renderCaseCenter() {
  clearCenterHead();
  const center = document.getElementById('center-body');
  const kind = state.caseKind;
  if (kind === null) return fill(center, h('p', { class: 'muted' }, '설정에 경우 종류(caseKinds)가 없습니다.'));
  const { nodes } = kindTargetsOf(kind);
  const ids = Object.keys(nodes).sort(caseOrder);
  const rule = typeof state.caseFilter === 'number' ? state.caseFilter : null;
  const picked = ids.filter((id) => ['rule', 'needed'].includes(nodes[id].state) && (rule === null || nodes[id].rules.includes(rule)));
  const out = ids.filter((id) => nodes[id].state === 'not-needed');
  const ruleNote = rule === null ? null : h('p', { class: 'case-filter muted' }, `규칙 ${rule + 1}이 고른 것만 보는 중 `,
    h('button', { type: 'button', onclick: () => { state.caseFilter = null; renderCaseCenter(); } }, '모두 보기'));
  fill(center,
    h('div', { class: 'title-row' }, h('h3', {}, state.data.caseKinds[kind].text), h('span', { class: 'muted mono' }, `case:${kind}`)),
    summaryBoxes(kindCounts(kind)),
    ruleLines(kind),
    caseSectionBox(kind, 'needed', '대상', picked, ruleNote),
    caseSectionBox(kind, 'not-needed', '대상 아님', out),
    reviewPart(kind),
    undecidedPart(kind));
}

function renderCaseRight(info, dock) {
  if (state.caseNode === null) {
    fill(info, h('p', { class: 'muted' }, '줄을 누르면 그 화면이나 요청의 대화가 여기에 나옵니다.'));
    return fill(dock);
  }
  const target = { node: state.caseNode };
  fill(info, talkPanel(target));
  fill(dock, markForm(target, 'caseDraft', callOf(state.caseNode) ? '호출 전체' : '화면 전체'));
}

/**
 * @param {string[]} chosen
 * @param {Set<string>} picks
 * @param {(id: string) => Promise<string>} save
 * @param {'caseBulkError' | 'reviewError'} errorKey
 * @param {string} heading
 */
async function saveEach(chosen, picks, save, errorKey, heading) {
  if (!chosen.length || state.bulkBusy) return null;
  state[errorKey] = null;
  state.bulkBusy = true;
  render();
  const saved = [];
  let failure = null;
  let reloadError = null;
  await trackOwnSave(async () => {
    const ids = [];
    for (const id of chosen) {
      try {
        ids.push(await save(id));
      } catch (err) {
        failure = `저장하지 못했습니다: ${err.message}`;
        break;
      }
      saved.push(id);
      picks.delete(id);
    }
    try {
      await load();
    } catch (err) {
      reloadError = `${saved.length ? '저장했지만 ' : ''}다시 읽지 못했습니다: ${err.message}`;
    }
    return ids;
  });
  state.bulkBusy = false;
  const names = (list) => list.map(nodeNameText).join(', ');
  state[errorKey] = failure
    ? [failure, `저장한 것 ${saved.length}: ${names(saved) || '없음'}. 저장하지 못한 것 ${chosen.length - saved.length}: ${names(chosen.slice(saved.length))}.`, reloadError].filter(Boolean).join('\n')
    : reloadError;
  if (!state.ended) render();
  if (!failure) /** @type {HTMLElement} */ (document.querySelector(heading))?.focus();
  return failure ? state[errorKey] : null;
}

function saveCasePicks(kind, status, note) {
  const chosen = pickedShown(kind);
  return saveEach(chosen, state.casePicked, (id) => postPick({ node: id, case: kind }, status, note || undefined), 'caseBulkError', '#center .case-undecided > h2');
}

function answerPicks(kind, answer) {
  const { review, nodes } = kindTargetsOf(kind);
  const chosen = review.filter((id) => state.reviewPicked.has(id));
  const seen = new Map(chosen.map((id) => [id, nodes[id].review.id]));
  return saveEach(chosen, state.reviewPicked, (id) => postAnswer(kind, id, seen.get(id), answer), 'reviewError', '#center .case-review > h2, #center .case-undecided > h2');
}

function askCaseOut(kind) {
  const chosen = () => pickedShown(kind);
  askReason({
    verb: '대상 아님',
    reasonLabel: '대상이 아닌 이유',
    describe: () => {
      const ids = chosen();
      return {
        title: `고른 ${ids.length}개에서는 이 경우를 시험하지 않습니다`,
        subject: [
          h('span', { class: 'label' }, '경우 종류'),
          h('div', {}, state.data.caseKinds[kind].text, ' ', h('span', { class: 'muted mono' }, `case:${kind}`)),
          h('span', { class: 'label' }, '고른 것'),
          h('div', { class: 'mono' }, ids.map(nodeNameText).join(', ')),
        ],
        confirm: '대상 아님',
      };
    },
    save: (reason) => saveCasePicks(kind, 'not-needed', reason),
    done: () => {},
    refocus: () => /** @type {HTMLElement} */ (document.querySelector('#center .case-bar button.pick-out'))?.focus(),
  });
}

function askNotTarget(id, kind, refocus) {
  const word = targetWord(id);
  askReason({
    verb: '대상 아님',
    reasonLabel: '대상이 아닌 이유',
    describe: () => ({
      title: `이 ${word}에서는 이 경우를 시험하지 않습니다`,
      subject: [
        h('span', { class: 'label' }, '경우 종류'),
        h('div', {}, state.data.caseKinds[kind].text, ' ', h('span', { class: 'muted mono' }, `case:${kind}`)),
        h('span', { class: 'label' }, word),
        h('div', {}, callOf(id) ? h('span', { class: 'mono' }, id) : [screenLabel(id), ' ', h('span', { class: 'muted' }, screenOf(id)?.component)]),
      ],
      confirm: '대상 아님',
    }),
    save: (reason) => takeOut({ node: id, case: kind }, reason),
    done: render,
    refocus: () => /** @type {HTMLElement} */ (document.querySelector(refocus))?.focus(),
  });
}
