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
const STILL_INPUT = {
  noApp: '앱 화면에서 이 상자를 찾아보는 것은 설정에 app 을 적어 duru 가 앱을 띄울 때만 됩니다',
  offMap: '이 단계의 화면이 맵에 없어, 앱을 어느 화면으로 띄울지 정하지 못합니다. 앱 화면에서 상자를 짚을 수 없습니다',
  compose: '기록하는 동안 앱에서 직접 값을 넣은 상자라 따로 짚지 않습니다. 스토리로 저장한 뒤 스토리 카드에서 눌러 짚어 볼 수 있습니다',
  order: '화면 순서를 고치는 동안에는 상자를 짚지 않습니다. 순서를 고친 뒤 단계 카드에서 눌러 짚어 볼 수 있습니다',
};
const PRESS_INPUT = '누르면 오른쪽 칸에 띄운 앱 화면에서 이 상자를 짚어 보입니다';
const FOUND_INPUT = '줄을 눌렀을 때 띄운 앱 화면에서 이 상자를 찾았습니다. 띄운 앱의 데이터에 따라 달라지므로 파일에는 남기지 않습니다';
const UNCHECKED_INPUT = '아직 이 줄을 눌러 앱 화면에서 찾아보지 않았습니다';

function inputChip(found, still) {
  if (still) return h('span', { class: 'chip input-unchecked', title: STILL_INPUT[still] }, '확인 안 됨');
  if (!found) return h('span', { class: 'chip input-unchecked', title: UNCHECKED_INPUT }, '확인 안 됨');
  return found.found
    ? h('span', { class: 'chip input-found', title: FOUND_INPUT }, '화면에서 찾음')
    : h('span', { class: 'chip input-missing', title: found.reason }, '못 찾음');
}

// line 은 이 입력값이 놓인 자리다: 스토리나 후보의 단계 카드면 { kind: 'step', step, screen, onMap }, 그 밖에는 { kind: 'compose' | 'order' }.
function inputRow(input, row, line) {
  const words = h('td', { class: 'input-box' }, boxWords(input.box));
  const value = h('td', { class: 'input-value mono' }, input.value);
  const still = !state.data.app ? 'noApp' : line.kind !== 'step' ? line.kind : line.onMap ? null : 'offMap';
  if (still) return h('tr', { class: 'input-still', title: STILL_INPUT[still] }, words, value, h('td', {}, inputChip(null, still)));
  const point = { step: line.step, screen: line.screen, row, box: input.box, value: input.value };
  const found = boxFindOf(line.screen, input.box);
  const on = state.point?.step === line.step && state.point.row === row;
  const press = () => pressPoint(point);
  return [
    h('tr', {
      class: `point-line${on ? ' on' : ''}`,
      tabindex: 0,
      title: PRESS_INPUT,
      onclick: press,
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!e.repeat) press();
      },
    }, words, value, h('td', {}, inputChip(found, null))),
    found && !found.found ? h('tr', { class: 'point-reason' }, h('td', { colspan: 3 }, found.reason)) : null,
  ].filter(Boolean);
}

const inputsRow = (inputs, line) => (inputs?.length ? h('div', { class: 'written-row inputs' }, h('span', { class: 'written-label' }, '입력값'), h('table', { class: 'written-inputs' }, h('tbody', {}, inputs.flatMap((input, row) => inputRow(input, row, line))))) : null);
const writtenRow = (cls, label, lines, item = (x) => x) => (lines?.length ? h('div', { class: `written-row ${cls}` }, h('span', { class: 'written-label' }, label), h('ul', {}, lines.map((x) => h('li', {}, item(x))))) : null);
const writtenRows = (fields, needLabel, expectLabel, line) => [writtenRow('needs', needLabel, fields?.needs, needItem), inputsRow(fields?.inputs, line), writtenRow('expects', expectLabel, fields?.expects)].filter(Boolean);
const linkWritten = (fields) => (fields?.linkNeeds?.length ? h('div', { class: 'link-written written' }, writtenRow('link-needs', LINK_NEEDS_LABEL, fields.linkNeeds, needItem)) : null);

const hasWritten = (fields) => Boolean(fields?.needs?.length || fields?.inputs?.length || fields?.expects?.length);

function stepItem(step, i, recordSteps, story, fields) {
  const records = recordSteps ? h('span', { class: 'records muted', title: '방문 기록에서 이 화면에 머문 단계' }, stepsText(recordSteps)) : null;
  const slot = (name) => (story ? slotRow(name, stepTarget(story, i, step.screen), SLOT_WORDS.step) : name);
  // 적힌 글을 선택하려고 클릭해도 화면이 열리지 않게 이벤트 전파를 막는다.
  const written = hasWritten(fields) ? h('div', { class: 'step-written written', title: '', onclick: (e) => e.stopPropagation() }, writtenRows(fields, '조건', '기대 결과', { kind: 'step', step: i, screen: step.screen, onMap: step.onMap })) : null;
  const place = { kind: 'step', step: i + 1, screen: step.screen };
  const button = story ? fieldsButton(story, place, Boolean(written)) : null;
  const below = story ? fieldsBelow(story, place, written) : [written].filter(Boolean);
  const wraps = below.length ? ' has-written' : '';
  if (!step.onMap) {
    return h('div', { class: `step off-map${wraps}`, 'data-step': i },
      h('span', { class: 'no' }, i + 1),
      slot(h('span', { class: 'name slot-text' }, h('div', { class: 'muted mono' }, step.screen))),
      records,
      h('span', { class: 'chip l-off-map' }, '맵에 없는 화면'),
      button,
      below);
  }
  const s = screenOf(step.screen);
  return h('div', { class: `step on-map${wraps}`, 'data-step': i, title: '화면 목록에서 이 화면을 엽니다', onclick: () => openScreen(s.id) },
    h('span', { class: 'no' }, i + 1),
    slot(h('span', { class: 'name slot-text' }, screenHead(s), stepTests(s.id))),
    records,
    button,
    below);
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
  const place = { kind: 'link', step: i + 2, screen: l.to };
  const head = h('span', { class: 'slot-text' },
    h('span', { class: `chip link-verdict l-${l.verdict}`, title: LINK_VERDICT_TITLE[l.verdict] }, LINK_VERDICT[l.verdict]),
    l.verdict === 'off-map' ? h('span', { class: 'muted' }, ' 화면 없음') : null,
    l.verdict === 'configured' ? h('span', { class: 'muted' }, ` ${l.reasons.join(', ')}`) : null,
    l.verdict === 'unknown' ? h('span', { class: 'muted' }, ' 주소 못 읽은 링크') : null);
  return h('div', { class: `link l-${l.verdict}${l.walks === 0 ? ' unwalked' : ''}`, 'data-hop': i },
    story ? slotRow(head, hopTarget(story, i, l), SLOT_WORDS.hop) : head,
    l.walks !== undefined ? h('div', { class: 'walks muted', title: '통과한 스토리 테스트 가운데, trace 를 보면 앞 화면에서 곧장 이 화면으로 넘어간 테스트 수' }, l.walks ? `스토리 테스트 ${l.walks}개가 지나감` : '지나간 스토리 테스트 없음') : null,
    l.passedBy ? h('div', { class: 'walks moves-missing' }, `맵에는 링크가 없지만 통과한 테스트 ${l.passedBy}개가 이 사이를 지나갔습니다. 설정의 moves 가 빠졌을 수 있습니다`) : null,
    l.verdict === 'broken' ? goesOn(l.from) : null,
    l.verdict === 'unknown' ? unknownList(l.unknownLinks) : null,
    l.ways.length ? h('ul', { class: 'plain ways' }, l.ways.map((w) => wayItem(w))) : null,
    l.ways.length > 0 && l.unknownLinks ? skippedLinks(l.unknownLinks) : null,
    story ? [fieldsButton(story, place, Boolean(fields?.linkNeeds?.length)), ...fieldsBelow(story, place, linkWritten(fields))] : linkWritten(fields));
}

