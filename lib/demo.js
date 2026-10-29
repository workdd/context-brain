'use strict';
// 데모 세션 기록. 로그인 401 · 주문 API 병목 · 배포 점검 세 턴으로 이뤄진다.
// 첫 턴에서 읽은 큰 파일은 뒤 턴에서 다시 안 쓰여 낭비 후보가 된다

function demoSession(start = Date.now() - 10 * 60 * 1000) {
let clock = start;
  let seq = 0;
  const ts = () => new Date((clock += 4000)).toISOString();
  const att = (attachment) => ({ type: 'attachment', timestamp: ts(), attachment });
  const user = (content, extra = {}) => ({ type: 'user', timestamp: ts(), uuid: 'u' + seq++, message: { role: 'user', content }, ...extra });
  let ctx = 18000;
  const assistant = (content, grow = 600) => ({
    type: 'assistant', timestamp: ts(),
    message: { model: 'claude-demo', content, usage: { input_tokens: 2, cache_read_input_tokens: (ctx += grow), cache_creation_input_tokens: 0 } },
  });
  const tool = (name, input, result, grow) => {
    const id = 'toolu_demo_' + seq++;
    return [assistant([{ type: 'tool_use', id, name, input }], grow), user([{ type: 'tool_result', tool_use_id: id, content: result }])];
  };
  const pad = (s, n) => s + '\n' + '.'.repeat(n);
  
  // 세션 시작 시 실리는 것들
  const boot = [
    att({ type: 'prompt_snapshot', systemPrompt: [pad('You are Claude Code…', 24000)] }),
    att({ type: 'instructions', files: [
      { path: '/home/dev/.claude/CLAUDE.md', type: 'User', content: pad('# 전역 규칙\n- 커밋 메시지는 한국어', 6000) },
      { path: '/home/dev/shop-api/CLAUDE.md', type: 'Project', content: pad('# shop-api\n- 테스트: npm test', 3000) },
    ] }),
    att({ type: 'skill_listing', content: pad('- systematic-debugging: …', 9000) }),
    att({ type: 'agent_listing_delta', addedLines: [pad('- Explore: read-only search agent', 2000)] }),
    att({ type: 'mcp_instructions_delta', addedNames: ['github'], addedBlocks: [pad('## github\nIssues, PRs', 1500)] }),
    att({ type: 'hook_additional_context', content: [pad('[shop-api] recent context: 지난주 결제 모듈 리팩터링', 5000)] }),
    att({ type: 'environment', snapshot: { workingDirectory: '/home/dev/shop-api', platform: 'linux' } }),
    att({ type: 'date', date: '2026-10-29' }),
  ];
  
  const done = (ms) => ({ type: 'system', subtype: 'turn_duration', timestamp: ts(), durationMs: ms });
  
  const turns = [
    [
      [user('로그인할 때 가끔 401 이 나요. 원인 찾아서 고쳐 줘')],
      [assistant([{ type: 'thinking', thinking: pad('토큰 검증 경로부터 본다', 800) }], 300)],
      tool('Skill', { skill: 'systematic-debugging' }, 'Launching skill', 200),
      [user([{ type: 'text', text: pad('Base directory for this skill: /home/dev/.claude/skills/systematic-debugging\n# Debugging', 7000) }])],
      tool('Grep', { pattern: 'verifyToken', path: 'src' }, 'src/auth/token.ts\nsrc/middleware/auth.ts', 300),
      tool('Read', { file_path: '/home/dev/shop-api/src/auth/token.ts' }, pad('export function verifyToken(t) {', 9000), 2400),
      tool('Read', { file_path: '/home/dev/shop-api/src/middleware/auth.ts' }, pad('app.use(auth)', 5000), 1400),
      tool('Bash', { command: 'npm test -- auth', description: '인증 테스트 실행' },
        'FAIL src/auth/token.test.ts\n  ✕ accepts token near expiry (12 ms)\n    expected 200, got 401', 500),
      tool('WebSearch', { query: 'jsonwebtoken clockTolerance expiry skew' }, pad('Result: clockTolerance option…', 4000), 1100),
      tool('mcp__github__search_issues', { q: 'repo:dev/shop-api 401' }, pad('#212 Random 401 after deploy', 1800), 500),
      tool('Edit', { file_path: '/home/dev/shop-api/src/auth/token.ts', old_string: 'jwt.verify(t, key)', new_string: 'jwt.verify(t, key, { clockTolerance: 30 })' },
        'The file has been updated successfully.', 300),
      tool('Bash', { command: 'npm test -- auth', description: '수정 후 인증 테스트 재실행' }, 'PASS src/auth/token.test.ts\n  ✓ accepts token near expiry', 300),
      [assistant([{ type: 'text', text: '원인은 서버 간 시계 차이입니다. token.ts 에서 만료 검증에 30초 여유를 주도록 고쳤습니다.\n같은 증상이 github 이슈 #212 에도 보고돼 있습니다.\n수정 후 인증 테스트가 통과합니다.' }], 400), done(31400)],
    ],
    [
      [user('주문 API 응답이 느린데 어디가 병목인지 봐 줘')],
      tool('Agent', { subagent_type: 'Explore', description: '주문 조회 경로 찾기' }, pad('orders.service.ts → repo.findMany (N+1)', 2500), 700),
      tool('Read', { file_path: '/home/dev/shop-api/src/orders/orders.service.ts' }, pad('export class OrdersService {', 7000), 1800),
      tool('Bash', { command: 'npm run bench -- orders', description: '주문 API 벤치마크' }, 'GET /orders p95 840ms (queries: 51)', 400),
      tool('Edit', { file_path: '/home/dev/shop-api/src/orders/orders.service.ts', old_string: 'for (const o of orders) await repo.items(o.id)', new_string: 'await repo.itemsFor(orders.map((o) => o.id))' },
        'The file has been updated successfully.', 300),
      tool('Bash', { command: 'npm run bench -- orders', description: '수정 후 벤치마크' }, 'GET /orders p95 120ms (queries: 2)', 300),
      [assistant([{ type: 'text', text: '병목은 orders.service.ts 의 주문별 품목 조회(N+1)였습니다.\n한 번에 묶어 조회하도록 바꿔 쿼리가 51개에서 2개로 줄었습니다.\np95 응답 시간은 840ms 에서 120ms 가 됐습니다.' }], 400), done(24800)],
    ],
    [
      [user('배포 전에 확인할 것 정리해 줘')],
      tool('Read', { file_path: '/home/dev/shop-api/deploy/release.sh' }, pad('#!/bin/sh\nset -e', 3000), 900),
      tool('Bash', { command: 'git log --oneline -5', description: '최근 커밋 확인' }, 'a1b2c3 fix: clockTolerance\nd4e5f6 perf: batch order items', 200),
      [assistant([{ type: 'text', text: 'release.sh 는 마이그레이션 후 재시작 순서입니다.\n이번 배포에는 인증 수정과 주문 조회 개선이 들어갑니다.\n배포 전 인증 테스트와 주문 벤치마크를 한 번 더 돌려 보세요.' }], 300), done(9800)],
    ],
  ];
  return { boot, turns };
}

module.exports = { demoSession };
