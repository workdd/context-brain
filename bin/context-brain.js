#!/usr/bin/env node
'use strict';
// context-brain              뷰어 서버를 띄우고 브라우저를 연다
// context-brain demo         가짜 세션으로 띄운다 (Claude Code 없이 확인)
// context-brain export [세션.jsonl|latest] [-o 파일.html] [--redact]
// context-brain doctor [세션.jsonl|latest] [--json]   토큰이 새는 곳과 줄이는 법
// context-brain statusline    Claude Code 상태줄용 한 줄 (stdin 의 transcript_path 를 읽음)
// context-brain calibrate     내 세션 실측 사용량으로 토큰 추정 계수를 맞춰 저장

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
      --project [--limit 20]         그 세션의 프로젝트에서 최근 세션들을 모아 반복 패턴 진단
  context-brain statusline           Claude Code 상태줄에 컨텍스트 · 되찾을 양 표시
  context-brain calibrate            내 세션 실측 사용량으로 토큰 추정 계수를 맞춰 저장

  --port <번호>   포트 (차 있으면 다음 번호)
  --no-open       브라우저를 열지 않음`, `context-brain: a live 3D brain of your Claude Code session context

  context-brain                         start the viewer (http://localhost:7788) and open the browser
  context-brain demo                    start with a sample session
  context-brain export [file|latest]    save a session as one HTML file (opens without a server, replays itself)
      -o <file>                         output path (default: context-brain-<session>.html)
      --redact                          leave out tool output, commands, prompts and answer text
  context-brain doctor [file|latest]    print where tokens leak and how to cut them (--json)
      --project [--limit 20]            look across the project's recent sessions for repeated leaks
  context-brain statusline              one line for the Claude Code status line (context · reclaimable)
  context-brain calibrate               fit token estimates to your own sessions' measured usage and save them

  --port <n>      port (falls through to the next free one)
  --no-open       do not open the browser`);

const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';

if (flag('-h') || flag('--help') || cmd === 'help') {
  console.log(HELP);
} else if (cmd === 'demo') {
  if (!noOpen) process.env.CB_OPEN = '1';
  require('../scripts/demo.js');
} else if (cmd === 'doctor' && flag('--project')) {
  const { file, byModel } = findSession();
  const { projectSessions } = require('../lib/project');
  const { projectReport, describeProject, labelEn } = require('../public/model.js');
  const report = projectReport(projectSessions(file, Number(value('--limit')) || 20), { byModel });
  if (!ko) for (const f of report.findings) for (const i of f.items) i.label = labelEn(i.id, i.label);
  if (flag('--json')) console.log(JSON.stringify({ project: path.basename(path.dirname(file)), ...report }, null, 2));
  else printProject(report, path.basename(path.dirname(file)), describeProject);
} else if (cmd === 'doctor') {
  const { file, byModel, title } = findSession();
  const { parseFile } = require('../lib/export');
  const { diagnose, describe, labelEn, pickCompact, lastModel } = require('../public/model.js');
  const events = parseFile(file);
  const report = diagnose(events, { compactAt: pickCompact(byModel, lastModel(events)).at });
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
} else if (cmd === 'calibrate') {
  const { calibrate, save, listSessions } = require('../lib/calibrate');
  const r = calibrate(listSessions(undefined, 1000).map((x) => x.file));
  if (!r.coef) {
    console.error(L(`표본이 부족합니다 (${r.samples}개, 30개 이상 필요). 세션이 더 쌓인 뒤 다시 실행하세요.`,
      `not enough samples (${r.samples}, need 30+). Run again after more sessions.`));
    process.exit(1);
  }
  const pct = (v) => Math.round(v * 100) + '%';
  console.log(L(`표본 ${r.samples}개 (두 응답 사이에 도구 결과 하나만 들어온 구간)`, `${r.samples} samples (one tool result between two responses)`));
  console.log(L(`ASCII ${(1 / r.coef.ascii).toFixed(2)}자/토큰 · 한글 ${r.coef.hangul.toFixed(2)}토큰/자 · 그 밖 ${r.coef.other.toFixed(2)}토큰/자 · 결과당 ${r.coef.perResult}`,
    `ASCII ${(1 / r.coef.ascii).toFixed(2)} chars/token · Hangul ${r.coef.hangul.toFixed(2)} tokens/char · other ${r.coef.other.toFixed(2)} tokens/char · +${r.coef.perResult} per result`));
  console.log(L(`글자 수 / 4 : 중앙 오차 ${pct(r.naive.median)} · 합계 비 ${r.naive.ratio.toFixed(2)}`, `chars / 4   : median error ${pct(r.naive.median)} · total ratio ${r.naive.ratio.toFixed(2)}`));
  console.log(L(`맞춘 계수   : 중앙 오차 ${pct(r.fitted.median)} · 합계 비 ${r.fitted.ratio.toFixed(2)}`, `fitted      : median error ${pct(r.fitted.median)} · total ratio ${r.fitted.ratio.toFixed(2)}`));
  if (flag('--dry-run')) process.exit(0);
  console.log(L(`저장: ${save(r.coef, { samples: r.samples })}`, `saved: ${save(r.coef, { samples: r.samples })}`));
} else if (cmd === 'export') {
  const { file, byModel, title } = findSession();
  const { exportSession } = require('../lib/export');
  const redact = flag('--redact');
  const out = value('-o') || `context-brain-${path.basename(file, '.jsonl').slice(0, 8)}${redact ? '-redacted' : ''}.html`;
  fs.writeFileSync(out, exportSession(file, { redact, title, byModel }));
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
  const { byModel } = observedCompactAt(listSessions(undefined, 40).map((s) => s.file));
  return { file, byModel, title: sessionTitle(file) };
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

// 상태줄은 자주 불리므로 모델별 압축 크기는 10분 동안 임시 파일에 담아 둔다
function cachedByModel() {
  const os = require('os');
  const cache = path.join(os.tmpdir(), 'context-brain-compact.json');
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (Date.now() - c.at < 10 * 60 * 1000 && c.byModel) return c.byModel;
  } catch (_) { /* 처음이거나 깨졌으면 다시 센다 */ }
  const { listSessions, observedCompactAt } = require('../lib/sessions');
  const { byModel } = observedCompactAt(listSessions(undefined, 40).map((s) => s.file));
  try { fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), byModel })); } catch (_) { /* 캐시 없이 진행 */ }
  return byModel;
}

function statusLine(file) {
  const { parseFile } = require('../lib/export');
  const { diagnose, pickCompact, lastModel } = require('../public/model.js');
  const events = parseFile(file);
  const r = diagnose(events, { compactAt: pickCompact(cachedByModel(), lastModel(events)).at });
  const k = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n || 0)));
  const parts = [`ctx ${r.context == null ? '-' : k(r.context)}${r.compactAt && r.context ? ` (${Math.round((r.context / r.compactAt) * 100)}%)` : ''}`];
  if (r.reclaim) parts.push(L(`되찾을 양 ${k(r.reclaim)}`, `reclaim ${k(r.reclaim)}`));
  const high = r.findings.filter((f) => f.severity === 'high').length;
  if (high) parts.push(L(`진단 높음 ${high}`, `${high} high`));
  return '🧠 ' + parts.join(' · ');
}

function printProject(r, project, describeProject) {
  const tty = process.stdout.isTTY;
  const c = (code, t) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n || 0)));
  const tag = { high: c('31;1', L('높음', 'HIGH')), mid: c('33;1', L('중간', 'MID ')), low: c('36', L('낮음', 'LOW ')) };
  console.log(c('1', L(`프로젝트 진단 · ${project}`, `Project doctor · ${project}`)));
  console.log(L(`세션 ${r.sessions}개 · 턴 ${r.turns} · 압축 ${r.compactions}회 · 컨텍스트 중앙값 ${k(r.medianContext)} · 세션당 고정 비용 ${k(r.fixed)}`,
    `${r.sessions} sessions · ${r.turns} turns · ${r.compactions} compactions · median context ${k(r.medianContext)} · ${k(r.fixed)} fixed per session`));
  if (!r.findings.length) console.log(L('\n반복되는 문제 없음.', '\nNo repeated leaks.'));
  for (const f of r.findings) {
    const d = describeProject(f, L);
    console.log(`\n${tag[f.severity]}  ${c('1', d.title)}`);
    console.log(`      ${c('2', d.fix)}`);
    for (const i of f.items.slice(0, 6)) {
      const extra = f.type === 'p-loud-shell' ? L(` · ${i.count}회 · 평균 ${k(i.avg)}`, ` · ${i.count} calls · avg ${k(i.avg)}`)
        : L(` · 세션 ${i.count}개`, ` · ${i.count} sessions`);
      console.log(`      - ${i.label}  ${c('2', k(i.tokens) + extra)}`);
    }
  }
}
