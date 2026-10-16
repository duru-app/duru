// ---------- 프레임 위에 붙는 설정 줄 ----------

const samePlace = (o, path, item) => o.path.join('.') === path.join('.') && o.item === item;
const overrideIn = (list, path, item) => list.find((o) => samePlace(o, path, item));
const overrides = () => state.data.app?.settings?.overrides ?? [];
const quoted = (v) => JSON.stringify(v);
const sourceLabel = (source) => (source.from === 'route' ? '라우트' : source.inherited ? `${source.from} 에서 물려받음` : `${source.from} 에서 오는 링크`);
const valueAt = (v, keys) => keys.reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), v);

function fileDefines(section, key) {
  const values = state.data.app.settings?.file?.[section];
  return values !== null && typeof values === 'object' && Object.hasOwn(values, key);
}

function unchangedKnown(n) {
  const incomplete = state.data.map.settingsDefaultsIncomplete?.[n.root] ?? [];
  return !incomplete.some((p) => p.every((k, i) => k === n.path[i])) || fileDefines(n.path[0], n.path[1]);
}

function blockOf(n) {
  const settings = state.data.app.settings;
  if (!settings) return '설정 파일(app.settingsFile)을 적지 않아 바꿀 수 없습니다';
  if (n.root !== settings.root) return `${n.root} 로 읽는 설정이라 설정 파일로 바꿀 수 없습니다`;
  if (n.path.length < 2) return '섹션 전체는 바꿀 수 없습니다';
  const [section, key] = n.path;
  if (!settings.merged.includes(section)) return `앱이 설정 파일에서 ${section} 섹션을 읽지 않아 바꿀 수 없습니다`;
  if ((n.need === 'includes' || n.path.length > 2) && !unchangedKnown(n)) {
    return `${section}.${key} 기본값을 소스에서 다 읽지 못해, 설정 파일이 이 키를 정하지 않는 한 안쪽 값만 바꾸면 나머지가 사라질 수 있어 바꿀 수 없습니다`;
  }
  if (n.need === 'present') return '어떤 값이 있어야 하는지 몰라 넣을 수 없습니다';
  return null;
}

function unchangedOf(n) {
  const settings = state.data.app.settings;
  if (!settings || n.root !== settings.root || n.path.length < 2 || !settings.merged.includes(n.path[0])) return n.default;
  const [section, key, ...rest] = n.path;
  const top = fileDefines(section, key) ? settings.file[section][key] : state.data.map.settingsDefaults?.[n.root]?.[section]?.[key];
  return valueAt(top, rest);
}

const unchangedIncludes = (n) => {
  const list = unchangedOf(n);
  return Array.isArray(list) && list.includes(n.value);
};

function currentOf(n, list) {
  if (n.need === 'includes') return overrideIn(list, n.path, n.value)?.value ?? unchangedIncludes(n);
  const o = overrideIn(list, n.path);
  return o ? o.value : unchangedOf(n);
}

function satisfied(n, list) {
  const v = currentOf(n, list);
  return { on: Boolean(v), off: !v, equals: v === n.value, includes: v === true, present: Boolean(v) }[n.need];
}

const wantedOf = (n) => (n.need === 'includes' ? { path: n.path, item: n.value, value: true } : { path: n.path, value: n.need === 'equals' ? n.value : n.need === 'on' });

function withOverride(list, op, isDefault) {
  const rest = list.filter((o) => !samePlace(o, op.path, op.item));
  return isDefault ? rest : [...rest, op];
}

function autoOverrides(s, list) {
  const sources = s.access.settings ?? [];
  const fits = (n) => !blockOf(n) || satisfied(n, list);
  const link = sources.find((x) => x.from !== 'route' && x.needs.length && !x.unreadable.length && x.needs.every(fits));
  // 원래 값을 다 읽지 못한 설정은 조건을 채웠는지 알 수 없으므로 필요한 값을 직접 적는다.
  const written = (n) => overrideIn(list, n.path, n.need === 'includes' ? n.value : undefined);
  const needs = sources.filter((x) => x.from === 'route' || x === link).flatMap((x) => x.needs)
    .filter((n) => !blockOf(n) && (!satisfied(n, list) || (!unchangedKnown(n) && !written(n))));
  return needs.length ? needs.reduce((next, n) => withOverride(next, wantedOf(n), unchangedKnown(n) && satisfied(n, [])), list) : null;
}

// 한 단계가 실패해도 다음 단계는 돌고 프레임은 언제나 열린다.
let settingsQueue = Promise.resolve();
function updateSettings(change) {
  const frame = document.querySelector('#center iframe.app');
  settingsQueue = settingsQueue.then(async () => {
    state.settingsError = null;
    try {
      const next = change(overrides());
      if (next) {
        const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides: next }) });
        if (!res.ok) throw new Error(await res.text());
        state.data.app.settings.overrides = (await res.json()).overrides;
      }
    } catch (err) {
      state.settingsError = `설정을 바꾸지 못했습니다: ${err.message}`;
    }
    renderSettingsBar();
    if (!frame?.isConnected) return;
    const s = frame.hasAttribute('src') ? screenOf(state.selected) : null;
    const entry = s && state.pathValues.get(pathValueKey(s.id, frameAccount(s).role));
    // 이미 띄운 주소에 든 코드는 한 번 쓰여 다시 쓸 수 없다.
    if (entry?.issued && !frameTarget(s, entry).fallback) {
      if (state.settingsError) return;
      let got;
      try {
        got = await newIssued(s, entry, entry.values);
      } catch (err) {
        return stillShown(s, entry) ? showPathValueError(err.message) : null;
      }
      if (!stillShown(s, entry)) return;
      if (Object.keys(got).length) {
        takeIssued(entry, got);
        document.getElementById('center-head').dataset.key = '';
        return renderCenterHead(s);
      }
    }
    frame.src = frame.dataset.src;
  }).catch((err) => {
    state.settingsError = `설정 줄을 그리지 못했습니다: ${err.message}`;
  });
}

function settingRows(s) {
  const rows = new Map();
  for (const source of s.access.settings ?? []) {
    for (const n of source.needs) {
      const kind = ['includes', 'present'].includes(n.need) ? n.need : 'value';
      const key = quoted([n.root, n.path, kind, kind === 'includes' ? n.value : null]);
      if (!rows.has(key)) rows.set(key, { needs: [], from: new Set() });
      rows.get(key).needs.push(n);
      rows.get(key).from.add(sourceLabel(source));
    }
  }
  return [...rows.values()];
}

function settingControl(row, list) {
  const [n] = row.needs;
  const block = blockOf(n);
  const name = h('code', {}, n.path.join('.'));
  const title = [...row.from].join(' · ');
  if (n.need === 'present') {
    return satisfied(n, list)
      ? h('span', { class: 'setting', title }, name, h('span', { class: 'muted' }, '기본값에 있음'))
      : h('span', { class: 'setting blocked', title }, name, h('span', { class: 'reason' }, block));
  }
  const changed = Boolean(overrideIn(list, n.path, n.need === 'includes' ? n.value : undefined));
  const cls = `setting${changed ? ' changed' : ''}${block ? ' blocked' : ''}`;
  const reason = block ? h('span', { class: 'reason' }, block) : null;
  const disabled = Boolean(block);
  if (n.need === 'includes') {
    const inList = currentOf(n, list);
    const isDefault = (on) => on === unchangedIncludes(n);
    return h('label', { class: cls, title }, name, h('span', {}, `에 ${quoted(n.value)}`),
      h('input', { type: 'checkbox', checked: inList, disabled, onchange: (e) => {
        const on = e.target.checked;
        updateSettings((l) => withOverride(l, { path: n.path, item: n.value, value: on }, isDefault(on)));
      } }), '목록에 넣기', reason);
  }
  const values = [...new Map(row.needs.filter((x) => x.need === 'equals').map((x) => [quoted(x.value), x.value])).values()];
  if (values.length) {
    const current = overrideIn(list, n.path);
    const unchanged = unchangedKnown(n) ? unchangedOf(n) : undefined;
    return h('span', { class: cls, title }, name,
      h('select', { disabled, onchange: (e) => {
        const picked = e.target.value;
        const value = picked && JSON.parse(picked);
        updateSettings((l) => withOverride(l, { path: n.path, value }, picked === '' || (unchanged !== undefined && value === unchanged)));
      } },
        h('option', { value: '', selected: !current }, `바꾸지 않음${unchanged !== undefined ? ` (${quoted(unchanged)})` : ''}`),
        values.map((v) => h('option', { value: quoted(v), selected: current && quoted(current.value) === quoted(v) }, quoted(v)))),
      reason);
  }
  const on = Boolean(currentOf(n, list));
  const set = (value) => () => updateSettings((l) => withOverride(l, { path: n.path, value }, unchangedKnown(n) && value === Boolean(unchangedOf(n))));
  return h('span', { class: cls, title }, name,
    h('button', { class: on ? 'on' : '', disabled, onclick: set(true) }, '켜기'),
    h('button', { class: on ? '' : 'on', disabled, onclick: set(false) }, '끄기'),
    reason);
}

const overrideText = (o) => (o.item === undefined ? `${o.path.join('.')} = ${quoted(o.value)}` : `${o.path.join('.')} 에 ${quoted(o.item)} ${o.value ? '넣음' : '뺌'}`);

function renderSettingsBar() {
  const bar = document.getElementById('settings-bar');
  const s = state.data.map.screens.find((x) => x.id === state.frameScreen);
  if (!bar || !s) return;
  const list = overrides();
  const rows = settingRows(s);
  const unreadable = (s.access.settings ?? []).flatMap((x) => x.unreadable.map((u) => ({ ...u, source: x })));
  const others = list.filter((o) => !rows.some((r) => samePlace(o, r.needs[0].path, r.needs[0].need === 'includes' ? r.needs[0].value : undefined)));
  bar.hidden = !rows.length && !unreadable.length && !list.length && !state.settingsError;
  bar.classList.toggle('overridden', list.length > 0);
  fill(bar,
    h('span', { class: 'title' }, list.length ? `설정 ${list.length}개 바꿈` : '설정'),
    rows.map((r) => settingControl(r, list)),
    unreadable.map((u) => h('span', { class: 'setting blocked', title: sourceLabel(u.source) }, h('code', {}, u.guard), h('span', { class: 'reason' }, u.reason))),
    others.length ? h('span', { class: 'others' }, '다른 화면에서 바꾼 설정 ', others.map((o) => h('span', { class: 'setting changed' }, h('code', {}, overrideText(o))))) : null,
    list.length ? h('button', { class: 'reset', onclick: () => updateSettings(() => []) }, '기본값으로') : null,
    state.data.app.settings?.fileError ? h('span', { class: 'file-error' }, state.data.app.settings.fileError) : null,
    state.settingsError ? h('span', { class: 'error' }, state.settingsError) : null);
}

// 프레임을 다시 띄우지 않고도 다시 빌드한 맵의 조건을 따라가도록, 이름 옆 표시는 그릴 때마다 새로 채운다.
function fillNeedKinds(head, s) {
  const box = head.querySelector('.need-kinds');
  if (box) fill(box, s.access.restricted ? (s.access.kinds.length ? s.access.kinds.map(kindChip) : mixedChip()) : null);
}

function renderCenterHead(s) {
  const head = document.getElementById('center-head');
  const { app, appLinks } = state.data;
  const entryOf = () => (s && app && !appLinks[s.id] ? pathValuesOf(s, frameAccount(s).role) : null);
  let entry = entryOf();
  let target = s && app ? frameTarget(s, entry) : null;
  // 앱을 조작하던 중에 표시를 남겨도 프레임이 다시 로드되지 않게, 고른 화면이나 띄울 주소가 바뀔 때만 다시 그린다.
  const keyOf = () => (s ? [s.id, app?.url, state.roleChoice, target?.link, entry?.pending, entry?.opened].join(' ') : '');
  if (head.dataset.key === keyOf()) return fillNeedKinds(head, s);
  if (entry?.issued && entry.used) {
    state.pathValues.delete(pathValueKey(s.id, frameAccount(s).role));
    entry = entryOf();
    target = frameTarget(s, entry);
  }
  head.dataset.key = keyOf();
  if (entry && !entry.pending) entry.used = true;
  if (!s) return fill(head);
  const link = appLinks[s.id];
  fill(head,
    h('div', { class: 'title-row' },
      h('h3', {}, s.path),
      h('span', { class: 'need-kinds' }),
      h('span', { class: 'muted' }, s.component),
      app ? null
        : link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, '실제 앱에서 열기 ↗')
          : state.data.appUrl ? h('span', { class: 'muted' }, '경로 변수가 있어 실제 앱 링크를 만들 수 없음') : null),
    h('div', { class: 'muted mono' }, s.id),
    app ? appFrame(s, target, entry) : null);
  fillNeedKinds(head, s);
  // 값을 불러오는 동안이나 값이 비어 주소가 없을 때는 마지막으로 띄운 화면을 그대로 기억한다.
  if (!target?.link) return;
  const shownId = (target.opens ?? s).id;
  const moved = shownId !== state.frameScreen;
  state.frameScreen = shownId;
  if (moved) state.settingsError = null;
  renderSettingsBar();
  const shown = state.data.map.screens.find((x) => x.id === shownId);
  updateSettings(moved ? (list) => autoOverrides(shown, list) : () => null);
}

