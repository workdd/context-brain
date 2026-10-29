const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { demoSession } = require('../lib/demo');

const BIN = path.join(__dirname, '..', 'bin', 'context-brain.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cli-'));
const dir = path.join(root, '-proj');
fs.mkdirSync(dir);
const file = path.join(dir, 's.jsonl');
const { boot, turns } = demoSession(Date.parse('2026-01-01T00:00:00Z'), 'en');
fs.writeFileSync(file, [...boot, ...turns.flat(2)].map((e) => JSON.stringify(e)).join('\n') + '\n');
const env = { ...process.env, CLAUDE_PROJECTS_DIR: root, TMPDIR: root, LANG: 'C', LC_ALL: 'C' };
const run = (args, input) => execFileSync('node', [BIN, ...args], { env, input, encoding: 'utf8' });

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('doctor --json 은 진단 결과를 JSON 으로 낸다', () => {
  const r = JSON.parse(run(['doctor', 'latest', '--json']));
  expect(r.file).toBe(file);
  expect(r.turns).toBe(3);
  expect(Array.isArray(r.findings)).toBe(true);
});

test('doctor 는 사람이 읽는 보고서를 낸다', () => {
  expect(run(['doctor', file])).toMatch(/Context doctor|컨텍스트 진단/);
});

test('statusline 은 stdin 의 transcript_path 로 한 줄을 낸다', () => {
  const out = run(['statusline'], JSON.stringify({ transcript_path: file }));
  expect(out.trim().split('\n')).toHaveLength(1);
  expect(out).toMatch(/^🧠 ctx \d+k/);
});

test('export --redact 는 HTML 파일을 쓴다', () => {
  const out = path.join(root, 'o.html');
  run(['export', file, '--redact', '-o', out]);
  expect(fs.readFileSync(out, 'utf8')).toContain('id="cb-data"');
});

test('없는 세션 · 모르는 명령은 실패한다', () => {
  expect(() => run(['doctor', path.join(root, 'none.jsonl')])).toThrow();
  expect(() => run(['nope'])).toThrow();
});
