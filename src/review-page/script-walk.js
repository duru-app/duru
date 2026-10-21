// ---------- 앱을 돌아다닌 길을 새 스토리의 단계로 받기 ----------

const walkShown = () => composeShown() && Boolean(state.compose.walk);
const NO_ADDRESS = '앱에서 주소를 받지 못했습니다. 앱이 보안 정책으로 인라인 스크립트를 막으면 주소를 받을 수 없습니다.';
const NO_ADDRESS_YET = '아직 앱에서 받은 주소가 없습니다. 앱이 보안 정책으로 인라인 스크립트를 막으면 주소를 받을 수 없습니다.';
let walkTurn = 0;

function walkStart() {
  const { app, appUrl } = state.data;
  if (app) {
    return h('button', {
      type: 'button',
      class: 'walk-start',
      title: '가운데 칸에 앱을 띄우고, 앱에서 지나간 화면과 칸에 넣은 값을 단계로 받습니다. 이미 넣은 단계가 있으면 그 뒤에 이어 넣습니다',
      onclick: startWalk,
    }, '● 기록');
  }
  return appUrl ? h('span', { class: 'muted no-walk' }, '앱을 돌아다니며 기록하는 것은 설정에 app 을 적어 duru 가 앱을 띄울 때만 됩니다') : null;
}

function walkPanes() {
  const { app } = state.data;
  return [
    { key: 'account', label: `기본 계정 (${app.account})`, url: app.url },
    ...app.roles.map((r) => ({ key: `role:${r.role}`, label: `${r.role} 역할 (${r.account})`, url: r.url })),
    ...(app.signedOutUrl ? [{ key: 'signed-out', label: '로그아웃 상태', url: app.signedOutUrl }] : []),
  ];
}

const paneOf = (key) => walkPanes().find((p) => p.key === key) ?? walkPanes()[0];

function paneSrc(pane, path) {
  const { app } = state.data;
  return pane.key === 'signed-out' ? `${pane.url}${app.signOutPath}?to=${encodeURIComponent(path)}` : pane.url + path;
}

function lastAddress(c) {
  const last = c.steps.at(-1);
  if (!last) return '/';
  if (last.urls.length) return last.urls.at(-1);
  const link = state.data.appLinks[last.screen];
  return link ? link.slice(new URL(link).origin.length) || '/' : '/';
}

function firstPane(c) {
  const last = screenOf(c.steps.at(-1)?.screen);
  return last && state.data.app.signedOutUrl && state.data.app.signedOutPaths.includes(last.path) ? 'signed-out' : 'account';
}

function openPane(c, key) {
  const pane = paneOf(key);
  c.pane = pane.key;
  c.walk = { key: ++walkTurn, pane: pane.key, origin: new URL(pane.url).origin, src: paneSrc(pane, lastAddress(c)), record: [] };
}

function startWalk() {
  const c = state.compose;
  Object.assign(c, { editing: null, at: null, selected: null, walkNote: null, refused: null });
  openPane(c, c.pane ?? firstPane(c));
  render();
}

// 로그아웃 칸과 역할별 칸은 계정이 따로라, 칸을 바꾸면 그때까지 받은 주소를 기록 하나로 남기고 새 기록을 시작한다.
function switchPane(key) {
  const c = state.compose;
  const { record } = c.walk;
  if (record.length) saveWalkRecord(c, record);
  openPane(c, key);
  render();
}

function endWalk() {
  const c = state.compose;
  const { record } = c.walk;
  c.walk = null;
  if (record.length) {
    Object.assign(c, { walked: true, diagram: 'line' });
    saveWalkRecord(c, record);
  } else c.walkNote = { error: true, text: NO_ADDRESS };
  render();
}

async function saveWalkRecord(c, record) {
  const steps = record.map(({ url, inputs, skipped }) => ({ url, inputs, ...(skipped && { skipped }) }));
  let note;
  try {
    const res = await fetch('/api/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps }) });
    if (!res.ok) throw new Error(await res.text());
    note = { text: `지나간 주소 ${steps.length}개를 기록 파일 ${(await res.json()).record} 에 남겼습니다. 스토리로 저장하기 전에 페이지를 닫아도 후보 목록에서 다시 꺼낼 수 있습니다.` };
  } catch (err) {
    note = { error: true, text: `지나간 주소를 기록 파일에 남기지 못했습니다: ${err.message}` };
  }
  if (state.compose !== c) return;
  c.walkNote = note;
  if (c.walk) renderWalkBar();
  else renderCompose();
}

function walkScreenAt(path) {
  const route = state.data.screenRoutes.find((r) => new RegExp(r.source, r.flags).test(path));
  return route?.id ?? null;
}

const walkPath = (url) => url.split(/[?#]/)[0];
const walkScreenOf = (url) => walkScreenAt(walkPath(url)) ?? walkPath(url);

function takeAddress(c, url) {
  const { record } = c.walk;
  if (record.at(-1)?.url !== url) record.push({ url, inputs: [], skipped: 0 });
  const path = walkPath(url);
  const id = walkScreenAt(path);
  const screen = id ?? path;
  const last = c.steps.at(-1);
  if (last?.screen === screen) {
    if (last.urls.at(-1) !== url) last.urls.push(url);
    return renderWalk();
  }
  c.steps.push(newStep(screen, { urls: [url], unmapped: !id }));
  checkCompose();
  renderWalkBar();
}

const boxKey = (box) => JSON.stringify(box);

function takeSkipped(c) {
  const at = c.walk.record.at(-1);
  const step = c.steps.at(-1);
  if (!at || !step) return;
  at.skipped += 1;
  step.skipped += 1;
  renderWalk();
}

// 같은 화면에 머문 주소의 기록마다 그 칸의 값을 지워야, 후보가 화면별로 입력값을 합칠 때 지운 값이 되살아나지 않는다.
function forgetBoxes(c, keys) {
  const { record } = c.walk;
  const step = c.steps.at(-1);
  for (let i = record.length - 1; i >= 0 && walkScreenOf(record[i].url) === step.screen; i--) {
    record[i].inputs = record[i].inputs.filter((input) => !keys.includes(boxKey(input.box)));
  }
  step.rows.inputs = step.rows.inputs.filter((r) => !keys.includes(r.recorded));
}

// was 는 같은 입력 필드를 지난번에 기록한 box 다. 그 뒤로 이 box 로 기록된 다른 필드는 없다.
function takeInput(c, box, value, was) {
  const at = c.walk.record.at(-1);
  const step = c.steps.at(-1);
  if (!at || !step) return;
  const input = { box, value };
  const key = boxKey(box);
  const old = was === undefined ? key : boxKey(was);
  const kept = at.inputs.findIndex((i) => boxKey(i.box) === key);
  const before = kept >= 0 ? kept : at.inputs.findIndex((i) => boxKey(i.box) === old);
  if (before >= 0) at.inputs[before] = input;
  else at.inputs.push(input);
  const row = step.rows.inputs.find((r) => r.recorded === key) ?? step.rows.inputs.find((r) => r.recorded === old);
  if (row) Object.assign(row, inputRowOf(input), { key: row.key, recorded: key });
  else step.rows.inputs.push({ ...inputRowOf(input), recorded: key });
  if (old !== key) forgetBoxes(c, [old]);
  renderWalk();
}

function takeCleared(c, box, was) {
  if (!c.steps.at(-1)) return;
  forgetBoxes(c, was ? [boxKey(box), boxKey(was)] : [boxKey(box)]);
  renderWalk();
}

const isBox = (box) => box && typeof box === 'object' && Object.keys(BOX_WORDS).some((k) => typeof box[k] === 'string' && box[k].trim());

window.addEventListener('message', (e) => {
  const c = state.compose;
  const frame = /** @type {HTMLIFrameElement | null} */ (document.querySelector('#center .walk-stage iframe.app'));
  if (!c?.walk || !frame || e.source !== frame.contentWindow || e.origin !== c.walk.origin || e.data?.duru !== 'walk') return;
  const { url, box, value, skipped } = e.data;
  const was = isBox(e.data.was) ? e.data.was : undefined;
  if (typeof url === 'string') {
    if (url.startsWith('/') && !url.startsWith('//')) takeAddress(c, url);
  } else if (skipped === true) takeSkipped(c);
  else if (isBox(box) && typeof value === 'string') {
    if (value.trim()) takeInput(c, box, value, was);
    else takeCleared(c, box, was);
  }
});

function renderWalk() {
  renderLeft();
  renderWalkBar();
}

function walkStatus(c) {
  const { record } = c.walk;
  return [
    record.length ? h('span', {}, `받은 주소 ${record.length}`) : h('span', { class: 'error' }, NO_ADDRESS_YET),
    c.walkNote ? h('span', { class: `walk-note ${c.walkNote.error ? 'error' : 'muted'}` }, c.walkNote.text) : null,
  ];
}

function renderWalkBar() {
  const c = state.compose;
  const bar = document.querySelector('#center .walk-bar');
  if (!c?.walk || !bar) return;
  bar.querySelector('.walk-at').textContent = c.walk.record.at(-1)?.url ?? '';
  fill(bar.querySelector('.walk-status'), walkStatus(c));
}

// 앱 iframe 은 기록을 시작하거나 계정을 바꿀 때, 그리고 다른 보기가 가운데 칸 머리를 비우거나 제 것으로 채웠다가 돌아왔을 때만 새로 만든다.
// 돌아왔을 때 지금 계정으로 받은 주소가 있으면 그 주소를 바로 열고, 로그아웃 상태 계정이라도 로그아웃 주소를 거치지 않는다
// (docs/decisions.md).
function renderWalkCenter() {
  const c = state.compose;
  const head = document.getElementById('center-head');
  fill(document.getElementById('center-body'));
  const key = `walk\n${c.walk.key}`;
  if (head.dataset.key === key) return renderWalkBar();
  head.dataset.key = key;
  const at = c.walk.record.at(-1)?.url;
  const src = at ? paneOf(c.walk.pane).url + at : c.walk.src;
  const stage = appStage(src);
  stage.classList.add('walk-stage');
  /** @type {HTMLIFrameElement} */ (stage.querySelector('iframe.app')).src = src;
  fill(head,
    h('div', { class: 'frame-bar walk-bar' },
      h('button', { type: 'button', class: 'end-walk', title: '기록을 끝내고 지나간 길을 흐름 그림에 그립니다. 받은 주소와 입력값은 기록 파일로도 남깁니다', onclick: endWalk }, '기록 끝'),
      h('select', { class: 'walk-pane', title: '앱을 띄울 칸. 바꾸면 그때까지 받은 주소를 기록 하나로 남기고 새 기록을 시작합니다', onchange: (e) => switchPane(e.target.value) },
        walkPanes().map((p) => h('option', { value: p.key, selected: p.key === c.walk.pane }, p.label))),
      h('span', { class: 'mono walk-at', title: '앱에서 마지막으로 받은 주소' }),
      appWidthPicker(),
      h('span', { class: 'walk-status' })),
    stage);
  renderWalkBar();
}

function walkList() {
  const c = state.compose;
  return [
    h('div', { class: 'compose-head' }, h('strong', {}, `지나간 화면 ${c.steps.length}`)),
    h('p', { class: 'muted walk-guide' }, '앱에서 화면을 옮길 때마다 단계가 여기 쌓입니다. 같은 화면에 머문 주소는 한 단계로 합치고, 칸에 넣은 값은 그 단계에 붙습니다.'),
    walkVerdict(c),
    c.steps.length
      ? h('ol', { class: 'walk-steps', id: 'walk-steps' }, c.steps.map((step, i) => {
          const sc = screenOf(step.screen);
          const inputs = fieldsToSend({ inputs: step.rows.inputs }).inputs;
          return h('li', { 'data-step': i },
            h('span', { class: 'no' }, i + 1),
            h('div', { class: 'name' },
              sc ? h('span', { class: 'screen-path' }, routeSegments(sc.path)) : h('span', { class: 'mono' }, step.screen),
              sc ? null : [' ', h('span', { class: 'chip l-off-map' }, '맵에 없는 화면')],
              ...walkedLines(step),
              inputs.length ? h('ul', { class: 'plain walk-inputs' }, inputs.map((input) => h('li', {}, boxWords(input.box), ' → ', h('span', { class: 'mono' }, input.value)))) : null));
        }))
      : h('p', { class: 'muted no-steps' }, '아직 지나간 화면이 없습니다.'),
  ];
}

function walkVerdict(c) {
  const checked = checkedCompose(c);
  return h('div', { class: 'walk-verdict' },
    checked ? h('div', { class: 'walk-chips' }, walkChip(checked), ...reachChips(checked)) : null,
    checked ? needsFold(checked, 'compose') : waitingLine(c.steps, c.error),
    repeatedStep(composeScreens(c)) ? h('p', { class: 'error repeated' }, '같은 화면이 이어진 자리가 있어 저장할 수 없습니다.') : null);
}

function renderWalkLeft(left) {
  fill(left, walkList());
  left.querySelector('#walk-steps > li:last-child')?.scrollIntoView({ block: 'nearest' });
}

// ---------- 기록을 끝낸 뒤 지나간 길을 한 줄로 그리기 ----------

function showComposePart(part) {
  const c = state.compose;
  const i = part.key.step - 1;
  if (part.kind === 'step') {
    c.selected = i;
    renderCompose([`.compose-step[data-step="${i}"] button.step-press`]);
  }
  document.querySelector(part.kind === 'step' ? `#center .story-path > .compose-step[data-step="${i}"]` : `#center .story-path > .link[data-hop="${i}"]`)?.scrollIntoView({ block: 'nearest' });
}

function setComposeDiagram(diagram) {
  state.compose.diagram = diagram;
  render();
}

function composeDiagramBar(c) {
  if (c.diagram === 'line') return h('div', { class: 'compose-diagram-bar' }, h('button', { type: 'button', class: 'whole-diagram', title: '지나간 길을 전체 흐름 그림 위에 칠해 보이고, 그림의 화면 상자를 눌러 단계를 넣을 수 있게 합니다', onclick: () => setComposeDiagram('whole') }, '전체 그림에서 보기'));
  return c.walked ? h('div', { class: 'compose-diagram-bar' }, h('button', { type: 'button', class: 'line-diagram', title: '지금 순서를 한 줄로 그립니다', onclick: () => setComposeDiagram('line') }, '한 줄로 보기')) : null;
}

function composeLine(c) {
  const checked = checkedCompose(c);
  return [
    composeDiagramBar(c),
    checked ? storyLine(checked, showComposePart) : h('p', { class: 'muted' }, c.steps.length ? '경로를 맞춰 보는 중입니다.' : '아직 넣은 화면이 없습니다.'),
  ];
}
