'use strict';
// 가짜 세션으로 뷰어를 띄운다. 실제 ~/.claude 를 읽지 않으므로 설치 확인이나 캡처에 쓴다.
//   node scripts/demo.js          → 데모 세션 생성 + 한 단계씩 실시간으로 추가
//   node scripts/demo.js --static → 전체 세션을 한 번에 쓰고 끝까지 추가하지 않음

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-brain-demo-'));
const dir = path.join(root, '-home-dev-shop-api');
fs.mkdirSync(dir);
const file = path.join(dir, 'demo-session.jsonl');
process.env.CLAUDE_PROJECTS_DIR = root;

let clock = Date.now() - 10 * 60 * 1000;
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

// 한 번의 작업 흐름: 버그 신고 → 조사 → 수정 → 검증 → 답변
const steps = [
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
  tool('Agent', { subagent_type: 'Explore', description: '토큰 만료 처리 위치 찾기' }, pad('Found 3 call sites…', 2500), 700),
  tool('mcp__github__search_issues', { q: 'repo:dev/shop-api 401' }, pad('#212 Random 401 after deploy', 1800), 500),
  tool('Edit', { file_path: '/home/dev/shop-api/src/auth/token.ts', old_string: 'jwt.verify(t, key)', new_string: 'jwt.verify(t, key, { clockTolerance: 30 })' },
    'The file has been updated successfully.', 300),
  tool('Bash', { command: 'npm test -- auth', description: '수정 후 인증 테스트 재실행' }, 'PASS src/auth/token.test.ts\n  ✓ accepts token near expiry', 300),
  [assistant([{ type: 'text', text: '원인은 서버 간 시계 차이입니다. token.ts 에서 만료 검증에 30초 여유를 주도록 고쳤고, 인증 테스트가 통과합니다.' }], 400)],
];

const write = (entries) => fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const live = !process.argv.includes('--static');

write(boot);
if (!live) steps.forEach(write);

const { server } = require('../server');
const port = Number(process.env.PORT || 7788);
server.listen(port, '127.0.0.1', () => {
  console.log(`context-brain demo: http://localhost:${port}`);
  console.log(`demo session: ${file}`);
});

if (live) {
  let i = 0;
  setTimeout(function next() {
    write(steps[i]);
    i = (i + 1) % steps.length;
    setTimeout(next, i === 0 ? 6000 : 1800);
  }, 2500);
}

process.on('SIGINT', () => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); });
