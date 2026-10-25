// 이미 고른 화면을 다시 누르면 오른쪽 칸에 쓰던 표시를 그대로 둔다.
function openPicked(id) {
  const again = state.flowPicked && state.target?.node === id;
  state.flowPicked = true;
  state.side = 'screens';
  if (again) render();
  else select(id);
  showBox(id);
}

function pickScreen(id) {
  if (composeDiagram()) return addComposeScreen(id, true);
  openPicked(id);
}

// 다시 그리면 누른 단추가 사라지므로, 같은 묶음의 펴고 접는 단추로 초점을 옮긴다.
function setFlowGroup(name, open) {
  if (open) state.openFlowGroups.add(name);
  else state.openFlowGroups.delete(name);
  renderFlow({ bar: false });
  const at = `[data-group="${CSS.escape(name)}"]`;
  /** @type {HTMLElement | null} */ (document.querySelector(`#flow ${open ? `.group-open${at}` : `.box.group${at}`}`))?.focus({ preventScroll: true });
}

function setFlowBranch(id, open) {
  if (open) state.openFlowBranches.add(id);
  else state.openFlowBranches.delete(id);
  renderFlow({ bar: false });
  showBox(id);
  /** @type {HTMLElement | null} */ (document.querySelector(`#flow .box.screen[data-key="${CSS.escape(id)}"] .fold-branch`))?.focus({ preventScroll: true });
}

function unpickScreen() {
  state.flowPicked = false;
  render();
}

function showBox(key) {
  const flow = document.getElementById('flow');
  const box = flow.querySelector(`.box.screen[data-key="${CSS.escape(key)}"]`);
  if (!box) return;
  const view = flow.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  const by = (start, end, from, to) => (start < from || end - start > to - from ? start - from : end > to ? end - to : 0);
  flow.scrollTop += by(r.top, r.bottom, view.top + parseFloat(getComputedStyle(flow).paddingTop), view.bottom - 16);
  flow.scrollLeft += by(r.left, r.right, view.left + 16, view.right - 32);
}

// 상자는 페이지에 붙은 뒤에야 잴 수 있으므로, 상자를 붙인 쪽이 measureWidths → fit → measureHeights → place 순서로 불러 위치를 정한다.
// 확대·축소는 배치를 마친 그림을 통째로 키우거나 줄이고, 그림을 감싼 칸이 바뀐 크기만큼 자리를 차지한다.
function canvas(trees, { group = false, story = null } = {}) {
  const { shown: cut, foldable } = state.data.flow.folding ? foldBranches(trees, state.openFlowBranches) : { shown: trees, foldable: new Map() };
  const { shown: roots, opened, unseen: hidden } = group ? foldGroups(cut, state.data.flow.groups, state.openFlowGroups) : { shown: cut, opened: new Map(), unseen: [] };
  const fold = (id) => (foldable.has(id) ? { below: foldable.get(id), open: state.openFlowBranches.has(id) } : null);
  // 펴서 그리드를 떠난 진입 화면도 접힌 모습으로 재어, 펴고 접어도 그리드의 칸 폭과 칸 수가 그대로 서게 한다.
  const left = group ? cut.filter((r) => foldable.has(r.id) && state.openFlowBranches.has(r.id)) : [];
  const unseen = [...hidden, ...left.map((r) => ({ ...r, id: `folded:${r.id}`, children: [], fold: { ...fold(r.id), open: false } }))];
  const boxes = flowBoxes(roots);
  const els = new Map(boxes.map((b) => [b.key, b.node.kind === 'group' ? groupPill(b.node) : screenPill(b.node, fold(b.key))]));
  for (const [key, box] of els) {
    box.classList.add('measuring');
    box.dataset.key = key;
  }
  const path = story && storyMarks(story, boxes, els);
  const view = { group, marks: path?.marks, opened, unseen };
  const ghosts = unseen.map((n) => {
    const ghost = n.kind === 'group' ? groupPill(n) : screenPill(n, n.fold ?? null);
    ghost.classList.add('measuring');
    return ghost;
  });
  const el = h('div', { class: ['canvas', story && 'story'].filter(Boolean).join(' ') }, [...els.values()], path?.marks.map((m) => m.el), ghosts);
  const holder = h('div', { class: 'zoom-box' }, el);
  const sizes = {};
  let cols;
  return {
    el: holder,
    measureWidths() {
      for (const [key, box] of els) sizes[key] = { width: Math.ceil(box.getBoundingClientRect().width) };
      unseen.forEach((n, i) => { sizes[n.id] = { width: Math.ceil(ghosts[i].getBoundingClientRect().width) }; });
      for (const m of path?.marks ?? []) {
        const r = m.el.getBoundingClientRect();
        Object.assign(m, { width: Math.ceil(r.width), height: Math.ceil(r.height) });
      }
    },
    fit(width) {
      cols = flowColumns(roots, sizes, { ...view, width });
      for (const ghost of ghosts) ghost.remove();
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
      for (const frame of out.opened) {
        el.prepend(h('div', { class: 'group-frame', 'aria-hidden': 'true', style: `left:${frame.x}px;top:${frame.y}px;width:${frame.width}px;height:${frame.height}px` }));
        el.append(openGroupHead(frame));
      }
      out.marks?.forEach(({ x, y }, i) => Object.assign(path.marks[i].el.style, { left: `${x}px`, top: `${y}px`, visibility: '' }));
      if (out.group) {
        const { x, y, height, count } = out.group;
        el.append(h('h2', { class: 'group-head', style: `left:${x}px;top:${y}px;height:${height}px`, title: foldable.size ? FOLDED_HEAD_TIP : GROUP_HEAD_TIP }, `${foldable.size ? '진입 화면' : '딸린 화면이 없는 진입 화면'} ${count}`));
      }
      const z = state.zoom;
      Object.assign(el.style, { width: `${out.width}px`, height: `${out.height}px`, transform: z === 1 ? '' : `scale(${z})` });
      Object.assign(holder.style, { width: `${out.width * z}px`, height: `${out.height * z}px` });
      return out.group && { count: cols.cells, cellW: cols.cellW, per: cols.per };
    },
  };
}

