#!/usr/bin/env node
'use strict';
// context-brain              뷰어 서버를 띄우고 브라우저를 연다
// context-brain demo         가짜 세션으로 띄운다 (Claude Code 없이 확인)
// context-brain export [세션.jsonl|latest] [-o 파일.html] [--redact]
// context-brain doctor [세션.jsonl|latest] [--json]   토큰이 새는 곳과 줄이는 법
// context-brain statusline    Claude Code 상태줄용 한 줄 (stdin 의 transcript_path 를 읽음)

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
  context-brain doctor [세션|latest]  토큰이 새는 곳과 줄이는 법을 터미널에 출력 (--json)
  context-brain statusline           Claude Code 상태줄에 컨텍스트 · 되찾을 양 표시

  --port <번호>   포트 (차 있으면 다음 번호)
  --no-open       브라우저를 열지 않음`, `context-brain: a live 3D brain of your Claude Code session context

  context-brain                         start the viewer (http://localhost:7788) and open the browser
  context-brain demo                    start with a sample session
  context-brain export [file|latest]    save a session as one HTML file (opens without a server, replays itself)
      -o <file>                         output path (default: context-brain-<session>.html)
      --redact                          leave out tool output, commands, prompts and answer text
  context-brain doctor [file|latest]    print where tokens leak and how to cut them (--json)
  context-brain statusline              one line for the Claude Code status line (context · reclaimable)

  --port <n>      port (falls through to the next free one)
  --no-open       do not open the browser`);

const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';

if (flag('-h') || flag('--help') || cmd === 'help') {
  console.log(HELP);
} else if (cmd === 'demo') {
  if (!noOpen) process.env.CB_OPEN = '1';
  require('../scripts/demo.js');
} else if (cmd === 'doctor') {
  const { file, compactAt, title } = findSession();
  const { parseFile } = require('../lib/export');
  const { diagnose, describe, labelEn } = require('../public/model.js');
  const report = diagnose(parseFile(file), { compactAt });
  if (!ko) for (const f of report.findings) for (const i of f.items) i.label = labelEn(i.id, i.label);
  if (flag('--json')) console.log(JSON.stringify({ file, title, ...report }, null, 2));
  else printReport(report, title || path.basename(file), describe);
} else if (cmd === 'statusline') {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    let file = null;
    try { file = JSON.parse(input).transcript_path; } catch (_) { /* 입력이 없으면 최근 세션 */ }
    if (!file) file = (require('../lib/sessions').listSessions(undefined, 1)[0] || {}).file;
    console.log(file && fs.existsSync(file) ? statusLine(file) : 'context-brain: -');
  });
} else if (cmd === 'export') {
  const { file, compactAt, title } = findSession();
  const { exportSession } = require('../lib/export');
  const redact = flag('--redact');
  const out = value('-o') || `context-brain-${path.basename(file, '.jsonl').slice(0, 8)}${redact ? '-redacted' : ''}.html`;
  fs.writeFileSync(out, exportSession(file, { redact, title, compactAt }));
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

function findSession() {
  const { listSessions, observedCompactAt, sessionTitle } = require('../lib/sessions');
  const arg = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'latest';
  const file = arg === 'latest' ? (listSessions(undefined, 1)[0] || {}).file : path.resolve(arg);
  if (!file || !fs.existsSync(file)) {
    console.error(L(`세션을 찾지 못했습니다: ${arg}`, `session not found: ${arg}`));
    process.exit(1);
  }
  const { compactAt } = observedCompactAt(listSessions(undefined, 40).map((s) => s.file));
  return { file, compactAt, title: sessionTitle(file) };
}

function printReport(r, title, describe) {
  const tty = process.stdout.isTTY;
  const c = (code, t) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n || 0)));
  const tag = { high: c('31;1', L('높음', 'HIGH')), mid: c('33;1', L('중간', 'MID ')), low: c('36', L('낮음', 'LOW '))};
  console.log(c('1', L(`컨텍스트 진단 · ${title}`, `Context doctor · ${title}`)));
  const ctx = r.context == null ? '-' : k(r.context);
  const pct = r.compactAt && r.context ? ` (${Math.round((r.context / r.compactAt) * 100)}%)` : '';
  console.log(L(`컨텍스트 ${ctx}${r.compactAt ? ` / 압축 기준 ${k(r.compactAt)}${pct}` : ''} · 턴 ${r.turns}`,
    `context ${ctx}${r.compactAt ? ` / compacts at ${k(r.compactAt)}${pct}` : ''} · ${r.turns} turns`));
  console.log(c('32;1', L(`지금 되찾을 수 있는 양 약 ${k(r.reclaim)} 토큰`, `reclaimable now: ~${k(r.reclaim)} tokens`)));
  if (!r.findings.length) console.log(L('\n문제 없음.', '\nNothing to fix.'));
  for (const f of r.findings) {
    const d = describe(f, L);
    console.log(`\n${tag[f.severity]}  ${c('1', d.title)}`);
    console.log(`      ${c('2', d.fix)}`);
    for (const i of f.items.slice(0, 5)) {
      const n = i.count > 1 ? (f.type === 'dead-weight' ? L(` · ${i.count}턴째 안 씀`, ` · idle ${i.count} turns`) : ` ×${i.count}`) : '';
      console.log(`      - ${i.label}  ${c('2', k(i.tokens) + n)}`);
    }
    if (f.items.length > 5) console.log(c('2', L(`      외 ${f.items.length - 5}개`, `      +${f.items.length - 5} more`)));
  }
}

// 상태줄은 자주 불리므로 압축 기준은 10분 동안 임시 파일에 담아 둔다
function cachedCompactAt() {
  const os = require('os');
  const cache = path.join(os.tmpdir(), 'context-brain-compact-at.json');
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (Date.now() - c.at < 10 * 60 * 1000) return c.compactAt;
  } catch (_) { /* 처음이거나 깨졌으면 다시 센다 */ }
  const { listSessions, observedCompactAt } = require('../lib/sessions');
  const { compactAt } = observedCompactAt(listSessions(undefined, 40).map((s) => s.file));
  try { fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), compactAt })); } catch (_) { /* 캐시 없이 진행 */ }
  return compactAt;
}

function statusLine(file) {
  const { parseFile } = require('../lib/export');
  const { diagnose } = require('../public/model.js');
  const r = diagnose(parseFile(file), { compactAt: cachedCompactAt() });
  const k = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n || 0)));
  const parts = [`ctx ${r.context == null ? '-' : k(r.context)}${r.compactAt && r.context ? ` (${Math.round((r.context / r.compactAt) * 100)}%)` : ''}`];
  if (r.reclaim) parts.push(L(`되찾을 양 ${k(r.reclaim)}`, `reclaim ${k(r.reclaim)}`));
  const high = r.findings.filter((f) => f.severity === 'high').length;
  if (high) parts.push(L(`진단 높음 ${high}`, `${high} high`));
  return '🧠 ' + parts.join(' · ');
}
