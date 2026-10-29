const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tailer } = require('../lib/tail');
const { listSessions, isAllowed, observedCompactAt } = require('../lib/sessions');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('Tailer', () => {
  test('완성된 줄만 내보내고 덜 쓴 줄은 다음 읽기로 넘긴다', () => {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, 'a\nb');
    const t = new Tailer(f, () => {});
    expect(t.readNew()).toEqual(['a']);
    fs.appendFileSync(f, 'c\nd\n');
    expect(t.readNew()).toEqual(['bc', 'd']);
    expect(t.readNew()).toEqual([]);
  });

  test('파일이 줄어들면 처음부터 다시 읽는다', () => {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, 'long line here\n');
    const t = new Tailer(f, () => {});
    t.readNew();
    fs.writeFileSync(f, 'x\n');
    expect(t.readNew()).toEqual(['x']);
  });

  test('없는 파일은 빈 배열', () => {
    expect(new Tailer(path.join(dir, 'none'), () => {}).readNew()).toEqual([]);
  });

  test('start 는 새 줄을 콜백으로 넘기고 stop 으로 멈춘다', async () => {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, 'a\n');
    const got = [];
    const t = new Tailer(f, (l) => got.push(...l), { intervalMs: 20 }).start();
    fs.appendFileSync(f, 'b\n');
    await new Promise((r) => setTimeout(r, 80));
    t.stop();
    expect(got).toEqual(['a', 'b']);
    expect(t.timer).toBeNull();
  });
});

describe('sessions', () => {
  test('최근 수정 순으로, 제목과 함께, 관찰 세션은 빼고 나열한다', () => {
    const p = path.join(dir, '-Users-a-proj');
    const obs = path.join(dir, '-Users-a--claude-mem-observer-sessions');
    fs.mkdirSync(p);
    fs.mkdirSync(obs);
    fs.writeFileSync(path.join(obs, 'o.jsonl'), '{}\n');
    fs.writeFileSync(path.join(p, 'old.jsonl'), '{}\n');
    fs.writeFileSync(path.join(p, 'new.jsonl'), '{"type":"ai-title","aiTitle":"제목"}\n');
    fs.writeFileSync(path.join(p, 'note.txt'), '');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(p, 'old.jsonl'), past, past);
    const list = listSessions(dir);
    expect(list.map((s) => path.basename(s.file))).toEqual(['new.jsonl', 'old.jsonl']);
    expect(list[0].title).toBe('제목');
    expect(list[1].title).toBeNull();
  });

  test('없는 폴더는 빈 목록', () => {
    expect(listSessions(path.join(dir, 'none'))).toEqual([]);
  });

  test('isAllowed 는 projects 밖 경로와 jsonl 이 아닌 파일을 막는다', () => {
    expect(isAllowed(path.join(dir, 'p', 'a.jsonl'), dir)).toBe(true);
    expect(isAllowed(path.join(dir, '..', 'etc', 'a.jsonl'), dir)).toBe(false);
    expect(isAllowed(path.join(dir, 'p', 'a.json'), dir)).toBe(false);
  });
});

describe('observedCompactAt', () => {
  test('자동 압축만 모델별로 모은다 (수동 /compact 는 뺀다)', () => {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    const asst = (model) => JSON.stringify({ type: 'assistant', message: { model, usage: {} } });
    const cmp = (trigger, pre) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger, preTokens: pre } });
    fs.writeFileSync(a, [asst('claude-x'), cmp('auto', 1200), asst('claude-y'), cmp('auto', 5000), cmp('manual', 9000)].join('\n') + '\n');
    fs.writeFileSync(b, [asst('claude-x'), cmp('auto', 1400), cmp('auto', 0)].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'c.jsonl'), cmp('auto', 700) + '\n');
    expect(observedCompactAt([a, b, path.join(dir, 'c.jsonl'), path.join(dir, 'none')])).toEqual({
      byModel: { 'claude-x': { n: 2, min: 1200, max: 1400, median: 1400 }, 'claude-y': { n: 1, min: 5000, max: 5000, median: 5000 }, '?': { n: 1, min: 700, max: 700, median: 700 } },
      samples: 4,
    });
    expect(observedCompactAt([])).toEqual({ byModel: {}, samples: 0 });
  });
});
