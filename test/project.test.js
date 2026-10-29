const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectReport, describeProject, shellProgramOf, describe: explain, labelEn } = require('../public/model.js');
const { projectSessions } = require('../lib/project');

const prompt = (n) => ({ kind: 'use', lobe: 'dialog', id: 'dlg:' + n, label: 'p' + n });
const mcpLoad = (server) => ({ kind: 'load', lobe: 'abilities', id: 'abil:mcp:' + server, label: server + ' 안내', tokens: 900 });
const rule = { kind: 'load', lobe: 'rules', id: 'rule:/r/CLAUDE.md', label: 'CLAUDE.md', tokens: 25000 };
const sh = (id, cmd, tokens) => [{ kind: 'use', lobe: 'shell', id, label: 'x', input: cmd }, { kind: 'result', lobe: 'shell', id, label: 'x', tokens }];
const read = (file, tokens) => ({ kind: 'result', lobe: 'files', id: 'file:' + file, label: file, tokens });

function session(i, extra) {
  return { file: `/p/s${i}.jsonl`, title: 's' + i, mtime: i, events: [rule, mcpLoad('slack'), mcpLoad('github'), prompt(1), ...extra,
    { kind: 'usage', tokens: 1000 * (i + 1) }] };
}

describe('projectReport', () => {
  const sessions = [
    session(0, [{ kind: 'use', lobe: 'mcp', id: 'mcp:github', label: 'github' }, ...sh('sh:a', 'npm test', 4000), read('src/app.ts', 2000)]),
    session(1, [...sh('sh:b', 'cd x && NODE_ENV=1 npm test -- -u', 5000), read('src/app.ts', 2000), ...sh('sh:c', 'sed -n 1,400p big.ts', 9000)]),
    session(2, [...sh('sh:d', 'npm run test', 6000), read('src/app.ts', 2000), { kind: 'compact', tokens: 1 },
      ...sh('sh:e', 'sed -n 1,400p big.ts', 9000), ...sh('sh:f', 'sed -n 1,400p big.ts', 9000)]),
  ];
  const r = projectReport(sessions, { compactAt: 100000 });
  const find = (t) => r.findings.find((f) => f.type === t);

  test('여러 세션에 실렸는데 안 부른 MCP 서버만 높음으로 잡는다', () => {
    const f = find('p-unused-mcp');
    expect(f.severity).toBe('high');
    expect(f.items.map((i) => i.id)).toEqual(['abil:mcp:slack']);
    expect(f.items[0].count).toBe(3);
  });

  test('세션마다 다시 읽는 파일', () => {
    expect(find('p-hot-files').items[0]).toMatchObject({ id: 'file:src/app.ts', count: 3, reads: 3, tokens: 6000 });
  });

  test('출력이 큰 명령은 프로그램 단위로 묶고 파일 읽기 명령은 뺀다', () => {
    const f = find('p-loud-shell');
    expect(f.items.map((i) => i.label)).toEqual(['npm']);
    expect(f.items[0]).toMatchObject({ count: 3, avg: 5000 });
  });

  test('고정 비용 · 세션 표 · 합계', () => {
    expect(find('p-fixed')).toMatchObject({ severity: 'mid', tokens: 25000 + 1800 });
    expect(r.rows.map((x) => x.context)).toEqual([1000, 2000, 3000]);
    expect(r.rows[2].compactions).toBe(1);
    expect(r).toMatchObject({ sessions: 3, turns: 3, compactions: 1, medianContext: 2000 });
  });

  test('모든 진단 종류에 한국어 · 영어 문장이 있다', () => {
    for (const f of r.findings) {
      expect(describeProject(f, (k) => k).title).toMatch(/[가-힣]/);
      const en = { ...f, items: f.items.map((i) => ({ ...i, label: labelEn(i.id, i.label) })) };
      expect(describeProject(en, (k, e) => e).fix).not.toMatch(/[가-힣]/);
    }
    expect(describeProject({ type: 'x', items: [] }, (k) => k).title).toBe('x');
    expect(explain({ type: 'big-output', tokens: 1, items: [{ label: 'a' }] }, (k, e) => e).title).toMatch(/^1 oversized tool result ·/);
  });

  test('빈 프로젝트', () => {
    expect(projectReport([])).toMatchObject({ sessions: 0, findings: [], medianContext: null });
  });
});

test('shellProgramOf', () => {
  expect(shellProgramOf('cd a && FOO=1 /usr/bin/python3 x.py')).toBe('python3');
  expect(shellProgramOf('(npm test)')).toBe('npm');
  expect(shellProgramOf('./run.sh')).toBe('?');
  expect(shellProgramOf(null)).toBe('?');
  expect(shellProgramOf('cd x && export A=1; sudo git status')).toBe('git');
  expect(shellProgramOf('cd x')).toBe('?');
});

test('projectSessions 는 같은 폴더의 최근 세션을 읽고 바뀌지 않은 파일은 다시 읽지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-proj-'));
  const line = JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n';
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, n + '.jsonl'), line);
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  const first = projectSessions(path.join(dir, 'a.jsonl'), 2);
  expect(first).toHaveLength(2);
  const again = projectSessions(path.join(dir, 'a.jsonl'), 2);
  expect(again[0].events).toBe(first[0].events);
});
