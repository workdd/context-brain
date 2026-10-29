// 화면과 무관한 판단 로직. 브라우저(window.CBModel)와 jest(require) 양쪽에서 쓴다.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CBModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 면적 지도(squarified treemap) ──────────────────────────
  // items: [{ value }] → [{ item, x, y, w, h }]. 값이 0 이하인 항목은 뺀다.
  function squarify(items, x, y, w, h) {
    const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
    const total = list.reduce((s, i) => s + i.value, 0);
    const out = [];
    if (!total || w <= 0 || h <= 0) return out;
    const scale = (w * h) / total;
    let row = [];
    let rect = [x, y, w, h];
    const area = (i) => i.value * scale;
    const worst = (r, side) => {
      const s = r.reduce((a, i) => a + area(i), 0);
      const max = Math.max(...r.map(area));
      const min = Math.min(...r.map(area));
      return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
    };
    const place = (r) => {
      const [rx, ry, rw, rh] = rect;
      const s = r.reduce((a, i) => a + area(i), 0);
      if (rw >= rh) {
        const cw = s / rh;
        let cy = ry;
        for (const it of r) { const ch = area(it) / cw; out.push({ item: it, x: rx, y: cy, w: cw, h: ch }); cy += ch; }
        rect = [rx + cw, ry, rw - cw, rh];
      } else {
        const ch = s / rw;
        let cx = rx;
        for (const it of r) { const cw = area(it) / ch; out.push({ item: it, x: cx, y: ry, w: cw, h: ch }); cx += cw; }
        rect = [rx, ry + ch, rw, rh - ch];
      }
    };
    for (const it of list) {
      const side = Math.min(rect[2], rect[3]);
      if (!row.length || worst(row.concat(it), side) <= worst(row, side)) row.push(it);
      else { place(row); row = [it]; }
    }
    if (row.length) place(row);
    return out;
  }

  // ── 답변 문장과 근거 연결 ──────────────────────────────────
  function splitSentences(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .split(/\n+|(?<=[.!?。])\s+/)
      .map((s) => s.replace(/^[\s>*#\-|]+/, '').replace(/\*\*/g, '').trim())
      .filter((s) => s.length > 1 && !/^[|:\-\s]+$/.test(s));
  }

  // 뉴런 id 에서 답변 본문에 나올 만한 이름을 뽑는다
  function needlesOf(id) {
    const i = id.indexOf(':');
    const kind = id.slice(0, i);
    const rest = id.slice(i + 1);
    const out = [];
    if (kind === 'file') out.push(rest.split('/').pop());
    else if (kind === 'skill') { out.push(rest); if (rest.includes(':')) out.push(rest.split(':').pop()); }
    else if (kind === 'web' && rest !== 'search') out.push(rest);
    else if (kind === 'mcp' || kind === 'agent') out.push(rest);
    return out.filter((n) => n && n.length >= 4);
  }

  // candidates: [{ id }] → 문장에 이름이 그대로 나온 후보 id 목록
  function findRefs(sentence, candidates) {
    const hits = [];
    for (const c of candidates) {
      if (needlesOf(c.id).some((n) => sentence.includes(n))) hits.push(c.id);
    }
    return hits;
  }

  // ── 낭비 후보 ─────────────────────────────────────────────
  // 컨텍스트에 남아 있고 크지만, 마지막으로 쓰인 뒤 idleTurns 턴 넘게 다시 쓰이지 않은 항목
  const WASTE_LOBES = new Set(['files', 'shell', 'web', 'agents', 'mcp', 'skills']);
  function wasteCandidates(neurons, currentTurn, { minTokens = 800, idleTurns = 2 } = {}) {
    return neurons
      .filter((n) => WASTE_LOBES.has(n.lobe) && !n.compacted && n.tokens >= minTokens && n.lastTurn > 0
        && currentTurn - n.lastTurn >= idleTurns)
      .sort((a, b) => b.tokens - a.tokens);
  }

  return { squarify, splitSentences, needlesOf, findRefs, wasteCandidates };
});
