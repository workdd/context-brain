const { diagnose, describe: explain, labelEn } = require('../public/model.js');

const T = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;
const prompt = (n) => ({ t: T(n), kind: 'use', lobe: 'dialog', id: 'dlg:' + n, label: 'p' + n });
const res = (id, lobe, tokens, extra = {}) => ({ kind: 'result', lobe, id, label: id, tokens, ...extra });
const use = (id, lobe) => ({ kind: 'use', lobe, id, label: id });
const find = (r, type) => r.findings.find((f) => f.type === type);

describe('diagnose', () => {
  test('같은 파일을 두 번 읽으면 큰 쪽 하나를 뺀 나머지가 중복이다', () => {
    const r = diagnose([prompt(1), use('file:a', 'files'), res('file:a', 'files', 3000), use('file:a', 'files'), res('file:a', 'files', 2000),
      res('file:small', 'files', 100), res('file:small', 'files', 100)]);
    const f = find(r, 'reread');
    expect(f.items).toEqual([{ id: 'file:a', label: 'file:a', tokens: 2000, count: 2 }]);
    expect(f.severity).toBe('mid');
  });

  test('큰 도구 결과는 10k 이상이면 높음', () => {
    const r = diagnose([prompt(1), res('sh:1', 'shell', 12000), res('sh:2', 'shell', 500)]);
    expect(find(r, 'big-output')).toMatchObject({ severity: 'high', tokens: 12000 });
  });

  test('들어와서 2턴 넘게 안 쓰인 항목은 되찾을 양에 들어가고, 압축 뒤에는 사라진다', () => {
    const ev = [prompt(1), use('file:a', 'files'), res('file:a', 'files', 2000), prompt(2), prompt(3)];
    const r = diagnose(ev);
    expect(find(r, 'dead-weight').items[0]).toMatchObject({ id: 'file:a', count: 2 });
    expect(r.reclaim).toBe(2000);
    expect(find(diagnose([...ev, { kind: 'compact', tokens: 1 }]), 'dead-weight')).toBeUndefined();
  });

  test('안 부른 MCP 서버 · 안 쓴 스키마를 잡는다', () => {
    const r = diagnose([
      { kind: 'load', lobe: 'abilities', id: 'abil:mcp:github', label: 'github 안내', tokens: 800 },
      { kind: 'load', lobe: 'abilities', id: 'abil:mcp:slack', label: 'slack 안내', tokens: 900 },
      { kind: 'load', lobe: 'abilities', id: 'tool:Foo', label: 'Foo', tokens: 300 },
      prompt(1), use('mcp:github', 'mcp'),
    ]);
    expect(find(r, 'unused-mcp').items.map((i) => i.id)).toEqual(['abil:mcp:slack']);
    expect(find(r, 'unused-schema').items.map((i) => i.id)).toEqual(['tool:Foo']);
    expect(r.reclaim).toBe(1200);
  });

  test('실패 3회 이상 · 고정 비용 · 압축 직전', () => {
    const r = diagnose([
      { kind: 'load', lobe: 'rules', id: 'rule:a', label: 'CLAUDE.md', tokens: 16000 },
      prompt(1), ...[1, 2, 3].map(() => res('sh:x', 'shell', 10, { error: true })),
      { kind: 'usage', tokens: 90000 },
    ], { compactAt: 100000 });
    expect(find(r, 'errors').items[0].count).toBe(3);
    expect(find(r, 'standing').tokens).toBe(16000);
    expect(find(r, 'near-compact')).toMatchObject({ severity: 'high', tokens: 10000 });
    expect(r.findings[0].severity).toBe('high');
    expect(r.context).toBe(90000);
    expect(r.turns).toBe(1);
  });

  test('문제가 없으면 진단이 비어 있다', () => {
    expect(diagnose([prompt(1)]).findings).toEqual([]);
  });
});

describe('describe', () => {
  test('모든 진단 종류에 한국어 · 영어 문장이 있다', () => {
    const types = ['reread', 'big-output', 'dead-weight', 'unused-mcp', 'unused-schema', 'errors', 'standing', 'near-compact'];
    for (const type of types) {
      const f = { type, tokens: 1500, ratio: 0.9, items: [{ label: 'x', count: 1, tokens: 1 }] };
      const ko = explain(f, (k) => k);
      const en = explain(f, (k, e) => e);
      expect(ko.title).toMatch(/[가-힣]/);
      expect(en.title + en.fix).not.toMatch(/[가-힣]/);
      expect(en.fix.length).toBeGreaterThan(10);
    }
    expect(explain({ type: 'other', items: [] }, (k) => k).title).toBe('other');
  });
});

describe('labelEn', () => {
  test('파서의 고정 이름만 영어로 바꾼다', () => {
    expect(labelEn('abil:skills', '스킬 목록')).toBe('Skill list');
    expect(labelEn('abil:mcp:github', 'github 안내')).toBe('github instructions');
    expect(labelEn('dlg:summary:1', '압축 요약')).toBe('Compaction summary');
    expect(labelEn('dlg:1', '입력 #3')).toBe('Prompt #3');
    expect(labelEn('dlg:2', '(입력)')).toBe('(prompt)');
    expect(labelEn('file:a', 'src/a.ts')).toBe('src/a.ts');
    expect(labelEn(null, 'x')).toBe('x');
  });
});
