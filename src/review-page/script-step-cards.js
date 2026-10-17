const LINK_NEEDS_LABEL = '들어오는 링크 조건';

function findNeed(use) {
  const { list, notices } = state.data.needs;
  const need = list.find((n) => n.file === use);
  if (need) return { need };
  const notice = notices.find((n) => n.file === needPath(use));
  return notice ? { unread: notice.reason } : null;
}

function needWord(n) {
  if (typeof n === 'string') return n;
  const found = findNeed(n.use);
  return found?.need ? found.need.name : `${needPath(n.use)} ${found ? '읽지 못함' : '없음'}`;
}

function needItem(n) {
  if (typeof n === 'string') return n;
  const found = findNeed(n.use);
  if (!found) return h('span', { class: 'need-missing', title: '공통 조건 폴더에 이 파일이 없습니다' }, needWord(n));
  if (!found.need) return h('span', { class: 'need-unread', title: `공통 조건 파일을 읽지 못했습니다: ${found.unread}` }, needWord(n));
  return h('button', { type: 'button', class: 'need-use', title: `${needPath(n.use)}\n${found.need.text}`, onclick: () => openNeed(n.use) },
    h('span', { class: 'need-kind' }, '공통 조건'), ' ', found.need.name);
}

const BOX_WORDS = { placeholder: '안내 글', label: '라벨', testId: '테스트 ID' };
const boxWords = (box) => Object.keys(BOX_WORDS).filter((k) => box[k] !== undefined).map((k) => `${BOX_WORDS[k]} 「${box[k]}」`).join(' 또는 ') + (box.nth ? ` · ${box.nth} 번째` : '');
const inputRow = (input) => h('tr', {},
  h('td', { class: 'input-box' }, boxWords(input.box)),
  h('td', { class: 'input-value mono' }, input.value),
  h('td', {}, h('span', { class: 'chip input-unchecked', title: 'duru 가 코드에서 이 상자를 찾아보지 않았습니다' }, '확인 안 됨')));
const inputsRow = (inputs) => (inputs?.length ? h('div', { class: 'written-row inputs' }, h('span', { class: 'written-label' }, '입력값'), h('table', { class: 'written-inputs' }, h('tbody', {}, inputs.map(inputRow)))) : null);
const writtenRow = (cls, label, lines, item = (x) => x) => (lines?.length ? h('div', { class: `written-row ${cls}` }, h('span', { class: 'written-label' }, label), h('ul', {}, lines.map((x) => h('li', {}, item(x))))) : null);
const writtenRows = (fields, needLabel, expectLabel) => [writtenRow('needs', needLabel, fields?.needs, needItem), inputsRow(fields?.inputs), writtenRow('expects', expectLabel, fields?.expects)].filter(Boolean);
const linkWritten = (fields) => (fields?.linkNeeds?.length ? h('div', { class: 'link-written written' }, writtenRow('link-needs', LINK_NEEDS_LABEL, fields.linkNeeds, needItem)) : null);

const hasWritten = (fields) => Boolean(fields?.needs?.length || fields?.inputs?.length || fields?.expects?.length);

function stepItem(step, i, recordSteps, story, fields) {
  const records = recordSteps ? h('span', { class: 'records muted', title: '방문 기록에서 이 화면에 머문 단계' }, stepsText(recordSteps)) : null;
  const slot = (name) => (story ? slotRow(name, stepTarget(story, i, step.screen), SLOT_WORDS.step) : name);
  // 적힌 글을 선택하려고 클릭해도 화면이 열리지 않게 이벤트 전파를 막는다.
  const written = hasWritten(fields) ? h('div', { class: 'step-written written', title: '', onclick: (e) => e.stopPropagation() }, writtenRows(fields, '조건', '기대 결과')) : null;
  if (!step.onMap) {
    return h('div', { class: `step off-map${written ? ' has-written' : ''}`, 'data-step': i },
      h('span', { class: 'no' }, i + 1),
      slot(h('span', { class: 'name slot-text' }, h('div', { class: 'muted mono' }, step.screen))),
      records,
      h('span', { class: 'chip l-off-map' }, '맵에 없는 화면'),
      written);
  }
  const s = screenOf(step.screen);
  return h('div', { class: `step on-map${written ? ' has-written' : ''}`, 'data-step': i, title: '화면 목록에서 이 화면을 엽니다', onclick: () => openScreen(s.id) },
    h('span', { class: 'no' }, i + 1),
    slot(h('span', { class: 'name slot-text' }, screenHead(s), stepTests(s.id))),
    records,
    written);
}

function depthCounts(tests, empty) {
  if (!tests.length) return h('div', { class: 'step-tests' }, h('span', { class: 'none' }, empty));
  return h('div', { class: 'step-tests' }, state.data.depths.map((d) => {
    const at = tests.filter((t) => t.depth === d);
    return at.length ? h('span', { title: at.map((t) => `${TEST_STATUS[t.status]} ${t.title}`).join('\n') }, DEPTH_LABELS[d], ' ', countsOf(at)) : null;
  }));
}

const stepTests = (id) => depthCounts(testsOf(id), '화면 테스트 없음');

const wayItem = (w, scope = null) => h('li', {}, h('code', {}, `${w.file}:${w.line}`),
  w.conditions.length ? w.conditions.map((g) => accessGuard(g, scope, state.storyOpen)) : h('span', { class: 'muted' }, ' 조건 없음'));

const unknownList = (links) => h('ul', { class: 'plain ways unknown-links' }, links.map((u) => h('li', {}, h('code', {}, `${u.file}:${u.line}`), ' → ', h('code', {}, u.to))));
const skippedLinks = (links) => [h('div', { class: 'muted skipped' }, '판정에서 뺀 링크'), unknownList(links)];

function linkItem(l, story, i, fields) {
  const head = h('span', { class: 'slot-text' },
    h('span', { class: `chip link-verdict l-${l.verdict}`, title: LINK_VERDICT_TITLE[l.verdict] }, LINK_VERDICT[l.verdict]),
    l.verdict === 'off-map' ? h('span', { class: 'muted' }, ' 화면 없음') : null,
    l.verdict === 'configured' ? h('span', { class: 'muted' }, ` ${l.reasons.join(', ')}`) : null,
    l.verdict === 'unknown' ? h('span', { class: 'muted' }, ' 주소 못 읽은 링크') : null);
  return h('div', { class: `link l-${l.verdict}`, 'data-hop': i },
    story ? slotRow(head, hopTarget(story, i, l), SLOT_WORDS.hop) : head,
    l.verdict === 'broken' ? goesOn(l.from) : null,
    l.verdict === 'unknown' ? unknownList(l.unknownLinks) : null,
    l.ways.length ? h('ul', { class: 'plain ways' }, l.ways.map((w) => wayItem(w))) : null,
    l.ways.length > 0 && l.unknownLinks ? skippedLinks(l.unknownLinks) : null,
    linkWritten(fields));
}

