#!/usr/bin/env node
'use strict';
// context-brain              뷰어 서버를 띄우고 브라우저를 연다
// context-brain demo         가짜 세션으로 띄운다 (Claude Code 없이 확인)
// context-brain export [세션.jsonl|latest] [-o 파일.html] [--redact]

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (value('--port')) process.env.PORT = value('--port');
const noOpen = flag('--no-open');
const ko = Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ko');
const L = (k, e) => (ko ? k : e);

const HELP = L(`context-brain: Claude Code 컨텍스트를 3D 뇌로 보는 로컬 뷰어

  context-brain                      뷰어 실행 (http://localhost:7788) 후 브라우저 열기
  context-brain demo                 가짜 세션으로 실행
  context-brain export [세션|latest]  세션을 HTML 파일 하나로 저장 (서버 없이 열리고 자동 재생)
      -o <파일>                       저장 경로 (기본: context-brain-<세션>.html)
      --redact                       결과 미리보기 · 명령 · 입력 · 답변 본문을 빼고 저장

  --port <번호>   포트 (차 있으면 다음 번호)
  --no-open       브라우저를 열지 않음`, `context-brain: a live 3D brain of your Claude Code session context

  context-brain                         start the viewer (http://localhost:7788) and open the browser
  context-brain demo                    start with a sample session
  context-brain export [file|latest]    save a session as one HTML file (opens without a server, replays itself)
      -o <file>                         output path (default: context-brain-<session>.html)
      --redact                          leave out tool output, commands, prompts and answer text

  --port <n>      port (falls through to the next free one)
  --no-open       do not open the browser`);

const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';

if (flag('-h') || flag('--help') || cmd === 'help') {
  console.log(HELP);
} else if (cmd === 'demo') {
  if (!noOpen) process.env.CB_OPEN = '1';
  require('../scripts/demo.js');
} else if (cmd === 'export') {
  const { listSessions, observedCompactAt, sessionTitle } = require('../lib/sessions');
  const { exportSession } = require('../lib/export');
  const arg = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'latest';
  const file = arg === 'latest' ? (listSessions(undefined, 1)[0] || {}).file : path.resolve(arg);
  if (!file || !fs.existsSync(file)) {
    console.error(L(`세션을 찾지 못했습니다: ${arg}`, `session not found: ${arg}`));
    process.exit(1);
  }
  const redact = flag('--redact');
  const out = value('-o') || `context-brain-${path.basename(file, '.jsonl').slice(0, 8)}${redact ? '-redacted' : ''}.html`;
  const { compactAt } = observedCompactAt(listSessions(undefined, 40).map((s) => s.file));
  fs.writeFileSync(out, exportSession(file, { redact, title: sessionTitle(file), compactAt }));
  console.log(`${L('저장', 'saved')}: ${path.resolve(out)} (${Math.round(fs.statSync(out).size / 1024)} KB${redact ? L(', 내용 가림', ', redacted') : ''})`);
  if (!redact) console.log(L('주의: 파일 내용 미리보기 · 명령 · 답변 본문이 들어 있습니다. 남에게 줄 때는 --redact 를 쓰세요.', 'note: this file contains output previews, commands and answer text. Use --redact before sharing it.'));
} else if (cmd === 'start') {
  require('../server').listen().then((port) => {
    const url = `http://localhost:${port}`;
    console.log(`context-brain: ${url}`);
    if (!noOpen) require('../lib/open')(url);
  });
} else {
  console.error(`${L('모르는 명령', 'unknown command')}: ${cmd}\n\n${HELP}`);
  process.exit(1);
}
