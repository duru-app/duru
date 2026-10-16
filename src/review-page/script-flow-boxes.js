// 주소는 「/」 앞에서만 줄이 바뀌도록 조각마다 묶는다.
const pathText = (path) => path.split(/(?=\/)/).flatMap((seg, i) => [i ? h('wbr') : null, h('span', { class: 'seg' }, seg)]);

// 여는 조건은 종류만 배지에 적고, 무엇이 필요한지는 마우스를 올리면 보인다.
const needTag = (n) => (!n.restricted ? null : n.kinds.length ? n.kinds.map((k) => KIND_LABEL[k]).join('·') : MIXED_KINDS);
const PICK_TIP = '누르면 이 화면에 이어진 길만 진하게 남기고 이 화면을 엽니다';
const COMPOSE_TIP = '누르면 새 스토리의 단계로 넣습니다';

function screenPill(n, pick = () => pickScreen(n.id)) {
  const status = statusOf(n.counts);
  const guardLabel = n.guards.length ? guardText(n.guards) : null;
  const needs = openNeeds({ access: { ...n.access, kinds: n.kinds, restricted: n.restricted } });
  const need = needTag(n);
  return h('div', {
    role: 'button',
    tabindex: '0',
    class: `box screen ${status}`,
    title: [
      n.id,
      `${STATUS_WORD[status]}${n.imported ? ` · 불러옴 ${n.imported}` : ''}${n.passed ? ` · 지나감 ${n.passed}` : ''}`,
      guardLabel ? `이 링크의 조건: ${guardLabel}` : '',
      n.moved ? `${LINK_VERDICT.configured}: ${n.moved.join(', ')}` : '',
      ...needs.tips,
      needs.bare ?? '',
      flowComposing() ? COMPOSE_TIP : PICK_TIP,
    ].filter(Boolean).join('\n'),
    'aria-pressed': 'false',
    onclick: pick,
    onkeydown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pick();
    },
  },
    h('span', { class: 'sq' }), h('span', { class: 'sr-only' }, STATUS_WORD[status]),
    h('span', { class: 'path' }, pathText(n.label)),
    n.calls.length ? h('span', { class: 'tag api' }, `API ${n.calls.length}`) : null,
    need ? h('span', { class: 'tag need' }, need) : null,
    n.dead ? h('span', { class: 'tag dead' }, '죽은 화면') : null,
    talkCount(attachedTalk({ node: n.id })));
}

const PATH_TAG = { conditioned: LINK_VERDICT.conditioned, configured: LINK_VERDICT.configured, broken: LINK_VERDICT.broken, unknown: LINK_VERDICT.unknown, 'off-map': '맵에 없는 화면' };
const hopTitle = (l, i) => [`단계 ${i + 1} → ${i + 2}`, PATH_TAG[l.verdict] ?? LINK_VERDICT[l.verdict], LINK_VERDICT_TITLE[l.verdict]].filter(Boolean).join(' · ');

// 단계 번호와 떨어진 단계로 가는 표지는 상자 안에 넣고, 이웃 단계로 가는 선의 표지와 숨긴 화면 수만 상자 곁에 둔다.
function storyMarks({ st, hidden }, boxes, els) {
  const parentOf = new Map(boxes.map((b) => [b.key, b.parent]));
  const marks = [];
  const edges = new Map();
  const mark = (key, kind, el) => {
    el.classList.add('mark');
    el.dataset.at = key;
    el.style.visibility = 'hidden';
    marks.push({ key, kind, el });
  };
  const numbers = new Map();
  st.steps.forEach((s, i) => {
    if (s.onMap && els.has(s.screen)) numbers.set(s.screen, [...(numbers.get(s.screen) ?? []), i + 1]);
  });
  const before = new Map();
  const after = new Map();
  const add = (into, id, el) => into.set(id, [...(into.get(id) ?? []), el]);
  const hover = (i, on) => () => {
    for (const c of document.querySelectorAll(`#flow .story-chip[data-hop="${i}"]`)) c.classList.toggle('hovered', on);
  };
  st.links.forEach((l, i) => {
    const from = st.steps[i].onMap && els.has(l.from) ? l.from : null;
    const to = st.steps[i + 1].onMap && els.has(l.to) ? l.to : null;
    const tag = PATH_TAG[l.verdict];
    if (from && to && parentOf.get(to) === from) {
      const key = `${from}\n${to}`;
      if (!edges.has(key) && tag) mark(to, 'tag', h('span', { class: `story-tag l-${l.verdict}`, title: hopTitle(l, i) }, tag));
      edges.set(key, l.verdict);
      return;
    }
    const chip = (end, ...text) => h('span', {
      class: `story-chip ${end} l-${l.verdict}`, title: hopTitle(l, i), 'data-hop': i, onmouseenter: hover(i, true), onmouseleave: hover(i, false),
    }, l.verdict === 'broken' ? h('b', {}, '✕') : null, ...text);
    if (from) add(after, from, chip('exit', `→ ${i + 2}`, tag ? h('small', {}, tag) : null));
    if (to) add(before, to, chip('entry', `${i + 1} →`));
  });
  for (const [id, nums] of numbers) {
    const pill = els.get(id);
    pill.classList.add('on-story');
    pill.prepend(...(before.get(id) ?? []), h('span', { class: 'story-badge' }, nums.join('·')));
    pill.append(...(after.get(id) ?? []));
  }
  for (const [id, n] of hidden) if (els.has(id)) mark(id, 'hidden', h('span', { class: 'story-hidden' }, `다른 화면 ${n} 숨김`));
  return { marks, edges };
}

const hopClass = (verdict) => `story-edge l-${verdict}${verdict === 'configured' ? ' moved' : ''}`;

function pathLegend() {
  const line = (verdict) => svg('svg', { viewBox: '0 0 40 8', 'aria-hidden': 'true' }, svg('path', { class: hopClass(verdict), d: 'M2 4H38' }));
  const row = (sample, name) => h('li', {}, h('span', { class: 'sample', 'aria-hidden': 'true' }, sample), h('span', {}, name));
  return [
    row(h('span', { class: 'story-badge' }, '3'), '단계 번호'),
    row(line('open'), LINK_VERDICT.open),
    row(line('conditioned'), PATH_TAG.conditioned),
    row(line('configured'), PATH_TAG.configured),
    row(line('broken'), PATH_TAG.broken),
    row(line('off-map'), `${PATH_TAG['off-map']} · ${PATH_TAG.unknown}`),
  ];
}

function storyOn(st) {
  if (!st) return null;
  return h('span', { class: 'story-on' },
    h('strong', { class: 'story-name', title: st.id }, st.name),
    writtenCount(st),
    h('button', { class: 'path-off', onclick: () => pickStory('') }, '경로 끄기'),
    legendInfo('path', '스토리 경로 읽는 법', pathLegend()));
}

const HOP_WIDTH = 104;

function goesTo(l, i, byId) {
  const n = byId.get(l.from);
  const ids = new Set([...n.children.map((c) => c.id), ...n.jumps.map((j) => j.to)]);
  const targets = state.data.map.screens.filter((s) => ids.has(s.id));
  const from = () => h('code', {}, screenLabel(l.from));
  return h('li', {}, `${i + 1} → ${i + 2} 단계: `, from(), ' 에서 ', h('code', {}, screenLabel(l.to)), ' 로 가는 링크가 맵에 없습니다. ',
    targets.length
      ? [from(), ' 에서 갈 수 있는 화면: ', h('span', { class: 'goes-to' }, targets.flatMap((s, k) => [k ? ', ' : null, h('code', { title: s.id }, s.path)]))]
      : [from(), ' 에서 갈 수 있는 화면이 없습니다.']);
}

function storyLine(st) {
  const byId = new Map(flowScreens().map((n) => [n.id, n]));
  const { ring } = state.storyPath;
  const step = (s, i) => {
    const box = s.onMap
      ? screenPill({ ...byId.get(s.screen), guards: [] }, () => ringStep(i))
      : h('div', {
          role: 'button', tabindex: '0', class: 'box story-off', title: `${s.screen}\n${PATH_TAG['off-map']}`,
          onclick: () => ringStep(i),
          onkeydown: (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            ringStep(i);
          },
        }, h('span', { class: 'path' }, s.screen), h('span', { class: 'tag off' }, PATH_TAG['off-map']));
    box.prepend(h('span', { class: 'story-badge' }, i + 1));
    const written = writtenCount(st.stepFields?.[i]);
    if (written) box.append(written);
    box.append(bubbleButton(stepTarget(st.id, i, s.screen), SLOT_WORDS.step, `단계 ${i + 1} ${s.onMap ? screenLabel(s.screen) : s.screen}`));
    Object.assign(box.dataset, { step: i, screen: s.screen }, s.onMap ? { key: s.screen } : {});
    box.classList.toggle('story-ring', ring === i);
    return box;
  };
  const hop = (l, i) => h('div', { class: `story-hop l-${l.verdict}`, 'data-hop': i, title: [hopTitle(l, i), ...(l.reasons ?? [])].join(' · ') },
    svg('svg', { width: HOP_WIDTH, height: 8, 'aria-hidden': 'true' }, svg('path', { class: hopClass(l.verdict), d: `M2 4H${HOP_WIDTH - 2}` })),
    PATH_TAG[l.verdict] ? h('span', { class: `story-tag l-${l.verdict}` }, PATH_TAG[l.verdict]) : null,
    bubbleButton(hopTarget(st.id, i, l), SLOT_WORDS.hop, `단계 ${i + 1} → ${i + 2} 연결`));
  const gaps = st.links.flatMap((l, i) => (l.verdict === 'broken' ? [goesTo(l, i, byId)] : []));
  const el = h('div', { class: 'canvas story story-line' },
    h('div', { class: 'story-row' }, st.steps.flatMap((s, i) => [i ? hop(st.links[i - 1], i - 1) : null, step(s, i)])),
    gaps.length ? h('ul', { class: 'plain story-gaps' }, gaps) : null);
  const holder = h('div', { class: 'zoom-box' }, el);
  return {
    el: holder,
    place() {
      const z = state.zoom;
      el.style.transform = z === 1 ? '' : `scale(${z})`;
      Object.assign(holder.style, { width: `${el.offsetWidth * z}px`, height: `${el.offsetHeight * z}px` });
    },
  };
}

