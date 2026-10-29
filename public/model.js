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

  const WASTE_LOBES = new Set(['files', 'shell', 'web', 'agents', 'mcp', 'skills']);

  // ── 컨텍스트 진단 ─────────────────────────────────────────
  // 이벤트 기록만 보고 "어디서 토큰이 새는지 · 어떻게 줄이는지" 를 고른다.
  // 반환: { context, compactAt, reclaim, findings: [{ type, severity, tokens, items: [{ id, label, tokens, count }] }] }
  const STANDING_LOBES = new Set(['rules', 'memory', 'abilities', 'system']);
  const BIG_OUTPUT_LOBES = new Set(['shell', 'web', 'mcp', 'agents', 'files']);
  const SEVERITY = { high: 0, mid: 1, low: 2 };

  function diagnose(events, opts) {
    const o = Object.assign({ compactAt: null, minRead: 500, bigOutput: 4000, minTokens: 800, idleTurns: 2 }, opts || {});
    let turn = 0;
    let context = null;
    const reads = new Map();     // file id → { label, sizes[] }
    const big = [];
    const live = new Map();      // 마지막 압축 뒤 컨텍스트에 남은 항목 → { label, lobe, tokens, lastTurn }
    const standing = new Map();
    const mcpLoaded = new Map();
    const schemaLoaded = new Map();
    const used = new Set();
    const errors = new Map();
    for (const e of events) {
      if (e.kind === 'usage') { context = e.tokens; continue; }
      if (e.kind === 'compact') { live.clear(); continue; }
      if (!e.id) continue;
      if (e.lobe === 'dialog' && e.kind === 'use' && !e.id.startsWith('dlg:summary')) turn++;
      if (e.kind === 'use') used.add(e.id);
      const tok = e.tokens || 0;
      if (e.kind === 'load' && STANDING_LOBES.has(e.lobe)) {
        standing.set(e.id, { id: e.id, label: e.label, tokens: Math.max(tok, (standing.get(e.id) || {}).tokens || 0) });
        if (e.id.startsWith('abil:mcp:')) mcpLoaded.set(e.id.slice(9), { id: e.id, label: e.label, tokens: tok });
        if (e.id.startsWith('tool:')) schemaLoaded.set(e.id, { id: e.id, label: e.label, tokens: tok });
      }
      if (e.kind === 'result') {
        if (e.lobe === 'files' && e.id.startsWith('file:') && tok >= o.minRead) {
          const r = reads.get(e.id) || { label: e.label, sizes: [] };
          r.sizes.push(tok);
          reads.set(e.id, r);
        }
        if (BIG_OUTPUT_LOBES.has(e.lobe) && tok >= o.bigOutput) big.push({ id: e.id, label: e.label, tokens: tok, count: 1 });
        if (e.error) {
          const x = errors.get(e.id) || { id: e.id, label: e.label, tokens: 0, count: 0 };
          x.count++; x.tokens += tok;
          errors.set(e.id, x);
        }
      }
      if ((e.kind === 'result' || e.kind === 'load' || e.kind === 'use' || e.kind === 'ref') && WASTE_LOBES.has(e.lobe)) {
        const x = live.get(e.id) || { id: e.id, label: e.label, lobe: e.lobe, tokens: 0, lastTurn: 0 };
        // 화면의 뉴런과 같은 셈: 도구 입력(명령 · 쓴 내용)도 컨텍스트에 남으므로 더하고, 로드는 큰 쪽 하나
        x.tokens = e.kind === 'load' ? Math.max(x.tokens, tok) : x.tokens + tok;
        if (e.kind !== 'load' || e.lobe === 'skills') x.lastTurn = turn;
        live.set(e.id, x);
      }
    }

    const findings = [];
    const add = (type, severity, items, tokens) => {
      if (items.length) findings.push({ type, severity, tokens: tokens == null ? items.reduce((a, i) => a + i.tokens, 0) : tokens, items });
    };
    const byTokens = (a, b) => b.tokens - a.tokens;

    // 1. 같은 파일을 여러 번 통째로 읽음: 처음 한 번을 뺀 나머지가 중복
    const rereads = [...reads].filter(([, r]) => r.sizes.length >= 2).map(([id, r]) => {
      const sum = r.sizes.reduce((a, b) => a + b, 0);
      return { id, label: r.label, tokens: sum - Math.max(...r.sizes), count: r.sizes.length };
    }).sort(byTokens);
    add('reread', rereads.reduce((a, i) => a + i.tokens, 0) >= 5000 ? 'high' : 'mid', rereads);

    // 2. 한 번에 크게 들어온 도구 결과
    add('big-output', big.some((b) => b.tokens >= 10000) ? 'high' : 'mid', big.sort(byTokens));

    // 3. 들어와서 다시 안 쓰인 항목 (지금 컨텍스트에 남은 것만)
    const dead = [...live.values()].filter((x) => x.tokens >= o.minTokens && turn - x.lastTurn >= o.idleTurns).sort(byTokens)
      .map((x) => ({ id: x.id, label: x.label, tokens: x.tokens, count: turn - x.lastTurn }));
    add('dead-weight', dead.reduce((a, i) => a + i.tokens, 0) >= 10000 ? 'high' : 'mid', dead);

    // 4. 안내만 실리고 한 번도 안 부른 MCP 서버
    const idleMcp = [...mcpLoaded].filter(([server, x]) => !used.has('mcp:' + server) && x.tokens >= 200).map(([, x]) => ({ ...x, count: 0 }));
    add('unused-mcp', 'mid', idleMcp.sort(byTokens));

    // 5. 스키마를 불러 놓고 쓰지 않은 도구
    const idleSchema = [...schemaLoaded.values()].filter((x) => !used.has(x.id)).map((x) => ({ ...x, count: 0 }));
    add('unused-schema', 'low', idleSchema.sort(byTokens));

    // 6. 실패한 도구 호출
    const errs = [...errors.values()].sort((a, b) => b.count - a.count);
    if (errs.reduce((a, i) => a + i.count, 0) >= 3) add('errors', 'low', errs);

    // 7. 늘 실려 있는 고정 비용이 큼 (규칙 · 시스템 · 도구 목록 · 훅)
    const stand = [...standing.values()].filter((x) => x.tokens > 0).sort(byTokens);
    const standSum = stand.reduce((a, i) => a + i.tokens, 0);
    if (standSum >= 15000 || (context && standSum / context >= 0.3)) {
      findings.push({ type: 'standing', severity: 'low', tokens: standSum, items: stand.slice(0, 5).map((x) => ({ ...x, count: 0 })), reclaimable: false });
    }

    // 8. 압축 직전
    if (o.compactAt && context && context / o.compactAt >= 0.8) {
      findings.push({ type: 'near-compact', severity: 'high', tokens: Math.max(0, o.compactAt - context), items: [], reclaimable: false, ratio: context / o.compactAt });
    }

    findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.tokens - a.tokens);
    // 지금 되찾을 수 있는 양: 다시 안 쓰인 항목 + MCP 안내 + 안 쓴 스키마 (중복 읽기 · 큰 결과는 겹칠 수 있어 빼고 센다)
    const reclaim = findings.filter((f) => ['dead-weight', 'unused-mcp', 'unused-schema'].includes(f.type)).reduce((a, f) => a + f.tokens, 0);
    return { context, compactAt: o.compactAt, turns: turn, reclaim, findings };
  }

  // 진단 한 건을 사람이 읽는 문장으로. L(ko, en) 은 언어를 고르는 함수
  const pl = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function describe(f, L) {
    const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
    const top = f.items[0] ? f.items[0].label : '';
    switch (f.type) {
      case 'reread': return {
        title: L(`같은 파일을 여러 번 통째로 읽음 · 중복 ${k(f.tokens)}`, `Same files read in full more than once · ${k(f.tokens)} duplicated`),
        fix: L('필요한 줄만 offset · limit 로 읽거나 Grep 으로 위치를 먼저 찾게 하세요. 한 번 읽은 내용은 요약해 두라고 지시하면 다시 읽지 않습니다.',
          'Ask for Read with offset/limit or a Grep first. Telling Claude to summarize a file once stops it from re-reading.') };
      case 'big-output': return {
        title: L(`한 번에 큰 도구 결과 ${f.items.length}건 · ${k(f.tokens)}`, `${pl(f.items.length, 'oversized tool result')} · ${k(f.tokens)}`),
        fix: L(`출력을 head · grep · tail 로 줄이거나 조용한 옵션(-q)을 쓰게 하세요. 가장 큰 것: ${top}`,
          `Pipe output through head, grep or tail, or use quiet flags (-q). Largest: ${top}`) };
      case 'dead-weight': return {
        title: L(`들어와서 다시 안 쓰인 항목 ${f.items.length}개 · ${k(f.tokens)}`, `${pl(f.items.length, 'item')} never used again · ${k(f.tokens)}`),
        fix: L('작업이 바뀌는 지점에서 /compact 나 /clear 를 쓰면 이 양이 빠집니다. 다음 작업에 필요한 것만 한 줄로 남기라고 지시하세요.',
          'Run /compact or /clear at the task boundary to drop this. Ask for a one-line note of what the next task needs.') };
      case 'unused-mcp': return {
        title: L(`안 쓴 MCP 서버 안내 ${f.items.length}개 · ${k(f.tokens)}`, `${pl(f.items.length, 'MCP server')} loaded but never called · ${k(f.tokens)}`),
        fix: L(`이 프로젝트에서 쓰지 않는 서버는 끄세요 (/mcp 또는 설정의 enabledMcpjsonServers). 예: ${top}`,
          `Disable servers this project does not use (/mcp or enabledMcpjsonServers). e.g. ${top}`) };
      case 'unused-schema': return {
        title: L(`불러 놓고 안 쓴 도구 스키마 ${f.items.length}개 · ${k(f.tokens)}`, `${pl(f.items.length, 'tool schema')} loaded but unused · ${k(f.tokens)}`),
        fix: L('도구를 찾느라 스키마를 여러 개 불렀습니다. 쓸 도구 이름을 지시에 직접 적으면 줄어듭니다.',
          'Claude loaded schemas while searching for a tool. Naming the tool in your prompt avoids this.') };
      case 'errors': return {
        title: L(`실패한 도구 호출 ${f.items.reduce((a, i) => a + i.count, 0)}회`, `${pl(f.items.reduce((a, i) => a + i.count, 0), 'failed tool call')}`),
        fix: L(`같은 실패가 반복되면 원인(권한 · 경로 · 명령)을 먼저 알려 주세요. 가장 많은 것: ${top}`,
          `If the same call keeps failing, tell Claude the cause (permission, path, command). Most frequent: ${top}`) };
      case 'standing': return {
        title: L(`늘 실려 있는 고정 비용 ${k(f.tokens)}`, `${k(f.tokens)} of fixed context on every turn`),
        fix: L(`매 턴 다시 읽히는 양입니다. CLAUDE.md 를 줄이고 안 쓰는 스킬 · 플러그인 · 훅을 끄세요. 가장 큰 것: ${top}`,
          `This is paid on every turn. Trim CLAUDE.md and disable unused skills, plugins and hooks. Largest: ${top}`) };
      case 'near-compact': return {
        title: L(`자동 압축 직전 · ${Math.round(f.ratio * 100)}%`, `About to auto-compact · ${Math.round(f.ratio * 100)}%`),
        fix: L('자동 압축은 무엇을 남길지 고를 수 없습니다. 지금 /compact 에 남길 내용을 적어 직접 압축하세요.',
          'Auto-compaction decides what survives. Run /compact now with a note on what to keep.') };
      default: return { title: f.type, fix: '' };
    }
  }

  // 파서가 붙이는 고정 이름(한국어)의 영어. 파일 · 명령 이름은 그대로 둔다
  const LABEL_EN = { 'sys:prompt': 'System prompt', 'abil:skills': 'Skill list', 'abil:agents': 'Agent list',
    'abil:deferred': 'Deferred tool names', 'out:thinking': 'Thinking', 'out:answer': 'Answer', 'web:search': 'Web search' };
  function labelEn(id, label) {
    if (!label || !id) return label;
    if (LABEL_EN[id]) return LABEL_EN[id];
    if (id.startsWith('dlg:summary')) return 'Compaction summary';
    if (id.startsWith('abil:mcp:')) return label.replace(/ 안내$/, ' instructions');
    if (/^입력 #\d+$/.test(label)) return label.replace('입력', 'Prompt');
    return label === '(입력)' ? '(prompt)' : label;
  }

  // ── 프로젝트 진단 ─────────────────────────────────────────
  // 같은 프로젝트의 세션 여러 개를 모아, 한 세션에선 우연일 수 있는 것을 반복 패턴으로 확인한다.
  // sessions: [{ file, title, mtime, events }] (최근 것이 앞)
  // 명령에서 실제로 돈 프로그램 이름. cd · export 구간과 환경 변수 대입은 건너뛴다
  function shellProgramOf(cmd) {
    const firstLine = String(cmd || '').split('\n')[0]; // 여러 줄 명령(heredoc)은 첫 줄의 프로그램만 본다
    for (const seg of firstLine.split(/&&|\|\||;/)) {
      const words = seg.replace(/^[\s({]+/, '').split(/\s+/).filter(Boolean);
      if (!words.length || ['cd', 'export', 'set', 'source', '.'].includes(words[0])) continue;
      const w = words.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) && !['sudo', 'time', 'env', 'command'].includes(x));
      if (!w) continue;
      if (/^\.{0,2}\//.test(w) && !w.includes('/bin/')) return '?';
      const name = w.split('/').pop();
      return /^[\w@+.-]+$/.test(name) && !/\.(md|txt|json|ya?ml|csv|html?)$/i.test(name) ? name : '?';
    }
    return '?';
  }

  const READ_LIKE = new Set(['cat', 'sed', 'head', 'tail', 'awk', 'less', 'nl', 'bat', 'wc', 'grep', 'rg', 'ls', 'find', 'jq']);

  function projectReport(sessions, opts) {
    const o = Object.assign({ compactAt: null }, opts || {});
    const mcp = new Map();       // server → { loaded, called, tokens }
    const files = new Map();     // file id → { label, sessions: Set, reads, tokens }
    const shell = new Map();     // program → { calls, tokens, sessions: Set }
    const standing = new Map();  // id → { label, sessions, tokens }
    const rows = [];
    for (const s of sessions) {
      const r = diagnose(s.events, o);
      const cmd = new Map();
      const loadedMcp = new Set();
      const calledMcp = new Set();
      let compactions = 0;
      for (const e of s.events) {
        if (e.kind === 'compact') { compactions++; continue; }
        if (!e.id) continue;
        if (e.kind === 'load' && e.id.startsWith('abil:mcp:')) {
          const k = e.id.slice(9);
          loadedMcp.add(k);
          const m = mcp.get(k) || { server: k, label: e.label, loaded: 0, called: 0, tokens: 0 };
          m.tokens = Math.max(m.tokens, e.tokens || 0);
          mcp.set(k, m);
        }
        if (e.kind === 'use' && e.id.startsWith('mcp:')) calledMcp.add(e.id.slice(4));
        if (e.kind === 'load' && STANDING_LOBES.has(e.lobe) && e.tokens) {
          const x = standing.get(e.id) || { id: e.id, label: e.label, sessions: new Set(), tokens: 0 };
          x.sessions.add(s.file);
          x.tokens = Math.max(x.tokens, e.tokens);
          standing.set(e.id, x);
        }
        if (e.kind === 'use' && e.lobe === 'shell') cmd.set(e.id, shellProgramOf(e.input || e.detail));
        if (e.kind === 'result' && e.lobe === 'shell') {
          const p = cmd.get(e.id) || '?';
          const x = shell.get(p) || { program: p, calls: 0, tokens: 0, sessions: new Set() };
          x.calls++; x.tokens += e.tokens || 0; x.sessions.add(s.file);
          shell.set(p, x);
        }
        if (e.kind === 'result' && e.lobe === 'files' && e.id.startsWith('file:') && (e.tokens || 0) >= 300) {
          const x = files.get(e.id) || { id: e.id, label: e.label, sessions: new Set(), reads: 0, tokens: 0 };
          x.sessions.add(s.file); x.reads++; x.tokens += e.tokens;
          files.set(e.id, x);
        }
      }
      for (const k of loadedMcp) { const m = mcp.get(k); m.loaded++; if (calledMcp.has(k)) m.called++; }
      rows.push({ file: s.file, title: s.title, mtime: s.mtime, turns: r.turns, context: r.context, reclaim: r.reclaim,
        compactions, high: r.findings.filter((f) => f.severity === 'high').length });
    }
    const n = sessions.length;
    const findings = [];
    const push = (type, severity, items, tokens) => { if (items.length) findings.push({ type, severity, tokens, items }); };

    // MCP 서버: 여러 세션에 실렸는데 한 번도 안 부름 → 끌 근거가 확실하다
    const idleMcp = [...mcp.values()].filter((m) => m.loaded >= 2 && m.called === 0)
      .map((m) => ({ id: 'abil:mcp:' + m.server, label: m.label, tokens: m.tokens, count: m.loaded }))
      .sort((a, b) => b.tokens * b.count - a.tokens * a.count);
    push('p-unused-mcp', idleMcp.length ? 'high' : 'low', idleMcp, idleMcp.reduce((a, i) => a + i.tokens * i.count, 0));

    // 세션마다 다시 읽는 파일 → 요점을 CLAUDE.md 에 적어 두면 읽지 않는다
    const hot = [...files.values()].filter((f) => f.sessions.size >= Math.max(2, Math.ceil(n * 0.3)))
      .map((f) => ({ id: f.id, label: f.label, tokens: f.tokens, count: f.sessions.size, reads: f.reads }))
      .sort((a, b) => b.tokens - a.tokens);
    push('p-hot-files', 'mid', hot.slice(0, 12), hot.reduce((a, i) => a + i.tokens, 0));

    // 결과가 늘 큰 셸 프로그램 → 조용한 옵션 · 출력 줄이기
    // cat · sed · head 같은 파일 읽기는 범위를 골라 읽는 것이라 빼고, 빌드 · 테스트 · 로그처럼 출력이 큰 명령만 본다
    const loud = [...shell.values()].filter((x) => !READ_LIKE.has(x.program) && x.calls >= 3 && x.tokens / x.calls >= 1500)
      .map((x) => ({ id: 'prog:' + x.program, label: x.program, tokens: x.tokens, count: x.calls, avg: Math.round(x.tokens / x.calls) }))
      .sort((a, b) => b.tokens - a.tokens);
    push('p-loud-shell', 'mid', loud, loud.reduce((a, i) => a + i.tokens, 0));

    // 매 세션 실리는 고정 비용
    const always = [...standing.values()].filter((x) => x.sessions.size >= Math.ceil(n * 0.5))
      .map((x) => ({ id: x.id, label: x.label, tokens: x.tokens, count: x.sessions.size })).sort((a, b) => b.tokens - a.tokens);
    const fixed = always.reduce((a, i) => a + i.tokens, 0);
    push('p-fixed', fixed >= 20000 ? 'mid' : 'low', always.slice(0, 8), fixed);

    findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.tokens - a.tokens);
    const ctx = rows.map((r) => r.context).filter((v) => v != null).sort((a, b) => a - b);
    return {
      sessions: n,
      turns: rows.reduce((a, r) => a + r.turns, 0),
      compactions: rows.reduce((a, r) => a + r.compactions, 0),
      medianContext: ctx.length ? ctx[ctx.length >> 1] : null,
      fixed,
      rows,
      findings,
    };
  }

  function describeProject(f, L) {
    const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
    const top = f.items[0] ? f.items[0].label : '';
    switch (f.type) {
      case 'p-unused-mcp': return {
        title: L(`여러 세션에 실렸지만 한 번도 안 부른 MCP 서버 ${f.items.length}개`, `${pl(f.items.length, 'MCP server')} loaded in many sessions, never called`),
        fix: L(`세션마다 안내만 실립니다. 이 프로젝트에서 끄세요 (.mcp.json · /mcp). 예: ${top} (${f.items[0].count}개 세션)`,
          `Their instructions ride along every session. Disable them for this project (.mcp.json, /mcp). e.g. ${top} (${f.items[0].count} sessions)`) };
      case 'p-hot-files': return {
        title: L(`세션마다 다시 읽는 파일 ${f.items.length}개 · 합계 ${k(f.tokens)}`, `${pl(f.items.length, 'file')} re-read in session after session · ${k(f.tokens)} total`),
        fix: L(`구조 · 규칙 · 자주 찾는 위치를 CLAUDE.md 에 몇 줄로 적어 두면 매번 통째로 읽지 않습니다. 가장 큰 것: ${top}`,
          `A few lines in CLAUDE.md on structure, rules and where things live save reading them whole each time. Largest: ${top}`) };
      case 'p-loud-shell': return {
        title: L(`출력이 늘 큰 명령 ${f.items.length}개 · 합계 ${k(f.tokens)}`, `${pl(f.items.length, 'command')} with consistently large output · ${k(f.tokens)} total`),
        fix: L(`조용한 옵션(-q, --silent, --reporter=dot)이나 | tail -n 30 을 CLAUDE.md 에 규칙으로 적으세요. 가장 큰 것: ${top}`,
          `Put quiet flags (-q, --silent, --reporter=dot) or | tail -n 30 in CLAUDE.md as a rule. Largest: ${top}`) };
      case 'p-fixed': return {
        title: L(`세션마다 실리는 고정 비용 ${k(f.tokens)}`, `${k(f.tokens)} of fixed context in every session`),
        fix: L(`첫 입력 전에 이미 차 있는 양입니다. 가장 큰 것부터 줄이세요: ${top}`, `This is spent before your first prompt. Cut from the top: ${top}`) };
      default: return { title: f.type, fix: '' };
    }
  }

  // ── 컨텍스트 히스토리 ─────────────────────────────────────
  // API 호출(usage)마다 표본 하나: 실측 크기, 영역별 추정 크기, 직전 호출 뒤 새로 들어온 항목.
  // 압축 때 빠지는 영역은 화면과 같은 규칙으로 비운다.
  const DROPS_ON_COMPACT = new Set(['dialog', 'files', 'shell', 'web', 'agents', 'mcp', 'output']);
  function contextSeries(events) {
    const live = new Map();   // id → { lobe, tokens }
    const samples = [];
    const turns = [];
    const compactions = [];
    let pending = new Map();  // 직전 표본 뒤 들어온 항목 id → { id, label, lobe, tokens }
    let turn = 0;
    let last = null;
    events.forEach((e, i) => {
      if (e.kind === 'compact') {
        for (const [id, x] of live) if (DROPS_ON_COMPACT.has(x.lobe)) live.delete(id);
        compactions.push({ i, tokens: e.tokens || 0, at: samples.length });
        return;
      }
      if (e.kind === 'usage') {
        if (last != null && e.tokens === last) return; // 같은 응답이 여러 줄로 남은 것
        last = e.tokens;
        const lobes = {};
        let est = 0;
        for (const x of live.values()) { lobes[x.lobe] = (lobes[x.lobe] || 0) + x.tokens; est += x.tokens; }
        const added = [...pending.values()].sort((a, b) => b.tokens - a.tokens);
        samples.push({ i, t: e.t, turn, ctx: e.tokens, est, lobes, added: added.slice(0, 5),
          addedTotal: added.reduce((a, x) => a + x.tokens, 0), delta: samples.length ? e.tokens - samples[samples.length - 1].ctx : 0 });
        pending = new Map();
        return;
      }
      if (!e.id || !e.lobe) return;
      if (e.lobe === 'dialog' && e.kind === 'use' && !e.id.startsWith('dlg:summary')) {
        turn++;
        turns.push({ i, n: turn, label: e.label, at: samples.length });
      }
      if (!e.tokens) return;
      const x = live.get(e.id) || { lobe: e.lobe, tokens: 0 };
      const before = x.tokens;
      x.tokens = e.kind === 'load' ? Math.max(x.tokens, e.tokens) : x.tokens + e.tokens;
      live.set(e.id, x);
      const grew = x.tokens - before;
      if (grew > 0) {
        const p = pending.get(e.id) || { id: e.id, label: e.label, lobe: e.lobe, tokens: 0 };
        p.tokens += grew;
        pending.set(e.id, p);
      }
    });
    return { samples, turns, compactions };
  }

  // 가장 크게 불어난 지점들 (이름표를 달 후보). 서로 minGap 표본 이상 떨어진 것만
  function growthSpikes(samples, n, minGap) {
    const picked = [];
    const order = samples.map((s, k) => ({ k, s })).filter((x) => x.s.delta > 0).sort((a, b) => b.s.delta - a.s.delta);
    for (const x of order) {
      if (picked.length >= (n || 4)) break;
      if (picked.every((p) => Math.abs(p.k - x.k) >= (minGap || 3))) picked.push(x);
    }
    return picked.sort((a, b) => a.k - b.k);
  }

  return { squarify, splitSentences, needlesOf, findRefs, diagnose, describe, labelEn, projectReport, describeProject, shellProgramOf,
    contextSeries, growthSpikes };
});
