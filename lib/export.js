'use strict';
// 세션 하나를 파일 하나짜리 HTML 로 묶는다. 서버 없이 열리고, 열면 처음부터 재생된다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createState, parseLines, LOBES } = require('./parse');

const PUBLIC = path.join(__dirname, '..', 'public');
const DROP = ['preview', 'input', 'detail', 'text'];

function parseFile(file) {
  return parseLines(fs.readFileSync(file, 'utf8').split('\n'), createState());
}

// 홈 경로는 늘 ~ 로 바꾼다. redact 면 결과 미리보기 · 명령 · 답변 본문 · 입력 문장까지 뺀다
function scrub(events, { redact = false, home = os.homedir() } = {}) {
  const tilde = (s) => (typeof s === 'string' && home ? s.split(home).join('~') : s);
  let prompts = 0;
  return events.map((e) => {
    const o = {};
    for (const [k, v] of Object.entries(e)) {
      if (redact && DROP.includes(k)) continue;
      o[k] = tilde(v);
    }
    if (redact && e.lobe === 'dialog' && e.kind === 'use') {
      o.label = e.id.startsWith('dlg:summary') ? '압축 요약' : `입력 #${++prompts}`;
    }
    return o;
  });
}

const safeJs = (js) => js.replace(/<\/script/gi, '<\\/script');

function swap(html, from, to) {
  if (!html.includes(from)) throw new Error(`index.html 에 ${from} 가 없습니다`);
  return html.replace(from, () => to);
}

// data: { title, events, compactAt, autoplay }
function buildHtml(data) {
  const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const json = JSON.stringify({ lobes: LOBES, ...data }).replace(/</g, '\\u003c');
  let html = read('index.html');
  html = swap(html, '<link rel="stylesheet" href="style.css">', `<style>\n${read('style.css')}</style>`);
  html = swap(html, '<script src="model.js"></script>', `<script>\n${safeJs(read('model.js'))}</script>`);
  html = swap(html, '<script type="module" src="app.js"></script>',
    `<script id="cb-data" type="application/json">${json}</script>\n<script type="module">\n${safeJs(read('app.js'))}</script>`);
  if (data.title) html = html.replace('<title>Context Brain</title>', () => `<title>Context Brain · ${data.title.replace(/[<&]/g, '')}</title>`);
  return html;
}

function exportSession(file, { redact = false, title = null, compactAt = null, autoplay = true } = {}) {
  return buildHtml({ title, compactAt, autoplay, events: scrub(parseFile(file), { redact }) });
}

module.exports = { parseFile, scrub, buildHtml, exportSession };
