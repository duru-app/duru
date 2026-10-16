let mainScroll = null;

function pickStory(id) {
  const flow = document.getElementById('flow');
  const was = state.storyPath?.id ?? null;
  if (id && !was) mainScroll = { scrollTop: flow.scrollTop, scrollLeft: flow.scrollLeft };
  if (id) showStoryPath(id);
  else if (state.storyPath) leaveStoryPath();
  render();
  Object.assign(flow, id ? { scrollTop: 0, scrollLeft: 0 } : mainScroll ?? {});
  if (!id) mainScroll = null;
  /** @type {HTMLElement} */ (document.querySelector(`#flow-story-list li[data-story="${CSS.escape(id || was || '')}"]`))?.focus();
}

// 이미 고른 화면을 다시 누르면 오른쪽 칸에 쓰던 표시를 그대로 둔다.
function openPicked(id) {
  const again = state.flowPicked && state.target?.node === id;
  state.flowPicked = true;
  state.side = 'screens';
  if (again) render();
  else select(id);
  showBox(id);
}

function ringScreen(id) {
  const st = pathStoryOf();
  if (!st || st.steps[state.storyPath.ring]?.screen === id) return;
  const i = st.steps.findIndex((s) => s.onMap && s.screen === id);
  state.storyPath.ring = i < 0 ? null : i;
}

function pickScreen(id) {
  if (flowComposing()) return addComposeScreen(id);
  ringScreen(id);
  openPicked(id);
}

function unpickScreen() {
  state.flowPicked = false;
  if (state.storyPath) state.storyPath.ring = null;
  render();
}

function ringStep(i) {
  const st = pathStoryOf();
  if (!st) return;
  state.storyPath.ring = i;
  if (!st.steps[i].onMap) return renderFlow();
  openPicked(st.steps[i].screen);
}

function showBox(key) {
  const flow = document.getElementById('flow');
  const at = `.box.screen[data-key="${CSS.escape(key)}"]`;
  const box = flow.querySelector(`${at}.story-ring`) ?? flow.querySelector(at);
  if (!box) return;
  const view = flow.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  const by = (start, end, from, to) => (start < from || end - start > to - from ? start - from : end > to ? end - to : 0);
  flow.scrollTop += by(r.top, r.bottom, view.top + parseFloat(getComputedStyle(flow).paddingTop), view.bottom - 16);
  flow.scrollLeft += by(r.left, r.right, view.left + 16, view.right - 32);
}

// 상자는 페이지에 붙은 뒤에야 잴 수 있으므로, 상자를 붙인 쪽이 measureWidths → fit → measureHeights → place 순서로 불러 위치를 정한다.
// 확대·축소는 배치를 마친 그림을 통째로 키우거나 줄이고, 그림을 감싼 칸이 바뀐 크기만큼 자리를 차지한다.
function canvas(roots, { group = false, story = null } = {}) {
  const boxes = flowBoxes(roots);
  const els = new Map(boxes.map((b) => [b.key, screenPill(b.node)]));
  for (const [key, box] of els) {
    box.classList.add('measuring');
    box.dataset.key = key;
  }
  const path = story && storyMarks(story, boxes, els);
  const view = { group, marks: path?.marks };
  const el = h('div', { class: ['canvas', story && 'story', story?.composing && 'composing'].filter(Boolean).join(' ') }, [...els.values()], path?.marks.map((m) => m.el));
  const holder = h('div', { class: 'zoom-box' }, el);
  const sizes = {};
  let cols;
  return {
    el: holder,
    measureWidths() {
      for (const [key, box] of els) sizes[key] = { width: Math.ceil(box.getBoundingClientRect().width) };
      for (const m of path?.marks ?? []) {
        const r = m.el.getBoundingClientRect();
        Object.assign(m, { width: Math.ceil(r.width), height: Math.ceil(r.height) });
      }
    },
    fit(width) {
      cols = flowColumns(roots, sizes, { ...view, width });
      for (const [key, box] of els) {
        box.classList.remove('measuring');
        box.classList.toggle('grouped', cols.grouped.has(key));
        box.style.width = `${cols.widths[key]}px`;
      }
    },
    measureHeights() {
      for (const [key, box] of els) sizes[key].height = box.getBoundingClientRect().height;
    },
    place() {
      const out = layoutFlow(roots, sizes, view, cols);
      for (const b of out.boxes) Object.assign(els.get(b.key).style, { left: `${b.x}px`, top: `${b.y}px` });
      const lines = svg('svg', { width: out.width, height: out.height });
      for (const e of out.edges) {
        const end = e.nx ?? e.x2;
        const mx = (e.x1 + end) / 2;
        const d = `M${e.x1},${e.y1} C${mx},${e.y1} ${mx},${e.y2} ${end},${e.y2}${end === e.x2 ? '' : ` H${e.x2}`}`;
        const hop = path?.edges.get(`${e.from}\n${e.to}`);
        const cls = [e.guards.length ? 'guarded' : '', e.moved ? 'moved' : '', hop ? `story-edge l-${hop}` : ''].filter(Boolean).join(' ');
        lines.append(svg('path', { d, class: cls, 'data-from': e.from, 'data-to': e.to }));
      }
      el.prepend(lines);
      out.marks?.forEach(({ x, y }, i) => Object.assign(path.marks[i].el.style, { left: `${x}px`, top: `${y}px`, visibility: '' }));
      if (out.group) {
        const { x, y, height, count } = out.group;
        el.append(h('h2', { class: 'group-head', style: `left:${x}px;top:${y}px;height:${height}px`, title: GROUP_HEAD_TIP }, `딸린 화면이 없는 진입 화면 ${count}`));
      }
      const z = state.zoom;
      Object.assign(el.style, { width: `${out.width}px`, height: `${out.height}px`, transform: z === 1 ? '' : `scale(${z})` });
      Object.assign(holder.style, { width: `${out.width * z}px`, height: `${out.height * z}px` });
      return out.group && { count: out.group.count, cellW: cols.cellW, per: cols.per };
    },
  };
}

