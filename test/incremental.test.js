const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseIncremental } = require('../lib/incremental');
const { parseFile } = require('../lib/export');
const { demoSession } = require('../lib/demo');

test('이어 읽기는 한 번에 읽은 결과와 같고, 덜 쓴 줄 · 줄어든 파일을 처리한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-inc-'));
  const file = path.join(dir, 's.jsonl');
  const cache = path.join(dir, 'cache');
  const { boot, turns } = demoSession(Date.parse('2026-01-01T00:00:00Z'), 'en');
  const lines = [...boot, ...turns.flat(2)].map((e) => JSON.stringify(e));
  const half = Math.floor(lines.length / 2);
  // 앞 절반 + 다음 줄의 앞부분만 (덜 쓴 줄)
  fs.writeFileSync(file, lines.slice(0, half).join('\n') + '\n' + lines[half].slice(0, 20));
  const first = parseIncremental(file, cache);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const all = parseIncremental(file, cache);
  const keep = (e) => ({ kind: e.kind, id: e.id, tokens: e.tokens });
  expect(all.map(keep)).toEqual(parseFile(file).map(keep));
  expect(all.length).toBeGreaterThan(first.length);
  expect(all.some((e) => e.kind === 'result' && e.id.startsWith('file:'))).toBe(true); // 경계를 넘은 tool_use → result 짝
  expect(all[0]).not.toHaveProperty('preview');
  expect(parseIncremental(file, cache)).toHaveLength(all.length); // 바뀐 게 없으면 그대로
  fs.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');  // 줄어들면 처음부터
  expect(parseIncremental(file, cache).map(keep)).toEqual(parseFile(file).map(keep));
});
