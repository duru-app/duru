// ---------- 입력값 줄을 눌러 앱 화면에서 상자 짚기 ----------

const POINT_FRAME_HEIGHT = 900;
const POINT_FRAME_MAX = 4000;
const POINT_CROP_MAX = 360;
const POINT_ZOOM_MAX = 1.5;
const POINT_READABLE = 0.75;
const POINT_MARGIN = 16;
const POINT_MARGIN_SHOWN = 14;
const POINT_MIN_WIDTH = 360;
const POINT_MIN_HEIGHT = 120;
const POINT_NO_ROOM = 28;
const POINT_MINI_WIDTH = 96;
const POINT_MINI_MAX = 140;
const POINT_ANSWER_MS = 5000;
const NO_ANSWER = '앱에서 답을 받지 못했습니다. 앱이 보안 정책으로 인라인 스크립트를 막으면 상자를 찾을 수 없습니다.';
let pointTurn = 0;
/** @type {{ src: string, key: string, origin: string, frame: HTMLIFrameElement, width: number, height: number, loaded: boolean, moved: boolean, timer: ReturnType<typeof setTimeout> | undefined } | null} */
let pointFrame = null;

const pointShown = () => state.view === 'story' && Boolean(state.point);
const storyAppShown = () => pointShown() && Boolean(state.storyApp);
const boxText = (box) => boxWords({ ...box, nth: undefined });

// key 는 같은 계정과 같은 경로 변수 값으로 여는 주소면 같고, 한 번 쓰는 값을 새로 받아도 바뀌지 않는다.
/** @returns {{ s: any, key: string | null, reason?: string, entry?: any, link?: string, signedOut?: boolean, who?: any, opening?: (l: string) => string }} */
function pointPlace(screen, load) {
  const s = screenOf(screen);
  const { appLinks } = state.data;
  const role = frameAccount(s).role;
  const entry = appLinks[s.id] ? null : load ? pathValuesOf(s, role) : state.pathValues.get(pathValueKey(s.id, role));
  if (entry === undefined || entry?.pending) return { s, key: null };
  const values = entry && Object.fromEntries(Object.entries(entry.values).filter(([n]) => !entry.issued?.includes(n)));
  const key = JSON.stringify([s.id, frameAccount(s).url, values]);
  const target = frameTarget(s, entry);
  if (!target.link || target.fallback) {
    const missing = entry ? [...variablesOf(entry).filter((p) => !p.optional).map((p) => p.name), ...entry.queryNames].filter((n) => !entry.values[n]) : [];
    const reason = missing.length ? `${missing.join(', ')} 값이 없어 이 단계의 화면을 띄울 수 없습니다.` : '주소에 값이 필요한 화면이라 앱을 띄우지 않았습니다.';
    return { s, key, reason: [reason, ...(entry?.errors ?? [])].join(' ') };
  }
  return { s, key, entry, link: target.link, ...openingOf(s, target.link) };
}

function boxFindOf(screen, box) {
  if (!screenOf(screen)) return null;
  const { key } = pointPlace(screen, false);
  return key ? state.boxFinds.get(JSON.stringify([key, box])) ?? null : null;
}

function pressPoint(point) {
  state.point = { ...point, of: storyPlaceKey(state.candidate, state.story), turn: 0, status: null, answer: null, reason: null, missing: null, src: null, key: null, path: null, who: null, whoError: false, noAccount: false, missesRole: false, notes: [], issuing: false, fullError: null };
  state.storyApp = null;
  render();
  focusPointLine();
  document.getElementById('right').scrollTop = 0;
}

function focusPointLine() {
  /** @type {HTMLElement | null} */ (document.querySelector('#center tr.point-line.on'))?.focus({ preventScroll: true });
}

function closePoint() {
  state.point = null;
  state.storyApp = null;
  render();
}

function checkPoint() {
  const p = state.point;
  if (!p) return;
  const st = state.view === 'story' && !state.composing && !needOf() && p.of === storyPlaceKey(state.candidate, state.story) ? candidateOf() ?? storyOf() : undefined;
  const input = st?.steps[p.step]?.screen === p.screen ? st.stepFields?.[p.step]?.inputs?.[p.row] : undefined;
  if (input && JSON.stringify(input.box) === JSON.stringify(p.box) && screenOf(p.screen)) {
    p.value = input.value;
    return;
  }
  state.point = null;
  state.storyApp = null;
  renderPointPane();
}

function dropPointFrame() {
  if (!pointFrame) return;
  clearTimeout(pointFrame.timer);
  pointFrame = null;
}

function settlePoint(p) {
  const place = pointPlace(p.screen, true);
  if (place.reason) {
    p.reason = place.reason;
    return;
  }
  if (!place.link) return;
  Object.assign(p, {
    key: place.key,
    path: place.link.slice(new URL(place.link).origin.length) || '/',
    who: place.signedOut ? '로그인하지 않은 상태로 띄움' : place.who.error ?? `${place.who.role ? `${place.who.role} 역할 ` : ''}${place.who.id} 계정으로 띄움`,
    whoError: !place.signedOut && Boolean(place.who.error),
    noAccount: !place.signedOut && Boolean(place.who.noAccount),
    missesRole: !place.signedOut && Boolean(place.who.missesRole),
    notes: place.signedOut ? [] : place.who.notes,
  });
  if (pointFrame?.key === place.key && !pointFrame.moved) {
    p.src = pointFrame.src;
    return;
  }
  if (pointFrame?.moved) dropPointFrame();
  if (!place.entry?.issued) {
    p.src = place.opening(place.link);
    return;
  }
  if (p.issuing) return;
  p.issuing = true;
  freshSrc(place).then((src) => {
    if (state.point !== p) return;
    p.src = src;
    renderPointPane();
  }, (err) => {
    if (state.point !== p) return;
    p.reason = err.message;
    renderPointPane();
  });
}

async function freshSrc(place) {
  const got = await newIssued(place.s, place.entry, place.entry.values);
  return place.opening(frameTarget(place.s, { ...place.entry, values: { ...place.entry.values, ...got } }).link);
}

function newPointFrame(p) {
  const width = appSize.width || 1280;
  const frame = /** @type {HTMLIFrameElement} */ (h('iframe', { class: 'point-frame', title: '앱 화면에서 상자 주변' }));
  Object.assign(frame.style, { width: `${width}px`, height: `${POINT_FRAME_HEIGHT}px` });
  const f = { src: p.src, key: p.key, origin: new URL(p.src).origin, frame, width, height: POINT_FRAME_HEIGHT, loaded: false, moved: false, timer: undefined };
  frame.addEventListener('load', () => {
    if (pointFrame !== f) return;
    f.loaded = true;
    if (state.point?.src === f.src) askPoint(state.point);
  });
  frame.src = p.src;
  pointFrame = f;
  return frame;
}

function askPoint(p) {
  const f = pointFrame;
  const turn = ++pointTurn;
  Object.assign(p, { turn, status: 'asking' });
  clearTimeout(f.timer);
  f.timer = setTimeout(() => {
    if (state.point !== p || p.turn !== turn) return;
    p.status = 'silent';
    renderPointPane();
  }, POINT_ANSWER_MS);
  f.frame.contentWindow?.postMessage({ duru: 'find', box: p.box, turn }, f.origin);
}

const finite = (...ns) => ns.every((n) => typeof n === 'number' && Number.isFinite(n));

function checkedAnswer(d) {
  if (typeof d.url !== 'string' || !Array.isArray(d.boxes) || !finite(d.page?.w, d.page?.h, d.scroll?.x, d.scroll?.y)) return null;
  if (!d.boxes.every((b) => finite(b?.x, b?.y, b?.w, b?.h) && Array.isArray(b.kinds) && b.kinds.every((k) => Object.hasOwn(BOX_WORDS, k)))) return null;
  return { url: d.url, boxes: d.boxes, page: d.page, scroll: d.scroll };
}

function movedFrom(screen, url) {
  const route = state.data.screenRoutes.find((r) => r.id === screen);
  return route ? !new RegExp(route.source, route.flags).test(walkPath(url)) : walkScreenOf(url) !== screen;
}

window.addEventListener('message', (e) => {
  const p = state.point;
  const f = pointFrame;
  if (!p || !f || e.source !== f.frame.contentWindow || e.origin !== f.origin || e.data?.duru !== 'found' || e.data.turn !== p.turn) return;
  const answer = checkedAnswer(e.data);
  if (answer) takeAnswer(p, f, answer);
});

const padded = (b, pad) => ({ x1: b.x - pad, y1: b.y - pad, x2: b.x + b.w + pad, y2: b.y + b.h + pad });
const unionOf = (boxes, pad) => boxes.map((b) => padded(b, pad)).reduce((u, b) => ({ x1: Math.min(u.x1, b.x1), y1: Math.min(u.y1, b.y1), x2: Math.max(u.x2, b.x2), y2: Math.max(u.y2, b.y2) }));
const inView = (boxes, a, height) => boxes.every((b) => b.y >= a.scroll.y && b.y + b.h <= a.scroll.y + height);
const showing = (b) => b.w > 0 || b.h > 0;
const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
function sideOf(b, r) {
  const c = centre(b);
  return c.y < r.y ? '위쪽' : c.y > r.y + r.h ? '아래쪽' : c.x < r.x ? '왼쪽' : c.x > r.x + r.w ? '오른쪽' : null;
}

function takeAnswer(p, f, a) {
  clearTimeout(f.timer);
  if (movedFrom(p.screen, a.url)) {
    f.moved = true;
    Object.assign(p, { status: 'moved', answer: a });
    return renderPointPane();
  }
  const nth = p.box.nth ?? 1;
  const target = a.boxes[nth - 1];
  const span = (b) => Math.max(b.y + b.h, target.y + target.h) - Math.min(b.y, target.y);
  const near = target && showing(target) ? a.boxes.filter((b) => b === target || (showing(b) && span(b) <= POINT_CROP_MAX / POINT_READABLE)) : [];
  const grown = Math.min(a.page.h, POINT_FRAME_MAX);
  if (!inView(near, a, f.height) && grown > f.height) {
    f.height = grown;
    f.frame.style.height = `${grown}px`;
    return askPoint(p);
  }
  const status = !a.boxes.length ? 'none' : a.boxes.length < nth ? 'fewer' : 'found';
  const missing = status === 'none' ? `띄운 앱 화면에 ${boxText(p.box)}인 상자가 없습니다` : `${boxText(p.box)}인 상자가 ${a.boxes.length}개뿐이라 ${nth} 번째가 없습니다`;
  Object.assign(p, { status, answer: a, missing });
  if (status === 'found' || !accountTrouble(p)) state.boxFinds.set(JSON.stringify([p.key, p.box]), status === 'found' ? { found: true } : { found: false, reason: missing });
  renderPointPane();
  redrawPointLines();
}

function redrawPointLines() {
  if (state.view !== 'story' || storyAppShown()) return;
  if (composingNow()) return deferLive('draw');
  const lineFocused = document.activeElement?.matches('#center tr.point-line') ?? false;
  const place = fieldPlace();
  renderCenter();
  restoreField(place);
  if (lineFocused) focusPointLine();
}

function pointRegion(p, f, pad, room) {
  const a = p.answer;
  const reach = { w: room / POINT_READABLE, h: POINT_CROP_MAX / POINT_READABLE };
  const bottom = Math.min(a.page.h, a.scroll.y + f.height);
  const top = { x: a.scroll.x, y: a.scroll.y, w: Math.min(f.width, reach.w), h: Math.min(bottom - a.scroll.y, reach.h) };
  if (p.status !== 'found') return top;
  const target = a.boxes[(p.box.nth ?? 1) - 1];
  if (!showing(target)) return top;
  const widen = (lo, hi, least, limit) => {
    const more = Math.max(0, least - (hi - lo)) / 2;
    const from = Math.max(0, Math.min(lo - more, limit - Math.max(least, hi - lo)));
    return [from, Math.min(limit, Math.max(hi + more, from + least))];
  };
  const regionOf = (cut) => {
    const u = unionOf(cut, pad);
    const [x1, x2] = widen(Math.max(0, u.x1), Math.min(f.width, u.x2), POINT_MIN_WIDTH, Math.max(f.width, a.page.w));
    const [y1, y2] = widen(Math.max(a.scroll.y, u.y1), u.y2, POINT_MIN_HEIGHT, Math.max(bottom, u.y2));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  };
  const t = centre(target);
  const apart = (b) => Math.hypot(centre(b).x - t.x, centre(b).y - t.y);
  const others = a.boxes.filter((b) => b !== target && showing(b) && inView([b], a, f.height)).sort((b, c) => apart(b) - apart(c));
  let cut = [target];
  for (const b of others) {
    const r = regionOf([...cut, b]);
    if (r.w <= reach.w && r.h <= reach.h) cut = [...cut, b];
  }
  return regionOf(cut);
}

function drawPointCut(host) {
  const p = state.point;
  const f = pointFrame;
  const crop = /** @type {HTMLElement | null} */ (host.querySelector('.point-crop'));
  if (!p || !f || !crop) return;
  const a = p.answer ?? { url: '', boxes: [], page: { w: f.width, h: f.height }, scroll: { x: 0, y: 0 } };
  const room = crop.clientWidth;
  const scaleOf = (r) => Math.min(room / r.w, POINT_CROP_MAX / r.h, POINT_ZOOM_MAX);
  let region = pointRegion({ ...p, answer: a }, f, POINT_MARGIN, room);
  let k = scaleOf(region);
  if (POINT_MARGIN * k < POINT_MARGIN_SHOWN) {
    region = pointRegion({ ...p, answer: a }, f, POINT_MARGIN_SHOWN / k, room);
    k = scaleOf(region);
  }
  const dx = (room - region.w * k) / 2;
  crop.style.height = `${region.h * k}px`;
  crop.dataset.scale = String(k);
  f.frame.style.transform = `translate(${dx - (region.x - a.scroll.x) * k}px, ${-(region.y - a.scroll.y) * k}px) scale(${k})`;
  const at = (p.box.nth ?? 1) - 1;
  const shown = p.status === 'found' ? a.boxes : [];
  const drawn = shown.map((b, i) => showing(b) && (i === at || !sideOf(b, region)));
  const tight = (b) => dx + (b.x + b.w - region.x) * k + POINT_NO_ROOM > room;
  fill(crop.querySelector('.point-marks'), shown.map((b, i) => drawn[i] && h('div', {
    class: `point-mark${i === at ? ' target' : ''}${tight(b) ? ' tight' : ''}`,
    style: `left: ${dx + (b.x - region.x) * k - 3}px; top: ${(b.y - region.y) * k - 3}px; width: ${b.w * k + 6}px; height: ${b.h * k + 6}px`,
  }, shown.length > 1 ? h('span', { class: 'point-no' }, i + 1) : null)));
  const away = new Map();
  shown.forEach((b, i) => {
    if (!showing(b) || drawn[i]) return;
    const side = sideOf(b, region);
    away.set(side, [...(away.get(side) ?? []), i + 1]);
  });
  const awayNote = host.querySelector('.point-away');
  if (awayNote) awayNote.textContent = away.size ? ` ${[...away].map(([side, nos], i) => `${nos.join(' · ')}번은 ${i ? '' : '이 그림 '}${side}에`).join(', ')} 있습니다.` : '';
  const mini = host.querySelector('.point-mini');
  if (!mini || !p.answer) return;
  const miniHeight = Math.min(POINT_MINI_MAX, (POINT_MINI_WIDTH * a.page.h) / a.page.w);
  const kx = POINT_MINI_WIDTH / a.page.w;
  const ky = miniHeight / a.page.h;
  /** @type {HTMLElement} */ (mini).style.height = `${miniHeight}px`;
  fill(mini, h('i', { style: `left: ${region.x * kx}px; top: ${region.y * ky}px; width: ${Math.max(2, region.w * kx)}px; height: ${Math.max(2, region.h * ky)}px` }));
}

function sharedKind(boxes) {
  const kind = Object.keys(BOX_WORDS).find((k) => boxes.every((b) => b.kinds.includes(k)));
  return kind ? BOX_WORDS[kind] : '문구';
}

const accountTrouble = (p) => p.whoError || p.noAccount || p.missesRole;

function pointNotes(p) {
  if (p.reason) return [h('p', { class: 'point-why' }, p.reason)];
  if (!p.src) return [h('p', { class: 'point-why muted' }, '경로 변수 값을 준비하고 있습니다.')];
  const a = p.answer;
  const nth = p.box.nth ?? 1;
  if (p.status === 'found') {
    const target = a.boxes[nth - 1];
    return [
      a.boxes.length > 1 ? h('p', { class: 'point-note' }, `같은 ${sharedKind(a.boxes)}의 상자 ${a.boxes.length}개 가운데 ${nth} 번째를 짚었습니다.`, h('span', { class: 'point-away' })) : null,
      target.w === 0 && target.h === 0 ? h('p', { class: 'point-note muted' }, '짚은 상자가 지금 화면에 보이지 않습니다.') : null,
    ];
  }
  if ((p.status === 'none' || p.status === 'fewer') && accountTrouble(p)) return [h('p', { class: 'point-why' }, `${p.missing}. 앱을 띄운 계정에 문제가 있어 못 찾음으로 남기지 않았습니다.`)];
  if (p.status === 'none' || p.status === 'fewer') return [h('p', { class: 'point-missing' }, `못 찾음 · ${p.missing}`)];
  if (p.status === 'moved') return [h('p', { class: 'point-why' }, `앱이 이 단계의 화면이 아닌 ${a.url} 로 옮겨 가서 상자를 찾지 않았습니다.`)];
  if (p.status === 'silent') return [h('p', { class: 'point-why' }, NO_ANSWER)];
  return [h('p', { class: 'point-note muted' }, '앱 화면에서 상자를 찾고 있습니다.')];
}

function renderPointPane() {
  const host = document.getElementById('right-app');
  const p = pointShown() ? state.point : null;
  if (!p) {
    dropPointFrame();
    host.hidden = true;
    host.dataset.key = '';
    return fill(host);
  }
  host.hidden = false;
  if (!p.src && !p.reason) settlePoint(p);
  const key = p.src ?? '';
  if (host.dataset.key !== key || !host.firstChild || (p.src && !pointFrame)) {
    host.dataset.key = key;
    dropPointFrame();
    const frame = p.src ? newPointFrame(p) : null;
    fill(host, h('div', { class: 'point-block' },
      h('div', { class: 'point-head' },
        h('h2', {}, '앱 화면'),
        h('button', { type: 'button', class: 'point-close', title: '앱 화면을 닫고 스토리 정보만 보입니다', onclick: closePoint }, '닫기')),
      h('div', { class: 'point-which' }),
      h('div', { class: 'point-where' }),
      frame ? h('div', { class: 'point-crop', inert: true }, frame, h('div', { class: 'point-marks' })) : null,
      h('div', { class: 'point-after' })));
  }
  if (pointFrame?.loaded && !p.turn) askPoint(p);
  fill(host.querySelector('.point-which'), `${p.step + 1} 단계 · ${boxWords(p.box)} `, h('span', { class: 'mono' }, `→ ${p.value}`));
  const how = !p.answer && p.status !== 'silent' ? null : p.status === 'found' ? '앱 화면에서 상자 주변만 잘라 크게 보임' : '앱 화면 맨 위를 보임';
  fill(host.querySelector('.point-where'),
    p.answer && p.status !== 'silent' ? h('div', { class: 'point-mini', title: '앱 화면 전체에서 잘라 낸 자리' }) : null,
    h('div', { class: 'point-place' },
      p.path ? h('div', { class: 'mono' }, p.path) : null,
      p.who ? h('div', { class: p.whoError ? 'error' : null }, p.who) : null,
      p.notes.map((n) => h('div', { class: 'error' }, n)),
      how ? h('div', {}, how) : null));
  fill(host.querySelector('.point-after'),
    pointNotes(p),
    p.fullError ? h('p', { class: 'error' }, p.fullError) : null,
    p.src ? h('button', { type: 'button', class: 'point-full', title: '가운데 칸에 이 단계 화면의 앱 전체를 띄웁니다', onclick: () => openPointFull(p) }, '가운데에 앱 화면 전체 열기') : null);
  drawPointCut(host);
}

window.addEventListener('resize', () => {
  if (pointShown()) drawPointCut(document.getElementById('right-app'));
});

async function openPointFull(p) {
  const place = pointPlace(p.screen, false);
  let src = p.src;
  if (place.entry?.issued) {
    try {
      src = await freshSrc(place);
    } catch (err) {
      if (state.point !== p) return;
      p.fullError = err.message;
      return renderPointPane();
    }
    if (state.point !== p) return;
  }
  p.fullError = null;
  const center = document.getElementById('center');
  state.storyApp = { src, scroll: center.scrollTop };
  render();
  center.scrollTop = 0;
}

function closePointFull() {
  const scroll = state.storyApp?.scroll ?? 0;
  state.storyApp = null;
  render();
  document.getElementById('center').scrollTop = scroll;
}

function renderPointCenter() {
  const p = state.point;
  const head = document.getElementById('center-head');
  fill(document.getElementById('center-body'));
  const key = `point\n${state.storyApp.src}`;
  if (head.dataset.key === key) return;
  head.dataset.key = key;
  const stage = appStage(state.storyApp.src);
  stage.classList.add('point-stage');
  /** @type {HTMLIFrameElement} */ (stage.querySelector('iframe.app')).src = state.storyApp.src;
  fill(head,
    h('div', { class: 'frame-bar point-bar' },
      h('strong', {}, '앱 화면 전체'),
      h('span', { class: 'mono', title: p.path }, p.path),
      h('span', {}, p.who),
      h('button', { type: 'button', class: 'point-back', onclick: closePointFull }, '단계 카드로 돌아가기'),
      appWidthPicker()),
    stage);
}
