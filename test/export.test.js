const fs = require('fs');
const os = require('os');
const path = require('path');
const { scrub, buildHtml, exportSession, parseFile } = require('../lib/export');
const { demoSession } = require('../lib/demo');
const { sessionTitle } = require('../lib/sessions');

function demoFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-export-'));
  const file = path.join(dir, 's.jsonl');
  const { boot, turns } = demoSession(Date.parse('2026-01-01T00:00:00Z'));
  const lines = [...boot, ...turns.flat(2), { type: 'ai-title', aiTitle: '데모 제목' }];
  fs.writeFileSync(file, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const dataOf = (html) => JSON.parse(html.match(/<script id="cb-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);

describe('scrub', () => {
  const ev = [
    { kind: 'use', lobe: 'files', id: '/home/me/a.ts', label: '/home/me/a.ts', preview: 'secret', input: 'cmd' },
    { kind: 'use', lobe: 'dialog', id: 'dlg:1', label: '비밀 프롬프트' },
    { kind: 'use', lobe: 'dialog', id: 'dlg:summary:1', label: '요약 원문' },
    { kind: 'use', lobe: 'output', id: 'out:answer', text: '답변 본문' },
  ];
  test('홈 경로는 늘 ~ 로 바꾸고 내용은 남긴다', () => {
    const out = scrub(ev, { home: '/home/me' });
    expect(out[0].id).toBe('~/a.ts');
    expect(out[0].preview).toBe('secret');
    expect(out[1].label).toBe('비밀 프롬프트');
  });
  test('redact 는 미리보기 · 명령 · 본문 · 입력 문장을 뺀다', () => {
    const out = scrub(ev, { home: '/home/me', redact: true });
    expect(out[0]).not.toHaveProperty('preview');
    expect(out[0]).not.toHaveProperty('input');
    expect(out[1].label).toBe('입력 #1');
    expect(out[2].label).toBe('압축 요약');
    expect(out[3]).not.toHaveProperty('text');
    expect(ev[0].preview).toBe('secret'); // 원본은 그대로
  });
});

describe('buildHtml', () => {
  test('스타일 · 스크립트 · 기록을 한 파일에 넣는다', () => {
    const html = buildHtml({ title: 'T<x>', events: [{ kind: 'use', label: '</script><b>' }], autoplay: true });
    expect(html).not.toContain('href="style.css"');
    expect(html).not.toContain('src="app.js"');
    expect(html).toContain('<title>Context Brain · Tx></title>');
    const d = dataOf(html);
    expect(d.events[0].label).toBe('</script><b>');
    expect(d.lobes.files).toBeTruthy();
    expect(d.autoplay).toBe(true);
  });
});

describe('exportSession', () => {
  test('데모 세션을 묶으면 세 턴 기록과 제목이 들어간다', () => {
    const file = demoFile();
    expect(sessionTitle(file)).toBe('데모 제목');
    expect(sessionTitle(file + '.none')).toBeNull();
    const d = dataOf(exportSession(file, { title: sessionTitle(file), compactAt: 60000 }));
    expect(d.events.length).toBe(parseFile(file).length);
    expect(d.events.filter((e) => e.kind === 'turn_end')).toHaveLength(3);
    expect(d.compactAt).toBe(60000);
    const r = dataOf(exportSession(file, { redact: true }));
    expect(r.events.some((e) => e.text || e.preview)).toBe(false);
    expect(r.events.some((e) => e.kind === 'ref')).toBe(true); // 근거는 언급 기록으로 남는다
  });
});

describe('server listen', () => {
  test('포트가 차 있으면 다음 번호로 연다', async () => {
    const net = require('net');
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    const { server, listen } = require('../server');
    const port = await listen(busy, 5);
    expect(port).toBeGreaterThan(busy);
    await new Promise((r) => server.close(r));
    await new Promise((r) => blocker.close(r));
  });
});
