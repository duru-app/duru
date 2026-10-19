function frameAccount(s) {
  const { app } = state.data;
  const account = { url: app.url, id: app.account, label: `${app.account} 로 로그인`, error: app.error };
  const asRole = (r) => ({ url: r.url, id: r.account, label: `${r.role} 역할 ${r.account} 로 로그인`, error: r.error, role: r.role });
  const wanted = s.access.roleValues;
  const unread = s.access.unreadableRoleGuards ?? [];
  const hint = wanted && unread.length ? `읽지 못한 역할 조건도 있습니다: ${unread.join(', ')}` : null;
  return { hint, ...pickAccount(account, asRole, wanted, unread) };
}

function pickAccount(account, asRole, wanted, unread) {
  const { app } = state.data;
  if (state.roleChoice === 'auto') {
    if (wanted === undefined) return { ...account, notes: [] };
    if (wanted === null) {
      return { ...account, notes: [`어느 역할이 조건을 채우는지 맵에서 정할 수 없습니다${unread.length ? `: ${unread.join(', ')}` : ''}`] };
    }
    const meets = app.roles.filter((r) => wanted.includes(r.role));
    const role = meets.find((r) => !r.error) ?? meets[0];
    return role ? { ...asRole(role), notes: [] } : { ...account, noAccount: true, notes: [`조건을 채우는 역할(${wanted.join(', ')})에 계정이 없습니다`] };
  }
  const role = app.roles.find((r) => `role:${r.role}` === state.roleChoice);
  if (!role) return { ...account, notes: [] };
  return wanted && !wanted.includes(role.role)
    ? { ...asRole(role), missesRole: true, notes: [`이 역할은 화면 조건(${wanted.join(', ')})을 채우지 못합니다`] }
    : { ...asRole(role), notes: [] };
}

function rolePicker() {
  const { app, map } = state.data;
  const missing = [...new Set(map.screens.flatMap((s) => s.access.roleValues ?? []))].filter((v) => !app.roles.some((r) => r.role === v)).sort();
  const option = (value, label) => h('option', { value, selected: state.roleChoice === value }, label);
  return h('select', { class: 'role', title: '앱을 띄울 계정', onchange: (e) => { state.roleChoice = e.target.value; render(); } },
    option('auto', '자동'),
    option('account', `기본 계정 (${app.account})`),
    app.roles.map((r) => option(`role:${r.role}`, `${r.role} (${r.account})`)),
    missing.map((v) => h('option', { disabled: true }, `${v} — 계정 없음`)));
}

function filledPath(parts, values, queryNames) {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') out += p;
    else if (values[p.name]) out += p.prefix + (p.repeat || p.pattern === '.*' ? values[p.name].split('/').map(encodeURIComponent).join('/') : encodeURIComponent(values[p.name]));
    else if (!p.optional) return null;
  }
  const pairs = [];
  for (const n of queryNames) {
    if (!values[n]) return null;
    pairs.push(`${encodeURIComponent(n.slice(1))}=${encodeURIComponent(values[n])}`);
  }
  return (out || '/') + (pairs.length ? `?${pairs.join('&')}` : '');
}

const variablesOf = (entry) => (entry.parts ?? []).filter((p) => typeof p !== 'string');

const pathValueKey = (id, role) => `${id}\n${role ?? ''}`;
const pathValuesUrl = (id, role) => `/api/path-values?screen=${encodeURIComponent(id)}${role ? `&role=${encodeURIComponent(role)}` : ''}`;

async function loadPathValues(id, role) {
  const entry = { pending: true };
  state.pathValues.set(pathValueKey(id, role), entry);
  try {
    const res = await fetch(pathValuesUrl(id, role));
    if (!res.ok) throw new Error(await res.text());
    Object.assign(entry, await res.json());
  } catch (err) {
    Object.assign(entry, { parts: null, values: {}, queryNames: [], errors: [`경로 변수 값을 가져오지 못했습니다: ${err.message}`], fallback: null });
  }
  Object.assign(entry, { pending: false, draft: { ...entry.values }, filled: { ...entry.values }, opened: 0 });
  if (screenPanesShown() && state.selected === id) renderCenterHead(state.data.map.screens.find((x) => x.id === id));
  if (state.point?.screen === id) renderPointPane();
}

async function newIssued(s, entry, values) {
  const names = entry.issued.filter((n) => values[n] === entry.filled[n]);
  if (!names.length) return {};
  const typed = Object.fromEntries([...variablesOf(entry).map((p) => p.name), ...entry.queryNames]
    .filter((n) => !names.includes(n) && typeof values[n] === 'string').map((n) => [n, values[n]]));
  let fresh;
  try {
    const res = await fetch('/api/path-values', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen: s.id, role: frameAccount(s).role ?? null, typed }) });
    if (!res.ok) throw new Error(await res.text());
    fresh = await res.json();
  } catch (err) {
    throw new Error(`경로 변수 값을 가져오지 못했습니다: ${err.message}`);
  }
  const missing = names.filter((n) => fresh.values[n] === undefined);
  if (missing.length) throw new Error(fresh.errors.filter((e) => missing.some((n) => e.startsWith(`${n}: `))).join(' ') || `${missing.join(', ')} 값을 받지 못했습니다`);
  return Object.fromEntries(names.map((n) => [n, fresh.values[n]]));
}

function takeIssued(entry, got) {
  for (const [n, v] of Object.entries(got)) {
    if (entry.draft[n] === entry.filled[n]) entry.draft[n] = v;
    entry.values[n] = v;
    entry.filled[n] = v;
  }
  entry.errors = entry.errors.filter((e) => !Object.keys(entry.values).some((n) => entry.values[n] && e.startsWith(`${n}: `)));
  entry.used = false;
}

const stillShown = (s, entry) => screenPanesShown() && state.selected === s.id
  && state.pathValues.get(pathValueKey(s.id, frameAccount(s).role)) === entry;

function showPathValueError(message) {
  const bar = document.querySelector('#center .path-values');
  bar?.querySelector('.error.again')?.remove();
  bar?.append(h('span', { class: 'error again' }, message));
}

function pathValuesOf(s, role) {
  const key = pathValueKey(s.id, role);
  if (!state.pathValues.has(key)) loadPathValues(s.id, role);
  return state.pathValues.get(key);
}

/** @returns {{ link?: string, fallback?: boolean, opens?: PageData['map']['screens'][number], missing?: string[] }} */
function frameTarget(s, entry) {
  const { app, appLinks, map } = state.data;
  const at = (routePath, path) => (app.signedOutPaths.includes(routePath) ? app.signedOutUrl : app.url) + path;
  if (!entry) return { link: appLinks[s.id] };
  if (entry.pending) return {};
  const path = entry.parts && filledPath(entry.parts, entry.values, entry.queryNames);
  if (path) return { link: at(s.path, path) };
  if (entry.opened) return { fallback: false, missing: [...variablesOf(entry).filter((p) => !p.optional).map((p) => p.name), ...entry.queryNames].filter((n) => !entry.values[n]) };
  if (!entry.fallback) return { fallback: false };
  const opens = map.screens.find((x) => x.id === entry.fallback);
  return { link: at(opens.path, entry.fallbackPath), fallback: true, opens };
}

function pathValueBar(s, entry, fallback) {
  const variables = [...variablesOf(entry), ...entry.queryNames.map((n) => ({ name: n, optional: false }))];
  if (!variables.length && !fallback && !entry.errors.length) return null;
  const reopen = async () => {
    let got = {};
    if (entry.issued) {
      try {
        got = await newIssued(s, entry, entry.draft);
      } catch (err) {
        return stillShown(s, entry) ? showPathValueError(err.message) : null;
      }
      if (!stillShown(s, entry)) return;
    }
    entry.values = { ...entry.draft };
    takeIssued(entry, got);
    entry.opened += 1;
    renderCenterHead(s);
  };
  return h('div', { class: 'path-values' },
    variables.map((v) => h('label', { title: v.optional ? '비워 두면 이 자리를 빼고 엽니다' : null }, v.optional ? `${v.name}?` : v.name, ' ',
      h('input', {
        type: 'text', name: v.name, value: entry.draft[v.name] ?? '', placeholder: '값',
        oninput: (e) => { entry.draft[v.name] = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) reopen(); },
      }))),
    variables.length ? h('button', { onclick: reopen }, '다시 띄우기') : null,
    fallback ? h('span', { class: 'fallback' }, '목록에서 골라 들어가세요') : null,
    entry.errors.map((e) => h('span', { class: 'error' }, e)));
}

function openingOf(s, link) {
  const { app } = state.data;
  const signedOut = Boolean(app.signedOutUrl) && link.startsWith(`${app.signedOutUrl}/`);
  const who = signedOut ? null : frameAccount(s);
  /** @param {string} l */
  const opening = (l) => (signedOut ? `${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent(l.slice(app.signedOutUrl.length))}` : who.url + l.slice(app.url.length));
  return { signedOut, who, opening };
}

/**
 * @param {PageData['map']['screens'][number]} s
 * @param {ReturnType<typeof frameTarget>} target
 */
function appFrame(s, { link, fallback, opens, missing }, entry) {
  const { app } = state.data;
  if (entry?.pending) return h('div', { class: 'frame-note muted' }, '경로 변수 값을 준비하고 있습니다.');
  const unknown = [
    app.unknownSignedOutPaths.length > 0 && h('span', { class: 'error' }, `맵에 없는 signedOutPaths: ${app.unknownSignedOutPaths.join(', ')}`),
    app.unknownPathValues.length > 0 && h('span', { class: 'error' }, `맵에 없는 pathValues: ${app.unknownPathValues.join(', ')}`),
  ];
  const values = entry && pathValueBar(s, entry, fallback);
  if (!link) {
    return [
      values && h('div', { class: 'frame-bar' }, unknown, values),
      h('div', { class: 'frame-note muted' }, missing ? `${missing.join(', ')} 값이 없어 이 화면을 띄울 수 없습니다.` : '주소에 값이 필요한 화면이라 앱을 띄우지 않았습니다.'),
    ];
  }
  const { signedOut, who, opening } = openingOf(opens ?? s, link);
  const shown = signedOut ? link : opening(link);
  const opened = opening(link);
  // 팝업이 막히지 않도록 탭은 누른 자리에서 바로 열고, 주소는 값을 받은 뒤에 넣는다.
  const openAnew = async (e) => {
    e.preventDefault();
    const tab = window.open('', '_blank');
    if (!tab) return;
    tab.opener = null;
    try {
      const got = await newIssued(s, entry, entry.values);
      tab.location.href = opening(frameTarget(s, { ...entry, values: { ...entry.values, ...got } }).link);
    } catch (err) {
      tab.close();
      if (stillShown(s, entry)) showPathValueError(err.message);
    }
  };
  return [
    h('div', { class: 'frame-bar' },
      h('span', { class: 'mono', title: shown }, shown),
      signedOut ? h('span', {}, '로그아웃 상태') : [
        rolePicker(),
        who.error ? h('span', { class: 'error' }, who.error) : h('span', {}, who.label),
        ...who.notes.map((n) => h('span', { class: 'error' }, n)),
        who.hint && h('span', { class: 'muted' }, who.hint),
      ],
      unknown,
      h('a', { href: opened, target: '_blank', rel: 'noopener', onclick: entry?.issued && !fallback ? openAnew : null }, '새 창으로 열기 ↗'),
      appWidthPicker(),
      values),
    h('div', { class: 'settings-bar', id: 'settings-bar', hidden: true }),
    appStage(opened),
  ];
}

// ---------- 앱 너비 ----------

// width 와 percent 가 0 이면 칸에 맞춤이다.
const appSize = { width: 1280, widthTyped: false, percent: 0, percentTyped: false };
const appResized = new ResizeObserver(() => fitApp());
const stageWidth = () => document.querySelector('#center .app-stage')?.clientWidth ?? 0;

function pickOrType({ key, name, label, presets, unit, min, max, guess }) {
  const typedKey = `${key}Typed`;
  const pick = (n, typed) => { Object.assign(appSize, { [key]: n, [typedKey]: typed }); fitApp(); };
  const field = h('input', { type: 'number', class: `${name}-typed`, min, max, step: 1, hidden: !appSize[typedKey], 'aria-label': `${label} 직접 입력` });
  field.value = appSize[key] || '';
  field.addEventListener('change', () => {
    const n = Number(field.value);
    if (Number.isInteger(n) && n >= min && n <= max) pick(n, true);
    else field.value = appSize[key] || '';
  });
  const select = h('select', {
    class: name,
    onchange: (e) => {
      field.hidden = e.target.value !== 'typed';
      if (field.hidden) { pick(Number(e.target.value), false); return; }
      const n = appSize[key] || guess();
      if (n) pick(Math.min(max, Math.max(min, n)), true);
      field.value = appSize[key] || '';
      field.focus();
      field.select();
    },
  },
  presets.map((v) => h('option', { value: v, selected: !appSize[typedKey] && v === appSize[key] }, v ? `${v}${unit}` : '칸에 맞춤')),
  h('option', { value: 'typed', selected: appSize[typedKey] }, '직접 입력'));
  return [select, field];
}

function appWidthPicker() {
  return [
    h('label', {}, '앱 너비 ', pickOrType({ key: 'width', name: 'app-width', label: '앱 너비', presets: [0, 375, 768, 1024, 1280, 1440], unit: '', min: 200, max: 3840, guess: stageWidth })),
    h('label', {}, '배율 ', pickOrType({ key: 'percent', name: 'app-percent', label: '배율', presets: [0, 25, 50, 75, 100, 150], unit: '%', min: 10, max: 200, guess: () => fitPercent(stageWidth()) })),
    h('span', { class: 'app-scale muted' }),
  ];
}

const fitPercent = (room) => appSize.width && Math.max(1, Math.min(100, Math.floor((room / appSize.width) * 100)));

function appStage(src) {
  const frame = h('iframe', { class: 'app', 'data-src': src, title: '앱 화면', style: appSize.width ? `width: ${appSize.width}px` : null });
  const stage = h('div', { class: 'app-stage' }, h('div', { class: 'app-sizer' }, frame));
  appResized.disconnect();
  appResized.observe(stage);
  return stage;
}

function fitApp() {
  const stage = document.querySelector('#center .app-stage');
  const frame = /** @type {HTMLIFrameElement} */ (stage?.querySelector('iframe.app'));
  const note = document.querySelector('#center .app-scale');
  if (!frame || !stage.clientWidth) return;
  for (const pick of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('#center .app-percent, #center .app-percent-typed'))) {
    pick.disabled = !appSize.width;
    pick.title = appSize.width ? '' : '칸에 맞춘 너비는 늘 실제 크기로 보입니다';
  }
  if (!appSize.width) {
    stage.classList.remove('wide');
    frame.parentElement.style.width = '';
    Object.assign(frame.style, { width: '', height: '', transform: '' });
    note.textContent = `칸 너비 그대로 ${stage.clientWidth}px`;
    return;
  }
  const percent = appSize.percent || fitPercent(stage.clientWidth);
  const shownWidth = (appSize.width * percent) / 100;
  const wide = shownWidth > stage.clientWidth + 0.5;
  stage.classList.toggle('wide', wide);
  frame.parentElement.style.width = `${shownWidth}px`;
  Object.assign(frame.style, { width: `${appSize.width}px`, transform: `scale(${percent / 100})` });
  frame.style.height = `${(stage.clientHeight * 100) / percent}px`;
  const size = percent < 100 ? `${percent}%로 줄여서` : percent > 100 ? `${percent}%로 키워서` : '실제 크기로';
  note.textContent = `${appSize.width}px 화면을 ${size} 보여 줍니다${wide ? ' · 칸을 넘는 부분은 옆으로 넘겨 봅니다' : ''}`;
}

