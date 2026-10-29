'use strict';
// Claude Code 세션 로그(jsonl) 한 줄을 "뇌 영역 자극" 이벤트로 바꾼다.
// 토큰 수는 글자 수 / 4 로 낸 추정치다.

const path = require('path');

const LOBES = {
  rules: '규칙 (CLAUDE.md)',
  system: '시스템 프롬프트',
  memory: '기억 (훅 주입)',
  abilities: '도구 목록',
  dialog: '대화',
  files: '파일',
  shell: '셸',
  web: '웹',
  agents: '서브에이전트',
  skills: '스킬',
  mcp: 'MCP',
  output: '응답',
};

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const IMAGE_TOKENS = 1600; // 이미지 한 장 대략값. base64 길이로 세면 수십 배 부풀려진다

function estTokens(value) {
  if (value == null) return 0;
  if (Array.isArray(value) && value.some((c) => c && c.type === 'image')) {
    return value.reduce((sum, c) => sum + (c && c.type === 'image' ? IMAGE_TOKENS : estTokens(c && c.type === 'text' ? c.text : c)), 0);
  }
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(s.length / 4);
}

function clip(s, n = 60) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function firstLine(s) {
  const clean = String(s || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return clip(clean || '', 40);
}

function shortPath(p) {
  const parts = String(p).split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

// Bash 명령에서 실제 실행 프로그램 이름을 뽑는다 (`cd x && git log` → git).
function shellProgram(cmd) {
  const segs = String(cmd || '').split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  const seg = (segs.find((s) => !/^[({\s]*cd\s/.test(s)) || segs[0] || '').replace(/^[({\s]+/, '');
  const tok = seg.split(/\s+/).find((t) => !/^\w+=/.test(t)) || 'sh';
  return path.basename(tok.replace(/^["']|["']$/g, '')) || 'sh';
}

function createState() {
  return {
    pending: new Map(), // tool_use_id → { lobe, id, label }
    known: new Map(), // 응답 본문에서 찾을 문자열 → { lobe, id, label }
  };
}

function remember(state, needle, target) {
  if (!needle || needle.length < 5) return;
  state.known.set(needle, target);
}

function toolTarget(name, input) {
  input = input || {};
  if (FILE_TOOLS.has(name)) {
    const p = input.file_path || input.notebook_path || '';
    return { lobe: 'files', id: 'file:' + p, label: shortPath(p), detail: name, needle: path.basename(p) };
  }
  if (name === 'Grep' || name === 'Glob') {
    const q = input.pattern || '';
    return { lobe: 'files', id: 'search:' + q, label: `${name} ${clip(q, 30)}`, detail: input.path || '' };
  }
  if (name === 'Bash') {
    const prog = shellProgram(input.command);
    return { lobe: 'shell', id: 'sh:' + prog, label: prog, detail: clip(input.command, 80) };
  }
  if (name === 'WebSearch') {
    return { lobe: 'web', id: 'web:search', label: '웹 검색', detail: clip(input.query, 80) };
  }
  if (name === 'WebFetch') {
    let host = input.url || '';
    try { host = new URL(input.url).host; } catch (_) { /* 그대로 둔다 */ }
    return { lobe: 'web', id: 'web:' + host, label: host, detail: clip(input.url, 80) };
  }
  if (name === 'Agent' || name === 'Task') {
    const t = input.subagent_type || 'general-purpose';
    return { lobe: 'agents', id: 'agent:' + t, label: t, detail: clip(input.description, 80) };
  }
  if (name === 'Skill') {
    const s = input.skill || '?';
    return { lobe: 'skills', id: 'skill:' + s, label: s, detail: clip(input.args, 80), needle: s };
  }
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return { lobe: 'mcp', id: 'mcp:' + server, label: server, detail: rest.join('__') };
  }
  return { lobe: 'abilities', id: 'tool:' + name, label: name, detail: clip(JSON.stringify(input), 80) };
}

function ev(t, target, kind, extra = {}) {
  return { t, lobe: target.lobe, id: target.id, label: target.label, kind, ...extra };
}

function parseAttachment(a, t) {
  const out = [];
  switch (a.type) {
    case 'instructions':
      for (const f of a.files || []) {
        out.push(ev(t, { lobe: 'rules', id: 'rule:' + f.path, label: shortPath(f.path) }, 'load', {
          tokens: estTokens(f.content), detail: f.type,
        }));
      }
      break;
    case 'prompt_snapshot':
      out.push(ev(t, { lobe: 'system', id: 'sys:prompt', label: '시스템 프롬프트' }, 'load', { tokens: estTokens(a.systemPrompt) }));
      break;
    case 'skill_listing':
      out.push(ev(t, { lobe: 'abilities', id: 'abil:skills', label: '스킬 목록' }, 'load', { tokens: estTokens(a.content) }));
      break;
    case 'agent_listing_delta':
      out.push(ev(t, { lobe: 'abilities', id: 'abil:agents', label: '에이전트 목록' }, 'load', { tokens: estTokens(a.addedLines) }));
      break;
    case 'deferred_tools_delta':
      out.push(ev(t, { lobe: 'abilities', id: 'abil:deferred', label: '지연 로드 도구 이름' }, 'load', { tokens: estTokens(a.addedNames) }));
      break;
    case 'deferred_tools_record':
      for (const e of a.entries || []) {
        out.push(ev(t, { lobe: 'abilities', id: 'tool:' + e.name, label: e.name }, 'load', { tokens: estTokens(e), detail: '스키마 로드' }));
      }
      break;
    case 'mcp_instructions_delta':
      (a.addedNames || []).forEach((n, i) => {
        out.push(ev(t, { lobe: 'abilities', id: 'abil:mcp:' + n, label: n + ' 안내' }, 'load', {
          tokens: estTokens((a.addedBlocks || [])[i]),
        }));
      });
      break;
    case 'hook_additional_context':
    case 'hook_system_message': {
      const text = Array.isArray(a.content) ? a.content.join('\n') : a.content;
      if (!text) break;
      const label = firstLine(text);
      out.push(ev(t, { lobe: 'memory', id: 'mem:' + label, label }, 'load', { tokens: estTokens(text), detail: a.hookName || a.type }));
      break;
    }
    case 'environment':
    case 'session_context':
    case 'model':
    case 'date':
    case 'auto_mode':
      out.push(ev(t, { lobe: 'system', id: 'sys:' + a.type, label: a.type }, 'load', { tokens: estTokens(a) }));
      break;
    default:
      break;
  }
  return out;
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

function parseEntry(entry, state) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain) return [];
  const t = entry.timestamp ? Date.parse(entry.timestamp) : null;
  const out = [];

  if (entry.type === 'attachment' && entry.attachment) {
    return parseAttachment(entry.attachment, t);
  }

  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    const meta = entry.compactMetadata || {};
    return [{ t, kind: 'compact', tokens: meta.preTokens || 0, label: `압축 (${meta.trigger || '?'})` }];
  }

  if (entry.type === 'user' && entry.message) {
    const content = entry.message.content;
    if (entry.isCompactSummary) {
      out.push(ev(t, { lobe: 'dialog', id: 'dlg:summary:' + entry.uuid, label: '압축 요약' }, 'load', { tokens: estTokens(content) }));
      return out;
    }
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'tool_result') {
          const target = state.pending.get(c.tool_use_id);
          if (!target) continue;
          state.pending.delete(c.tool_use_id);
          out.push(ev(t, target, 'result', { tokens: estTokens(c.content), error: !!c.is_error }));
        }
      }
    }
    const text = userText(content);
    if (text) {
      const skill = text.match(/^Base directory for this skill: (.+)/);
      if (skill) {
        const name = path.basename(skill[1].trim());
        out.push(ev(t, { lobe: 'skills', id: 'skill:' + name, label: name }, 'load', { tokens: estTokens(text), detail: '스킬 본문 로드' }));
      } else if (!entry.isMeta) {
        out.push(ev(t, { lobe: 'dialog', id: 'dlg:' + entry.uuid, label: firstLine(text) || '(입력)' }, 'use', { tokens: estTokens(text) }));
      }
    }
    return out;
  }

  if (entry.type === 'assistant' && entry.message) {
    const m = entry.message;
    for (const c of m.content || []) {
      if (!c) continue;
      if (c.type === 'tool_use') {
        const target = toolTarget(c.name, c.input);
        state.pending.set(c.id, { lobe: target.lobe, id: target.id, label: target.label });
        remember(state, target.needle, { lobe: target.lobe, id: target.id, label: target.label });
        out.push(ev(t, target, 'use', { detail: target.detail, tokens: estTokens(c.input) }));
      } else if (c.type === 'thinking') {
        out.push(ev(t, { lobe: 'output', id: 'out:thinking', label: '생각' }, 'use', { tokens: estTokens(c.thinking) }));
      } else if (c.type === 'text' && c.text) {
        out.push(ev(t, { lobe: 'output', id: 'out:answer', label: '답변' }, 'use', { tokens: estTokens(c.text), detail: clip(c.text, 80) }));
        for (const [needle, target] of state.known) {
          if (c.text.includes(needle)) out.push(ev(t, target, 'ref', { detail: '답변에서 언급' }));
        }
      }
    }
    const u = m.usage;
    if (u) {
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      out.push({ t, kind: 'usage', tokens: ctx, model: m.model });
    }
    return out;
  }

  return out;
}

// 로그 전체 텍스트(여러 줄)를 이벤트 배열로 바꾼다. 깨진 줄은 건너뛴다.
function parseLines(lines, state) {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    out.push(...parseEntry(entry, state));
  }
  return out;
}

module.exports = { LOBES, createState, parseEntry, parseLines, shellProgram, estTokens };
