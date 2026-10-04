// Pole of inaccessibility (after mapbox/polylabel): the interior point that is
// farthest from the polygon outline — the nicest place for a label.

interface Cell { x: number; y: number; h: number; d: number; max: number }

function pointToRingsDist(x: number, y: number, rings: number[][]): number {
  let inside = false;
  let minSq = Infinity;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      minSq = Math.min(minSq, segDistSq(x, y, ax, ay, bx, by));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  let x = ax, y = ay;
  let dx = bx - x, dy = by - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = px - x; dy = py - y;
  return dx * dx + dy * dy;
}

function makeCell(x: number, y: number, h: number, rings: number[][]): Cell {
  const d = pointToRingsDist(x, y, rings);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

/** rings[0] is the outer ring, the rest are holes. */
export function polylabel(rings: number[][], precision: number): [number, number] {
  const outer = rings[0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]);
    minY = Math.min(minY, outer[i + 1]); maxY = Math.max(maxY, outer[i + 1]);
  }
  const w = maxX - minX, hgt = maxY - minY;
  const size = Math.min(w, hgt);
  if (size === 0) return [minX, minY];
  let h = size / 2;
  const queue: Cell[] = [];
  const push = (c: Cell) => {
    queue.push(c);
    let i = queue.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (queue[p].max >= queue[i].max) break;
      [queue[p], queue[i]] = [queue[i], queue[p]];
      i = p;
    }
  };
  const pop = (): Cell => {
    const top = queue[0];
    const last = queue.pop()!;
    if (queue.length) {
      queue[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < queue.length && queue[l].max > queue[m].max) m = l;
        if (r < queue.length && queue[r].max > queue[m].max) m = r;
        if (m === i) break;
        [queue[m], queue[i]] = [queue[i], queue[m]];
        i = m;
      }
    }
    return top;
  };
  for (let x = minX; x < maxX; x += size) {
    for (let y = minY; y < maxY; y += size) push(makeCell(x + h, y + h, h, rings));
  }
  // centroid as a first guess
  let best = centroidCell(rings);
  const bboxCell = makeCell(minX + w / 2, minY + hgt / 2, 0, rings);
  if (bboxCell.d > best.d) best = bboxCell;
  let guard = 0;
  while (queue.length && guard++ < 4000) {
    const cell = pop();
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precision) continue;
    h = cell.h / 2;
    push(makeCell(cell.x - h, cell.y - h, h, rings));
    push(makeCell(cell.x + h, cell.y - h, h, rings));
    push(makeCell(cell.x - h, cell.y + h, h, rings));
    push(makeCell(cell.x + h, cell.y + h, h, rings));
  }
  return [best.x, best.y];
}

function centroidCell(rings: number[][]): Cell {
  const r = rings[0];
  let area = 0, x = 0, y = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1];
    const f = ax * by - bx * ay;
    x += (ax + bx) * f; y += (ay + by) * f; area += f * 3;
  }
  if (area === 0) return makeCell(r[0], r[1], 0, rings);
  return makeCell(x / area, y / area, 0, rings);
}
