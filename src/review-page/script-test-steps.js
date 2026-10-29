const STEP_KIND = { open: '열기', press: '누르기', write: '넣기', assert: '확인' };
const STEP_KIND_TITLE = { open: '이 주소를 열었습니다', press: '누르거나 마우스 · 키보드를 썼습니다', write: '상자에 값을 넣거나 골랐습니다', assert: '확인문을 실행했습니다' };

/** @typedef {PageData['testSteps'][string][string][number]} TestStepLine */

const stepsPlace = (node, t) => JSON.stringify([node, t.source, t.file, t.line, t.title, t.project ?? null]);
const stepsRuns = (t) => (t.steps ? state.data.testSteps?.[t.steps] : undefined);

function noStepsText(t) {
  if (t.status === 'pending') return '이 테스트는 건너뛰어 돌지 않았으므로 한 일이 없습니다.';
  const notice = traceNoticeOf(t);
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

const shotView = /** @type {HTMLDialogElement} */ (document.getElementById('shot-view'));
shotView.querySelector('button.close').addEventListener('click', () => shotView.close());
const shotUrl = (name) => `/test-shots/${encodeURIComponent(name)}`;

function openShot(name) {
  /** @type {HTMLImageElement} */ (shotView.querySelector('img')).src = shotUrl(name);
  shotView.showModal();
}

const shotThumb = (line) => (line.shot ? h('button', {
  class: 'shot-thumb', title: '이 동작이 끝난 뒤의 화면을 크게 봅니다', 'aria-label': '화면 그림 크게 보기',
  onclick: (e) => { e.stopPropagation(); openShot(line.shot); },
}, h('img', { src: shotUrl(line.shot), alt: '', loading: 'lazy' })) : null);

function shownProject(node, t) {
  const picked = state.openSteps.get(stepsPlace(node, t));
  return picked !== undefined && Object.hasOwn(stepsRuns(t) ?? {}, picked) ? picked : t.project ?? '';
}

const replayView = /** @type {HTMLDialogElement} */ (document.getElementById('replay-view'));
const replayPart = (selector) => /** @type {HTMLElement} */ (replayView.querySelector(selector));
const replayControl = (name) => /** @type {HTMLButtonElement} */ (replayView.querySelector(`button.${name}`));
const REPLAY_STEP_MS = 2000;
/** @type {{ lines: TestStepLine[], at: number, playing: boolean, timer: ReturnType<typeof setTimeout> | undefined, fetched: string | null }} */
const replay = { lines: [], at: 0, playing: false, timer: undefined, fetched: null };

function shotUntil(lines, at) {
  for (let i = at; i >= 0; i--) if (lines[i].shot) return lines[i].shot;
  return null;
}

function drawReplay() {
  clearTimeout(replay.timer);
  const { lines, at } = replay;
  const last = at === lines.length - 1;
  if (last) replay.playing = false;
  const shot = shotUntil(lines, at);
  const img = /** @type {HTMLImageElement} */ (replayView.querySelector('img'));
  if (shot) img.src = shotUrl(shot);
  else img.removeAttribute('src');
  img.hidden = !shot;
  replayPart('.no-shot').hidden = Boolean(shot);
  replayPart('.replay-count').textContent = `${at + 1}/${lines.length}`;
  fill(replayPart('.replay-line'), testStepItem(lines[at], true));
  const pause = replayControl('pause');
  const [word, title] = replay.playing ? ['멈춤', '이 단계에서 멈춥니다'] : last ? ['처음부터', '첫 단계부터 다시 넘깁니다'] : ['계속', '이 단계부터 다시 넘깁니다'];
  pause.textContent = word;
  pause.title = title;
  pause.setAttribute('aria-label', `${word} — ${replay.playing ? '넘기기를 멈춤' : '다시 넘기기'}`);
  const turnOff = (button, off) => {
    if (off && document.activeElement === button) pause.focus();
    button.disabled = off;
  };
  turnOff(replayControl('back'), at === 0);
  turnOff(replayControl('next'), last);
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    const next = line.kind !== 'request' && line.shot;
    if (!next) continue;
    if (next !== replay.fetched) new Image().src = shotUrl(next);
    replay.fetched = next;
    break;
  }
  if (replay.playing) replay.timer = setTimeout(() => moveReplay(1), REPLAY_STEP_MS);
}

function moveReplay(by) {
  replay.at = Math.min(Math.max(replay.at + by, 0), replay.lines.length - 1);
  drawReplay();
}

function openReplay(lines) {
  Object.assign(replay, { lines, at: 0, playing: true, fetched: null });
  replayView.showModal();
  drawReplay();
  replayControl('pause').focus();
}

replayControl('close').addEventListener('click', () => replayView.close());
replayControl('back').addEventListener('click', () => moveReplay(-1));
replayControl('next').addEventListener('click', () => moveReplay(1));
replayControl('pause').addEventListener('click', () => {
  if (!replay.playing && replay.at === replay.lines.length - 1) replay.at = 0;
  replay.playing = !replay.playing;
  drawReplay();
});
replayView.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  moveReplay(e.key === 'ArrowLeft' ? -1 : 1);
});
replayView.addEventListener('close', () => {
  clearTimeout(replay.timer);
  replay.playing = false;
});

function replayButton(node, t) {
  if (t.format !== 'playwright') return null;
  const lines = stepsRuns(t)?.[shownProject(node, t)];
  if (!lines?.some((line) => line.kind !== 'request' && line.shot)) return null;
  return h('button', {
    class: 'replay', title: '이 테스트의 단계를 화면 그림과 함께 한 단계씩 넘겨 봅니다', 'aria-label': '재생 — 단계를 화면 그림과 함께 하나씩',
    onclick: (e) => { e.stopPropagation(); openReplay(lines); }, onkeydown: (e) => e.stopPropagation(),
  }, '재생');
}

function traceButton(node, t) {
  if (t.format !== 'playwright' || !t.steps) return null;
  const project = shownProject(node, t);
  const kept = state.data.testTraces?.[t.steps]?.[project];
  if (kept === undefined) return null;
  if (!kept) return h('button', { class: 'trace', disabled: true, title: '이 테스트의 trace 파일이 지워져 열 수 없습니다. 테스트를 다시 돌리고 duru rebuild 를 실행하면 됩니다', 'aria-label': 'trace — 파일이 지워져 열 수 없음' }, 'trace');
  const trace = `test-trace?steps=${encodeURIComponent(t.steps)}&project=${encodeURIComponent(project)}`;
  return h('a', {
    class: 'trace', href: `/trace-viewer/index.html?trace=${encodeURIComponent(trace)}`, target: '_blank', rel: 'noopener',
    title: '이 테스트의 trace 를 Playwright trace viewer 로 새 탭에서 엽니다', 'aria-label': 'trace — 새 탭의 trace viewer',
    onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation(),
  }, 'trace');
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

function testStepItem(/** @type {TestStepLine} */ line, inReplay = false) {
  if (line.kind === 'request') return testRequestItem(line, inReplay);
  return h('li', { class: `step-line ${line.kind}` },
    h('span', { class: `chip step-${line.kind}`, title: [STEP_KIND_TITLE[line.kind], line.method && `(${line.method})`].filter(Boolean).join(' ') }, STEP_KIND[line.kind]), ' ',
    stepPlace(line),
    line.kind === 'write' ? [' ', line.box ? h('span', { class: 'step-box' }, boxWords(line.box)) : h('span', { class: 'muted step-unread', title: line.selector ?? null }, '찾은 상자를 읽지 못함')] : null,
    line.kind === 'write' && writtenValue(line) ? [' ', writtenValue(line)] : null,
    line.failed ? [' ', h('span', { class: 'chip fail', title: '이 동작은 오류로 끝났습니다' }, '실패')] : null,
    inReplay ? null : shotThumb(line));
}

const answerChip = (status) => (status === null
  ? h('span', { class: 'chip status-none', title: '응답을 받지 못했습니다' }, '응답 없음')
  : h('span', { class: `chip status${status >= 400 ? ' status-error' : ''}`, title: '응답 상태' }, String(status)));

function testRequestItem(line, inReplay) {
  const body = [h('span', { class: 'mono', title: line.url }, `${line.method} ${shownAddress(line.url)}`), ' ', answerChip(line.status)];
  if (!inReplay && line.call && opensOnPage(line.call)) {
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
  const picked = shownProject(node, t);
  const lines = runs[picked];
  return h('div', { class: 'test-steps', 'data-steps': place },
    projects.length > 1 ? h('div', { class: 'step-projects', role: 'group', 'aria-label': '프로젝트' }, projects.map((p) => h('button', {
      class: `chip step-project${p === picked ? ' on' : ''}`, 'data-project': p, 'aria-pressed': String(p === picked), title: `${p || '프로젝트 이름 없이'} 돈 실행의 단계를 봅니다`,
      onclick: (e) => { e.stopPropagation(); pickStepsProject(place, p); },
    }, p || '이름 없음'))) : null,
    lines.length ? h('ol', { class: 'step-lines' }, lines.map((line) => testStepItem(line))) : h('p', { class: 'muted' }, '이 실행은 화면을 열지도 호출을 보내지도 않았습니다.'));
}
