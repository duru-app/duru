const STEP_KIND = { open: '열기', press: '누르기', write: '넣기', assert: '확인' };
const STEP_KIND_TITLE = { open: '이 주소를 열었습니다', press: '누르거나 마우스 · 키보드를 썼습니다', write: '상자에 값을 넣거나 골랐습니다', assert: '확인문을 실행했습니다' };

/** @typedef {PageData['testSteps'][string][string][number]} TestStepLine */

const stepsPlace = (node, t) => JSON.stringify([node, t.source, t.file, t.line, t.title, t.project ?? null]);
const stepsRuns = (t) => (t.steps ? state.data.testSteps?.[t.steps] : undefined);

function noStepsText(t) {
  if (t.status === 'pending') return '이 테스트는 건너뛰어 돌지 않았으므로 한 일이 없습니다.';
  const notice = (state.data.tests.traceNotices ?? []).find((n) => n.test.title === t.title && n.test.file === t.file && n.test.line === t.line);
  if (notice) return `이 테스트의 trace 파일을 읽지 못해 한 일을 알 수 없습니다. ${notice.reason}.`;
  if (t.unmatched !== undefined || t.level) return '이 tests.json 에는 테스트가 한 일이 적혀 있지 않습니다. duru rebuild 를 다시 실행하세요.';
  return '이 테스트는 trace 파일 없이 돌아 한 일을 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.';
}

function focusSteps(place, selector) {
  /** @type {HTMLElement} */ (document.querySelector(`[data-steps="${CSS.escape(place)}"]${selector}`))?.focus();
}

function toggleSteps(place, t) {
  if (state.openSteps.has(place)) state.openSteps.delete(place);
  else state.openSteps.set(place, t.project ?? '');
  render();
  focusSteps(place, '.steps-toggle');
}

function stepsButton(node, t) {
  if (t.format !== 'playwright') return null;
  const place = stepsPlace(node, t);
  const open = state.openSteps.has(place);
  return h('button', {
    class: 'steps-toggle', 'data-steps': place, 'aria-expanded': String(open),
    title: open ? '이 테스트가 한 일을 접습니다' : '이 테스트가 연 화면 · 넣은 값 · 보낸 호출을 차례대로 펼칩니다',
    onclick: (e) => { e.stopPropagation(); toggleSteps(place, t); },
    onkeydown: (e) => e.stopPropagation(),
  }, '단계');
}

const shownAddress = (url) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '') || '/';

function stepPlace(line) {
  if (line.screen) return h('span', { class: 'screen-path', title: line.screen }, screenLabel(line.screen));
  if (line.path) return h('span', { class: 'muted mono', title: '맵에 없는 화면입니다' }, line.path);
  return h('span', { class: 'muted', title: '앱의 주소가 아닌 빈 화면에서 한 동작입니다' }, '앱 밖');
}

function writtenValue(line) {
  if (line.checked !== undefined) return h('span', { class: 'step-value' }, line.checked ? '켬' : '끔');
  if (line.value === undefined) return null;
  return line.value === '' ? h('span', { class: 'muted step-value', title: '빈 값을 넣어 상자를 비웠습니다' }, '빈 값') : h('code', { class: 'step-value' }, line.value);
}

function testStepItem(/** @type {TestStepLine} */ line) {
  if (line.kind === 'request') return testRequestItem(line);
  return h('li', { class: `step-line ${line.kind}` },
    h('span', { class: `chip step-${line.kind}`, title: [STEP_KIND_TITLE[line.kind], line.method && `(${line.method})`].filter(Boolean).join(' ') }, STEP_KIND[line.kind]), ' ',
    stepPlace(line),
    line.kind === 'write' ? [' ', line.box ? h('span', { class: 'step-box' }, boxWords(line.box)) : h('span', { class: 'muted step-unread', title: line.selector ?? null }, '찾은 상자를 읽지 못함')] : null,
    line.kind === 'write' && writtenValue(line) ? [' ', writtenValue(line)] : null,
    line.failed ? [' ', h('span', { class: 'chip fail', title: '이 동작은 오류로 끝났습니다' }, '실패')] : null);
}

function testRequestItem(line) {
  const status = line.status === null
    ? h('span', { class: 'chip status-none', title: '응답을 받지 못했습니다' }, '응답 없음')
    : h('span', { class: `chip status${line.status >= 400 ? ' status-error' : ''}`, title: '응답 상태' }, String(line.status));
  const body = [h('span', { class: 'mono', title: line.url }, `${line.method} ${shownAddress(line.url)}`), ' ', status];
  if (line.call && opensOnPage(line.call)) {
    return h('li', { class: 'request-line on-map' },
      h('button', { class: 'open-call', title: '이 호출을 부르는 화면을 열고 이 호출을 고릅니다', onclick: (e) => { e.stopPropagation(); openCall(line.call); } }, body));
  }
  return h('li', { class: 'request-line', title: line.call ? null : '맵에 없는 호출입니다' }, body);
}

function pickStepsProject(place, project) {
  state.openSteps.set(place, project);
  render();
  focusSteps(place, ` button[data-project="${CSS.escape(project)}"]`);
}

function stepsFold(node, t) {
  if (t.format !== 'playwright') return null;
  const place = stepsPlace(node, t);
  if (!state.openSteps.has(place)) return null;
  const runs = stepsRuns(t);
  if (!runs) return h('div', { class: 'test-steps', 'data-steps': place }, h('p', { class: 'muted' }, noStepsText(t)));
  const projects = Object.keys(runs);
  const wanted = state.openSteps.get(place);
  const picked = Object.hasOwn(runs, wanted) ? wanted : projects[0];
  const lines = runs[picked];
  return h('div', { class: 'test-steps', 'data-steps': place },
    projects.length > 1 ? h('div', { class: 'step-projects', role: 'group', 'aria-label': '프로젝트' }, projects.map((p) => h('button', {
      class: `chip step-project${p === picked ? ' on' : ''}`, 'data-project': p, 'aria-pressed': String(p === picked), title: `${p || '프로젝트 이름 없이'} 돈 실행의 단계를 봅니다`,
      onclick: (e) => { e.stopPropagation(); pickStepsProject(place, p); },
    }, p || '이름 없음'))) : null,
    lines.length ? h('ol', { class: 'step-lines' }, lines.map(testStepItem)) : h('p', { class: 'muted' }, '이 실행은 화면을 열지도 호출을 보내지도 않았습니다.'));
}
