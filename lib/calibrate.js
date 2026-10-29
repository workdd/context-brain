'use strict';
// 세션 로그의 실측 사용량으로 토큰 추정 계수를 맞춘다 (context-brain calibrate).
// 두 응답 사이 컨텍스트 증가량(다음 응답의 입력 - 이전 응답의 입력 - 이전 응답의 출력)을
// 그 사이에 들어온 도구 결과 글자 수(ASCII · 한글 · 그 밖)로 회귀한다. 이미지가 낀 구간은 뺀다.
const fs = require('fs');
const path = require('path');
const { listSessions } = require('./sessions');
const tokens = require('./tokens');

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/g;
function charClasses(s) {
  const hangul = (s.match(HANGUL) || []).length;
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return [ascii, hangul, s.length - ascii - hangul];
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : '')).join('') : '');
const hasImage = (c) => Array.isArray(c) && c.some((x) => x && x.type === 'image');

function samples(file) {
  const out = [];
  let prev = null;          // { id, ctx, outTok }
  let acc = [0, 0, 0];
  let clean = true;
  let blocks = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (e.isSidechain) continue;
    if (e.type === 'system' && e.subtype === 'compact_boundary') { prev = null; continue; }
    if (e.type === 'user' && e.message) {
      const c = e.message.content;
      if (typeof c === 'string') { clean = false; continue; }      // 사용자 입력 구간은 덮개 문장이 섞여 뺀다
      for (const b of c || []) {
        if (b.type !== 'tool_result') { clean = false; continue; }
        if (hasImage(b.content)) clean = false;
        const k = charClasses(textOf(b.content));
        acc = acc.map((v, i) => v + k[i]);
        blocks++;
      }
    }
    if (e.type === 'attachment' && e.attachment && e.attachment.type !== 'hook_success') clean = false;
    if (e.type === 'assistant' && e.message && e.message.usage) {
      const u = e.message.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (prev && e.message.id === prev.id) { prev.outTok = u.output_tokens || prev.outTok; continue; }
      if (prev && clean && blocks === 1 && acc[0] + acc[1] + acc[2] > 200) {
        const y = ctx - prev.ctx - prev.outTok;
        if (y > 0) out.push({ x: acc, y });
      }
      prev = { id: e.message.id, ctx, outTok: u.output_tokens || 0 };
      acc = [0, 0, 0]; clean = true; blocks = 0;
    }
  }
  return out;
}

// 최소제곱: y ≈ a·ascii + b·hangul + c·other + d
function fit(rows) {
  const X = rows.map((r) => [...r.x, 1]);
  const n = 4;
  const A = Array.from({ length: n }, () => Array(n + 1).fill(0));
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += X[k][i] * X[k][j];
      A[i][n] += X[k][i] * r.y;
    }
  });
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < n; r++) {
      if (r === i || !A[i][i]) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) > 1e-9 ? row[n] / row[i] : 0));
}

// est(x) 의 오차 요약: 중앙 상대 오차, 90번째 상대 오차, 추정 합계 / 실측 합계
function evaluate(rows, est) {
  const errs = rows.map((r) => Math.abs(est(r.x) - r.y) / r.y).sort((a, b) => a - b);
  const ratio = rows.reduce((a, r) => a + est(r.x), 0) / rows.reduce((a, r) => a + r.y, 0);
  return { median: errs[errs.length >> 1], p90: errs[Math.floor(errs.length * 0.9)], ratio };
}

function calibrate(files) {
  const rows = files.flatMap((f) => { try { return samples(f); } catch (_) { return []; } });
  if (rows.length < 30) return { samples: rows.length };
  // 표본이 적은 글자 종류(예: 한글을 안 쓰는 사용자)는 그 열을 빼고 기본 계수로 고정한다
  const D = tokens.DEFAULT;
  const defaults = [D.ascii, D.hangul, D.other];
  const free = [0, 1, 2].filter((i) => rows.filter((r) => r.x[i] > 0).length >= 10);
  const fixed = (x) => [0, 1, 2].filter((i) => !free.includes(i)).reduce((a, i) => a + defaults[i] * x[i], 0);
  const sub = rows.map((r) => ({ x: [...free.map((i) => r.x[i]), 0, 0, 0].slice(0, 3), y: r.y - fixed(r.x) }));
  const solved = fit(sub);
  const c = [...defaults];
  free.forEach((col, k) => { if (solved[k] > 0) c[col] = solved[k]; });
  const [ascii, hangul, other] = c;
  const perResult = solved[3];
  const coef = { ascii, hangul, other, perResult: Math.max(0, Math.round(perResult)) };
  const naive = evaluate(rows, (x) => (x[0] + x[1] + x[2]) / 4);
  const fitted = evaluate(rows, (x) => ascii * x[0] + hangul * x[1] + other * x[2] + perResult);
  return { samples: rows.length, coef, naive, fitted };
}

function save(coef, meta, file = tokens.FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...coef, ...meta, at: new Date().toISOString() }, null, 2));
  return file;
}

module.exports = { samples, fit, charClasses, evaluate, calibrate, save, listSessions };
