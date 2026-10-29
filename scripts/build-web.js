'use strict';
// 웹 데모를 만든다: 데모 세션을 HTML 하나로 묶어 web/index.html 에 쓴다 (Cloudflare Workers 정적 에셋으로 배포)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { demoSession } = require('../lib/demo');
const { exportSession } = require('../lib/export');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'context-brain-web-'));
const file = path.join(tmp, 'demo.jsonl');
const { boot, turns } = demoSession(Date.parse('2026-10-29T09:00:00Z'));
fs.writeFileSync(file, [...boot, ...turns.flat(2)].map((e) => JSON.stringify(e)).join('\n') + '\n');
const out = path.join(__dirname, '..', 'web', 'index.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, exportSession(file, { title: '데모: 401 버그 · 주문 API 병목 · 배포 점검', compactAt: 60000 }));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`web demo: ${out}`);
