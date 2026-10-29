const { squarify, splitSentences, needlesOf, findRefs, wasteCandidates } = require('../public/model');

describe('squarify', () => {
  test('면적은 값에 비례하고 사각형 안에 들어간다', () => {
    const items = [{ value: 6 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 2 }, { value: 1 }];
    const out = squarify(items, 0, 0, 600, 400);
    expect(out).toHaveLength(7);
    const total = 24;
    for (const r of out) {
      expect(r.w * r.h).toBeCloseTo((r.item.value / total) * 600 * 400, 3);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });
  test('세로가 긴 사각형도 채운다', () => {
    const out = squarify([{ value: 1 }, { value: 1 }], 0, 0, 100, 300);
    expect(out.reduce((s, r) => s + r.w * r.h, 0)).toBeCloseTo(30000, 3);
  });
  test('0 이하 값, 빈 목록, 넓이 0은 빈 결과', () => {
    expect(squarify([{ value: 0 }, { value: -1 }], 0, 0, 10, 10)).toEqual([]);
    expect(squarify([], 0, 0, 10, 10)).toEqual([]);
    expect(squarify([{ value: 1 }], 0, 0, 0, 10)).toEqual([]);
  });
});

describe('문장과 근거', () => {
  test('splitSentences 는 코드 블록, 표 구분선, 마크다운 기호를 걷어 낸다', () => {
    const text = '원인은 시계 차이입니다. token.ts 를 고쳤습니다!\n\n```js\ncode()\n```\n| a | b |\n|---|---|\n- **굵게** 항목';
    expect(splitSentences(text)).toEqual(['원인은 시계 차이입니다.', 'token.ts 를 고쳤습니다!', 'a | b |', '굵게 항목']);
    expect(splitSentences(null)).toEqual([]);
  });
  test('needlesOf 는 종류별로 본문에 나올 이름을 뽑는다', () => {
    expect(needlesOf('file:/a/src/token.ts')).toEqual(['token.ts']);
    expect(needlesOf('skill:superpowers:brainstorming')).toEqual(['superpowers:brainstorming', 'brainstorming']);
    expect(needlesOf('web:search')).toEqual([]);
    expect(needlesOf('web:example.com')).toEqual(['example.com']);
    expect(needlesOf('mcp:github')).toEqual(['github']);
    expect(needlesOf('agent:Explore')).toEqual(['Explore']);
    expect(needlesOf('sh:toolu_1')).toEqual([]);
    expect(needlesOf('file:/a/b.c')).toEqual([]); // 4글자 미만은 오탐이 많아 뺀다
  });
  test('findRefs 는 이름이 그대로 나온 후보만 돌려준다', () => {
    const c = [{ id: 'file:/r/token.ts' }, { id: 'file:/r/auth.ts' }, { id: 'mcp:github' }];
    expect(findRefs('token.ts 에서 고쳤고 github 이슈와 같습니다', c)).toEqual(['file:/r/token.ts', 'mcp:github']);
  });
});

describe('wasteCandidates', () => {
  const n = (id, lobe, tokens, lastTurn, compacted = false) => ({ id, lobe, tokens, lastTurn, compacted });
  test('크고 오래 안 쓰인 항목만, 큰 순서로', () => {
    const list = [
      n('a', 'files', 5000, 1), n('b', 'files', 9000, 2), n('c', 'files', 9000, 4),
      n('d', 'rules', 9000, 1), n('e', 'files', 100, 1), n('f', 'shell', 3000, 1, true), n('g', 'web', 2000, 0),
    ];
    expect(wasteCandidates(list, 4).map((x) => x.id)).toEqual(['b', 'a']);
    expect(wasteCandidates(list, 4, { minTokens: 6000, idleTurns: 1 }).map((x) => x.id)).toEqual(['b']);
  });
});
