'use strict';
// 웹 데모를 만든다: 데모 세션을 HTML 하나로 묶어 web/index.html 에 쓴다 (Cloudflare Workers 정적 에셋으로 배포)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { demoSession } = require('../lib/demo');
const { buildHtml, parseFile } = require('../lib/export');

// 한국어 · 영어 데모를 함께 넣고 화면 언어에 맞는 쪽을 재생한다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'context-brain-web-'));
const variants = {};
for (const lang of ['ko', 'en']) {
  const file = path.join(tmp, `demo-${lang}.jsonl`);
  const { boot, turns } = demoSession(Date.parse('2026-10-29T09:00:00Z'), lang);
  fs.writeFileSync(file, [...boot, ...turns.flat(2)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  variants[lang] = parseFile(file);
}
fs.rmSync(tmp, { recursive: true, force: true });
const titles = { ko: '데모: 401 버그 · 주문 API 병목 · 배포 점검', en: 'Demo: 401 bug · slow orders API · release check' };
const out = path.join(__dirname, '..', 'web', 'index.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildHtml({ title: 'Live demo', titles, compactAt: 60000, autoplay: true, events: variants.en, variants }));
console.log(`web demo: ${out}`);
