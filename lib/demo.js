'use strict';
// 데모 세션 기록. 로그인 401 · 주문 API 병목 · 배포 점검 세 턴으로 이뤄진다.
// 첫 턴에서 읽은 큰 파일은 뒤 턴에서 다시 안 쓰여 낭비 후보가 된다

const { countText, coefficients } = require('./tokens');

function demoSession(start = Date.now() - 10 * 60 * 1000, lang = 'ko') {
  const tr = (ko, en) => (lang === 'en' ? en : ko);
let clock = start;
  let seq = 0;
  const ts = () => new Date((clock += 4000)).toISOString();
  const att = (attachment) => ({ type: 'attachment', timestamp: ts(), attachment });
  const user = (content, extra = {}) => {
    const text = typeof content === 'string' ? content : content.map((c) => (c.type === 'tool_result' ? String(c.content) : c.text || '')).join('');
    due += countText(text) + (typeof content === 'string' ? 0 : content.filter((c) => c.type === 'tool_result').length * coefficients().perResult);
    return { type: 'user', timestamp: ts(), uuid: 'u' + seq++, message: { role: 'user', content }, ...extra };
  };
  // 실제 로그처럼 사용자 입력 · 도구 결과 · 직전 응답의 출력은 다음 API 호출의 입력 크기에 반영된다
  let ctx = 18000;
  let due = 0;
  const assistant = (content, out = 150) => {
    ctx += due;
    due = out;
    return { type: 'assistant', timestamp: ts(),
      message: { model: 'claude-demo', content, usage: { input_tokens: 2, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, output_tokens: out } } };
  };
  const tool = (name, input, result) => {
    const id = 'toolu_demo_' + seq++;
    return [assistant([{ type: 'tool_use', id, name, input }], 120), user([{ type: 'tool_result', tool_use_id: id, content: result }])];
  };
  const pad = (s, n) => s + '\n' + '.'.repeat(n);
  
  // 세션 시작 시 실리는 것들
  const boot = [
    att({ type: 'prompt_snapshot', systemPrompt: [pad('You are Claude Code…', 24000)] }),
    att({ type: 'instructions', files: [
      { path: '/home/dev/.claude/CLAUDE.md', type: 'User', content: pad(tr('# 전역 규칙\n- 커밋 메시지는 한국어', '# Global rules\n- Write commit messages in English'), 6000) },
      { path: '/home/dev/shop-api/CLAUDE.md', type: 'Project', content: pad(tr('# shop-api\n- 테스트: npm test', '# shop-api\n- Tests: npm test'), 3000) },
    ] }),
    att({ type: 'skill_listing', content: pad('- systematic-debugging: …', 9000) }),
    att({ type: 'agent_listing_delta', addedLines: [pad('- Explore: read-only search agent', 2000)] }),
    att({ type: 'mcp_instructions_delta', addedNames: ['github'], addedBlocks: [pad('## github\nIssues, PRs', 1500)] }),
    att({ type: 'mcp_instructions_delta', addedNames: ['slack'], addedBlocks: [pad('## slack\nChannels, messages', 2400)] }),
    att({ type: 'hook_additional_context', content: [pad(tr('[shop-api] recent context: 지난주 결제 모듈 리팩터링', '[shop-api] recent context: payment module refactor last week'), 5000)] }),
    att({ type: 'environment', snapshot: { workingDirectory: '/home/dev/shop-api', platform: 'linux' } }),
    att({ type: 'date', date: '2026-10-29' }),
  ];
  
  const done = (ms) => ({ type: 'system', subtype: 'turn_duration', timestamp: ts(), durationMs: ms });
  
  const turns = [
    [
      [user(tr('로그인할 때 가끔 401 이 나요. 원인 찾아서 고쳐 줘', 'Login sometimes returns 401. Find the cause and fix it'))],
      [assistant([{ type: 'thinking', thinking: pad(tr('토큰 검증 경로부터 본다', 'Start from the token verification path'), 800) }], 300)],
      tool('Skill', { skill: 'systematic-debugging' }, 'Launching skill'),
      [user([{ type: 'text', text: pad('Base directory for this skill: /home/dev/.claude/skills/systematic-debugging\n# Debugging', 7000) }])],
      tool('Grep', { pattern: 'verifyToken', path: 'src' }, 'src/auth/token.ts\nsrc/middleware/auth.ts'),
      tool('Read', { file_path: '/home/dev/shop-api/src/auth/token.ts' }, pad('export function verifyToken(t) {', 9000)),
      tool('Read', { file_path: '/home/dev/shop-api/src/middleware/auth.ts' }, pad('app.use(auth)', 5000)),
      tool('Bash', { command: 'npm test -- auth', description: tr('인증 테스트 실행', 'Run auth tests') },
        'FAIL src/auth/token.test.ts\n  ✕ accepts token near expiry (12 ms)\n    expected 200, got 401', 500),
      tool('WebSearch', { query: 'jsonwebtoken clockTolerance expiry skew' }, pad('Result: clockTolerance option…', 4000)),
      tool('mcp__github__search_issues', { q: 'repo:dev/shop-api 401' }, pad('#212 Random 401 after deploy', 1800)),
      tool('Edit', { file_path: '/home/dev/shop-api/src/auth/token.ts', old_string: 'jwt.verify(t, key)', new_string: 'jwt.verify(t, key, { clockTolerance: 30 })' },
        'The file has been updated successfully.', 300),
      tool('Bash', { command: 'npm test -- auth', description: tr('수정 후 인증 테스트 재실행', 'Re-run auth tests after the fix') }, 'PASS src/auth/token.test.ts\n  ✓ accepts token near expiry'),
      [assistant([{ type: 'text', text: tr('원인은 서버 간 시계 차이입니다. token.ts 에서 만료 검증에 30초 여유를 주도록 고쳤습니다.\n같은 증상이 github 이슈 #212 에도 보고돼 있습니다.\n수정 후 인증 테스트가 통과합니다.', 'The cause is clock skew between servers. I changed token.ts to allow 30 seconds of tolerance on expiry.\nThe same symptom is reported in github issue #212.\nAuth tests pass after the fix.') }], 400), done(31400)],
    ],
    [
      [user(tr('주문 API 응답이 느린데 어디가 병목인지 봐 줘', 'The orders API is slow. Find the bottleneck'))],
      tool('Agent', { subagent_type: 'Explore', description: tr('주문 조회 경로 찾기', 'Find the order lookup path') }, pad('orders.service.ts → repo.findMany (N+1)', 2500)),
      tool('Read', { file_path: '/home/dev/shop-api/src/orders/orders.service.ts' }, pad('export class OrdersService {', 7000)),
      tool('Bash', { command: 'npm run bench -- orders', description: tr('주문 API 벤치마크', 'Benchmark the orders API') }, pad('GET /orders p95 840ms (queries: 51)\n[trace] SELECT * FROM order_items WHERE order_id = ?', 22000)),
      tool('Edit', { file_path: '/home/dev/shop-api/src/orders/orders.service.ts', old_string: 'for (const o of orders) await repo.items(o.id)', new_string: 'await repo.itemsFor(orders.map((o) => o.id))' },
        'The file has been updated successfully.', 300),
      tool('Bash', { command: 'npm run bench -- orders', description: tr('수정 후 벤치마크', 'Benchmark after the fix') }, 'GET /orders p95 120ms (queries: 2)'),
      [assistant([{ type: 'text', text: tr('병목은 orders.service.ts 의 주문별 품목 조회(N+1)였습니다.\n한 번에 묶어 조회하도록 바꿔 쿼리가 51개에서 2개로 줄었습니다.\np95 응답 시간은 840ms 에서 120ms 가 됐습니다.', 'The bottleneck was the per-order item lookup (N+1) in orders.service.ts.\nBatching the lookup cut queries from 51 to 2.\np95 latency went from 840ms to 120ms.') }], 400), done(24800)],
    ],
    [
      [user(tr('배포 전에 확인할 것 정리해 줘', 'List what to check before deploying'))],
      tool('Read', { file_path: '/home/dev/shop-api/deploy/release.sh' }, pad('#!/bin/sh\nset -e', 3000)),
      tool('Read', { file_path: '/home/dev/shop-api/src/auth/token.ts' }, pad('export function verifyToken(t) {', 9000)),
      tool('Bash', { command: 'git log --oneline -5', description: tr('최근 커밋 확인', 'Check recent commits') }, 'a1b2c3 fix: clockTolerance\nd4e5f6 perf: batch order items'),
      [assistant([{ type: 'text', text: tr('release.sh 는 마이그레이션 후 재시작 순서입니다.\n이번 배포에는 인증 수정과 주문 조회 개선이 들어갑니다.\n배포 전 인증 테스트와 주문 벤치마크를 한 번 더 돌려 보세요.', 'release.sh migrates first, then restarts.\nThis release ships the auth fix and the faster order lookup.\nRun the auth tests and the orders benchmark once more before deploying.') }], 300), done(9800)],
    ],
  ];
  return { boot, turns };
}

module.exports = { demoSession };
