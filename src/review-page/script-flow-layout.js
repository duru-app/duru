function flowBoxes(roots) {
  const out = [];
  const walk = (node, parent) => {
    out.push({ key: node.id, node, parent });
    for (const c of node.children) walk(c, node.id);
  };
  for (const r of roots) walk(r, null);
  return out;
}

const groupKey = (name) => `group:${name}`;

const FOLD_OVER = 6;
function foldBranches(roots, open) {
  const foldable = new Map();
  const cut = (n, root) => {
    const below = screensIn(n.children);
    const folds = below.length > (root ? 0 : FOLD_OVER);
    if (folds) foldable.set(n.id, below);
    return { ...n, children: folds && !open.has(n.id) ? [] : n.children.map((c) => cut(c, false)) };
  };
  return { shown: roots.map((r) => cut(r, true)), foldable };
}

// unseen 은 그리지 않고 재기만 하는 상자로, 접힌 묶음의 화면과 펴진 묶음의 묶음 상자다. 화면은 칸 폭과 한 줄의 칸 수에,
// 묶음 상자는 칸 폭에만 넣어, 묶음을 펴고 접어도 칸이 그대로 서게 한다.
function foldGroups(roots, groups, open) {
  const byId = new Map(roots.map((r) => [r.id, r]));
  const groupOf = new Map(groups.flatMap((g) => g.screens.map((id) => [id, g])));
  const shown = [];
  const opened = new Map();
  const unseen = [];
  const seen = new Set();
  for (const r of roots) {
    const g = r.children.length ? undefined : groupOf.get(r.id);
    if (!g) shown.push(r);
    else if (!seen.has(g.name)) {
      seen.add(g.name);
      const screens = g.screens.map((id) => byId.get(id)).filter(Boolean);
      const pill = { kind: 'group', id: groupKey(g.name), name: g.name, screens, children: [], guards: [] };
      if (!open.has(g.name)) {
        shown.push(pill);
        unseen.push(...screens);
      } else {
        unseen.push(pill);
        for (const screen of screens) {
          shown.push(screen);
          opened.set(screen.id, g.name);
        }
      }
    }
  }
  return { shown, opened, unseen };
}

// 높이는 이 결과로 폭이 정해진 뒤에 재므로 sizes[key].height 는 아직 없어도 된다.
const cellsPerRow = (count, cellW, width) => Math.max(1, Math.min(count, Math.floor((width + CELL_GAP) / (cellW + CELL_GAP))));

function flowColumns(roots, sizes, { group = false, width = 0, marks = [], unseen = [] } = {}) {
  const gathered = group ? roots.filter((r) => !r.children.length) : [];
  const trees = group ? roots.filter((r) => r.children.length) : roots;
  const depths = new Map();
  const walk = (node, depth) => {
    depths.set(node.id, depth);
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const r of trees) walk(r, 0);
  const colWidths = [];
  for (const [key, d] of depths) colWidths[d] = Math.max(colWidths[d] ?? 0, sizes[key].width);
  const entryW = colWidths.map(() => 0);
  for (const m of marks) {
    const d = depths.get(m.key);
    if (d !== undefined) entryW[d] = Math.max(entryW[d], laneWidth(m));
  }
  const xs = colWidths.map(() => entryW[0] ?? 0);
  for (let d = 1; d < colWidths.length; d += 1) xs[d] = xs[d - 1] + colWidths[d - 1] + Math.max(COL_GAP, LANE_CURVE + entryW[d]);
  const cellW = Math.max(0, ...[...gathered, ...unseen].map((r) => sizes[r.id].width));
  const cells = [...gathered, ...unseen].filter((r) => r.kind !== 'group').length;
  const sized = {};
  for (const [key, d] of depths) sized[key] = colWidths[d];
  for (const r of gathered) sized[r.id] = cellW;
  return {
    widths: sized,
    grouped: new Set(gathered.map((r) => r.id)),
    trees, depths, xs, grid: gathered, cellW, cells, per: cellsPerRow(cells, cellW, width), entryW,
    span: colWidths.length ? xs[colWidths.length - 1] + colWidths[colWidths.length - 1] : 0,
  };
}

// 「조건」 같은 표시는 그 선이 들어가는 상자 바로 앞에 놓는다.
const laneWidth = (m) => m.width + STUB + LANE_PAD;

function laneMarks(placed, marks) {
  const byKey = new Map(placed.map((b) => [b.key, b]));
  return marks.map((m) => {
    const b = byKey.get(m.key);
    return { x: b.x - m.width - STUB, y: b.y + b.height / 2 - m.height / 2 };
  });
}

// sizes[key] 는 { width: 본래 폭, height: flowColumns 가 정한 폭으로 그려 잰 높이 } 이다. cols 는 같은 sizes 와 view 로 이미 구한 flowColumns 결과다.
function layoutFlow(roots, sizes, view = {}, cols = flowColumns(roots, sizes, view)) {
  const { marks } = view;
  const middle = (b) => b.y + b.height / 2;
  const placed = [];
  let cursor = 0;
  const lower = (from, by) => {
    for (const b of placed.slice(from)) b.y += by;
    cursor += by;
  };
  const place = (node, parent) => {
    const key = node.id;
    const { height } = sizes[key];
    const top = cursor;
    const from = placed.length;
    const kids = node.children.map((c) => place(c, key));
    let y = top;
    if (kids.length) {
      y = (middle(kids[0]) + middle(kids[kids.length - 1])) / 2 - height / 2;
      if (y < top) {
        lower(from, top - y);
        y = top;
      }
    }
    const self = { key, node, parent, x: cols.xs[cols.depths.get(key)], y, width: cols.widths[key], height, grouped: false };
    placed.push(self);
    cursor = Math.max(cursor, y + height + GAP);
    return self;
  };
  for (const r of cols.trees) place(r, null);
  let height = cursor;
  let span = cols.span;
  let heading = null;
  const frames = [];
  if (cols.grid.length) {
    const { grid, cellW, per } = cols;
    const opened = view.opened ?? new Map();
    const rowW = per * cellW + (per - 1) * CELL_GAP;
    const top = cols.trees.length ? cursor + GROUP_SPACE : 0;
    let rowY = top + GROUP_HEAD_H;
    let rowBottom = rowY;
    let j = 0;
    /** @type {{ name: string, x: number, y: number, width: number, height: number, count: number } | null} */
    let frame = null;
    const endRow = () => {
      if (j) rowY = rowBottom + GAP;
      rowBottom = rowY;
      j = 0;
    };
    const open = (name) => {
      endRow();
      rowY += OPEN_PAD;
      frame = { name, x: 0, y: rowY, width: rowW, height: 0, count: 0 };
      frames.push(frame);
      rowY += GROUP_HEAD_H;
      rowBottom = rowY;
    };
    const shut = () => {
      endRow();
      frame.height = rowY - GAP - frame.y;
      rowY += OPEN_PAD;
      rowBottom = rowY;
      frame = null;
    };
    for (const node of grid) {
      const name = opened.get(node.id) ?? null;
      if (frame && frame.name !== name) shut();
      if (name && !frame) open(name);
      if (j === per) endRow();
      placed.push({ key: node.id, node, parent: null, x: j * (cellW + CELL_GAP), y: rowY, width: cellW, height: sizes[node.id].height, grouped: true });
      rowBottom = Math.max(rowBottom, rowY + sizes[node.id].height);
      if (frame) frame.count += 1;
      j += 1;
    }
    if (frame) shut();
    endRow();
    height = rowY;
    span = Math.max(span, rowW);
    heading = { x: 0, y: top, height: GROUP_HEAD_H, count: cols.cells };
  }
  const byKey = new Map(placed.map((b) => [b.key, b]));
  const edges = placed.filter((b) => b.parent !== null).map((b) => {
    const from = byKey.get(b.parent);
    return { from: b.parent, to: b.key, x1: from.x + from.width, y1: middle(from), x2: b.x, y2: middle(b), guards: b.node.guards, ...(b.node.moved && { moved: b.node.moved }), ...(marks && { nx: b.x - cols.entryW[cols.depths.get(b.key)] }) };
  });
  const spots = marks && laneMarks(placed, marks);
  marks?.forEach((m, i) => {
    height = Math.max(height, spots[i].y + m.height + GAP);
    span = Math.max(span, spots[i].x + m.width);
  });
  return {
    boxes: placed.map((b) => ({ key: b.key, x: b.x, y: b.y, width: b.width, height: b.height, grouped: b.grouped })),
    edges,
    group: heading,
    opened: frames,
    width: span,
    height,
    ...(marks && { marks: spots }),
  };
}

