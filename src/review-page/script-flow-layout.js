function flowBoxes(roots) {
  const out = [];
  const walk = (node, parent) => {
    out.push({ key: node.id, node, parent });
    for (const c of node.children) walk(c, node.id);
  };
  for (const r of roots) walk(r, null);
  return out;
}

// 높이는 이 결과로 폭이 정해진 뒤에 재므로 sizes[key].height 는 아직 없어도 된다.
const cellsPerRow = (count, cellW, width) => Math.max(1, Math.min(count, Math.floor((width + CELL_GAP) / (cellW + CELL_GAP))));

// marks 는 스토리 경로에서 상자 곁에 두는 선의 「조건」 같은 표지와 숨긴 화면 수다.
function flowColumns(roots, sizes, { group = false, width = 0, marks = [] } = {}) {
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
    if (d !== undefined && m.kind === 'tag') entryW[d] = Math.max(entryW[d], laneWidth(m));
  }
  const xs = colWidths.map(() => entryW[0] ?? 0);
  for (let d = 1; d < colWidths.length; d += 1) xs[d] = xs[d - 1] + colWidths[d - 1] + Math.max(COL_GAP, LANE_CURVE + entryW[d]);
  const cellW = Math.max(0, ...gathered.map((r) => sizes[r.id].width));
  const sized = {};
  for (const [key, d] of depths) sized[key] = colWidths[d];
  for (const r of gathered) sized[r.id] = cellW;
  return {
    widths: sized,
    grouped: new Set(gathered.map((r) => r.id)),
    trees, depths, xs, grid: gathered, cellW, per: cellsPerRow(gathered.length, cellW, width), entryW,
    span: colWidths.length ? xs[colWidths.length - 1] + colWidths[colWidths.length - 1] : 0,
  };
}

// 선의 「조건」 같은 표지는 선이 상자에 닿는 자리 바로 앞에, 숨긴 화면 수는 상자 아래에 둔다.
const laneWidth = (m) => m.width + STUB + LANE_PAD;

function laneMarks(placed, marks) {
  const byKey = new Map(placed.map((b) => [b.key, b]));
  return marks.map((m) => {
    const b = byKey.get(m.key);
    return m.kind === 'hidden' ? { x: b.x + 8, y: b.y + b.height + UNDER_GAP } : { x: b.x - m.width - STUB, y: b.y + b.height / 2 - m.height / 2 };
  });
}

// sizes[key] 는 { width: 본래 폭, height: flowColumns 가 정한 폭으로 그려 잰 높이 } 이다. cols 는 같은 sizes 와 view 로 이미 구한 flowColumns 결과다.
function layoutFlow(roots, sizes, view = {}, cols = flowColumns(roots, sizes, view)) {
  const { marks } = view;
  const middle = (b) => b.y + b.height / 2;
  const below = new Map((marks ?? []).filter((m) => m.kind === 'hidden').map((m) => [m.key, UNDER_GAP + m.height]));
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
    cursor = Math.max(cursor, y + height + (below.get(key) ?? 0) + GAP);
    return self;
  };
  for (const r of cols.trees) place(r, null);
  let height = cursor;
  let span = cols.span;
  let heading = null;
  if (cols.grid.length) {
    const { grid, cellW, per } = cols;
    const top = cols.trees.length ? cursor + GROUP_SPACE : 0;
    let rowY = top + GROUP_HEAD_H;
    for (let i = 0; i < grid.length; i += per) {
      let rowBottom = rowY;
      grid.slice(i, i + per).forEach((screen, j) => {
        placed.push({ key: screen.id, node: screen, parent: null, x: j * (cellW + CELL_GAP), y: rowY, width: cellW, height: sizes[screen.id].height, grouped: true });
        rowBottom = Math.max(rowBottom, rowY + sizes[screen.id].height);
      });
      rowY = rowBottom + GAP;
    }
    height = rowY;
    span = Math.max(span, per * cellW + (per - 1) * CELL_GAP);
    heading = { x: 0, y: top, height: GROUP_HEAD_H, count: grid.length };
  }
  const byKey = new Map(placed.map((b) => [b.key, b]));
  const edges = placed.filter((b) => b.parent !== null).map((b) => {
    const from = byKey.get(b.parent);
    return { from: b.parent, to: b.key, x1: from.x + from.width, y1: middle(from), x2: b.x, y2: middle(b), guards: b.node.guards, ...(b.node.moved && { moved: b.node.moved }) };
  });
  if (marks) for (const e of edges) e.nx = e.x2 - cols.entryW[cols.depths.get(e.to)];
  const spots = marks && laneMarks(placed, marks);
  marks?.forEach((m, i) => {
    height = Math.max(height, spots[i].y + m.height + GAP);
    span = Math.max(span, spots[i].x + m.width);
  });
  return {
    boxes: placed.map((b) => ({ key: b.key, x: b.x, y: b.y, width: b.width, height: b.height, grouped: b.grouped })),
    edges,
    group: heading,
    width: span,
    height,
    ...(marks && { marks: spots }),
  };
}

