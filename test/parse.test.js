const { createState, parseEntry, parseLines, shellProgram, estTokens, preview, inputText } = require('../lib/parse');
const { coefficients } = require('../lib/tokens');

const T = '2026-10-29T01:07:05.000Z';
const assistant = (content, usage) => ({ type: 'assistant', timestamp: T, message: { model: 'm', content, usage } });
const user = (content, extra = {}) => ({ type: 'user', timestamp: T, uuid: 'u1', message: { role: 'user', content }, ...extra });

describe('parseEntry', () => {
  test('CLAUDE.md 로드는 규칙 영역의 파일별 뉴런이 된다', () => {
    const ev = parseEntry({
      type: 'attachment', timestamp: T,
      attachment: { type: 'instructions', files: [{ path: '/Users/a/CLAUDE.md', type: 'User', content: 'x'.repeat(40) }] },
    }, createState());
    expect(ev).toEqual([expect.objectContaining({ lobe: 'rules', id: 'rule:/Users/a/CLAUDE.md', label: 'a/CLAUDE.md', kind: 'load', tokens: estTokens('x'.repeat(40)) })]);
  });

  test('도구 호출과 결과가 tool_use_id 로 이어진다', () => {
    const s = createState();
    const use = parseEntry(assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/server.js' } }]), s);
    expect(use[0]).toMatchObject({ lobe: 'files', id: 'file:/repo/src/server.js', label: 'src/server.js', kind: 'use', detail: 'Read' });
    const res = parseEntry(user([{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(400) }]), s);
    expect(res[0]).toMatchObject({ id: 'file:/repo/src/server.js', kind: 'result', tokens: estTokens('y'.repeat(400)) + coefficients().perResult, error: false });
    expect(s.pending.size).toBe(0);
  });

  test('Bash 는 명령 한 번이 뉴런 하나, 이름은 description', () => {
    const s = createState();
    const [a] = parseEntry(assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'python3 -c 1', description: '토큰 검증' } }]), s);
    const [b] = parseEntry(assistant([{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'python3 -c 2' } }]), s);
    expect(a).toMatchObject({ lobe: 'shell', id: 'sh:b1', label: '토큰 검증', input: 'python3 -c 1', tool: 'Bash' });
    expect(b).toMatchObject({ id: 'sh:b2', label: 'python3' });
    const [r] = parseEntry(user([{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }]), s);
    expect(r).toMatchObject({ id: 'sh:b1', kind: 'result', preview: 'ok' });
  });

  test('짝 없는 tool_result 는 무시한다', () => {
    expect(parseEntry(user([{ type: 'tool_result', tool_use_id: 'nope', content: 'x' }]), createState())).toEqual([]);
  });

  test.each([
    ['Bash', { command: 'cd ~/x && git log' }, 'shell', 'sh:x'],
    ['Grep', { pattern: 'foo' }, 'files', 'search:foo'],
    ['WebSearch', { query: 'q' }, 'web', 'web:search'],
    ['WebFetch', { url: 'https://example.com/a' }, 'web', 'web:example.com'],
    ['WebFetch', { url: 'not a url' }, 'web', 'web:not a url'],
    ['Agent', { subagent_type: 'Explore', description: 'd' }, 'agents', 'agent:Explore'],
    ['Agent', {}, 'agents', 'agent:general-purpose'],
    ['Skill', { skill: 'superpowers:brainstorming' }, 'skills', 'skill:superpowers:brainstorming'],
    ['mcp__docs-wiki__search_wiki', { q: 1 }, 'mcp', 'mcp:docs-wiki'],
    ['ToolSearch', { query: 'x' }, 'abilities', 'tool:ToolSearch'],
  ])('%s → %s 영역', (name, input, lobe, id) => {
    const [e] = parseEntry(assistant([{ type: 'tool_use', id: 'x', name, input }]), createState());
    expect(e).toMatchObject({ lobe, id });
  });

  test('답변에 앞서 다룬 파일 이름이 나오면 언급 이벤트가 생긴다', () => {
    const s = createState();
    parseEntry(assistant([{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/r/parse.js' } }]), s);
    const ev = parseEntry(assistant([{ type: 'text', text: 'parse.js 를 고쳤습니다' }]), s);
    expect(ev.map((e) => e.kind)).toEqual(['use', 'ref']);
    expect(ev[0].text).toBe('parse.js 를 고쳤습니다');
    expect(ev[1]).toMatchObject({ lobe: 'files', id: 'file:/r/parse.js' });
  });

  test('usage 는 컨텍스트 전체 크기로 합산된다', () => {
    const ev = parseEntry(assistant([{ type: 'thinking', thinking: 'abcd' }], {
      input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50,
    }), createState());
    expect(ev[0]).toMatchObject({ lobe: 'output', id: 'out:thinking' });
    expect(ev[1]).toMatchObject({ kind: 'usage', tokens: 152 });
  });

  test('사용자 입력은 대화, 스킬 본문은 스킬, isMeta 는 무시', () => {
    const s = createState();
    expect(parseEntry(user('안녕\n두번째'), s)[0]).toMatchObject({ lobe: 'dialog', label: '안녕', kind: 'use' });
    expect(parseEntry(user([{ type: 'text', text: 'Base directory for this skill: /p/skills/brainstorming\n# B' }]), s)[0])
      .toMatchObject({ lobe: 'skills', id: 'skill:brainstorming', kind: 'load' });
    expect(parseEntry(user('meta', { isMeta: true }), s)).toEqual([]);
  });

  test('턴 종료 기록은 turn_end 이벤트가 된다', () => {
    expect(parseEntry({ type: 'system', subtype: 'turn_duration', timestamp: T, durationMs: 1234 }, createState()))
      .toEqual([{ t: Date.parse(T), kind: 'turn_end', durationMs: 1234 }]);
    expect(parseEntry({ type: 'system', subtype: 'turn_duration' }, createState())[0].durationMs).toBe(0);
  });

  test('압축 경계와 압축 요약', () => {
    const s = createState();
    expect(parseEntry({ type: 'system', subtype: 'compact_boundary', timestamp: T, compactMetadata: { trigger: 'auto', preTokens: 9 } }, s)[0])
      .toMatchObject({ kind: 'compact', tokens: 9 });
    expect(parseEntry(user('요약', { isCompactSummary: true }), s)[0]).toMatchObject({ lobe: 'dialog', label: '압축 요약' });
  });

  test('훅 주입, 시스템 프롬프트, 도구 목록', () => {
    const s = createState();
    const at = (a) => parseEntry({ type: 'attachment', timestamp: T, attachment: a }, s);
    expect(at({ type: 'hook_additional_context', content: ['<X>\n\u001b[1mYou have superpowers.'] })[0])
      .toMatchObject({ lobe: 'memory', label: 'You have superpowers.' });
    expect(at({ type: 'hook_system_message', content: '' })).toEqual([]);
    expect(at({ type: 'prompt_snapshot', systemPrompt: ['abcd'] })[0]).toMatchObject({ lobe: 'system', id: 'sys:prompt' });
    expect(at({ type: 'skill_listing', content: 'x' })[0]).toMatchObject({ id: 'abil:skills' });
    expect(at({ type: 'agent_listing_delta', addedLines: ['a'] })[0]).toMatchObject({ id: 'abil:agents' });
    expect(at({ type: 'deferred_tools_delta', addedNames: ['a'] })[0]).toMatchObject({ id: 'abil:deferred' });
    expect(at({ type: 'deferred_tools_record', entries: [{ name: 'WebSearch' }] })[0]).toMatchObject({ id: 'tool:WebSearch' });
    expect(at({ type: 'mcp_instructions_delta', addedNames: ['flint'], addedBlocks: ['b'] })[0]).toMatchObject({ id: 'abil:mcp:flint' });
    expect(at({ type: 'date', date: 'd' })[0]).toMatchObject({ id: 'sys:date' });
    expect(at({ type: 'credential_org' })).toEqual([]);
  });

  test('서브에이전트 줄과 알 수 없는 항목은 건너뛴다', () => {
    expect(parseEntry({ type: 'user', isSidechain: true, message: { content: 'x' } }, createState())).toEqual([]);
    expect(parseEntry({ type: 'mode' }, createState())).toEqual([]);
    expect(parseEntry(null, createState())).toEqual([]);
  });
});

describe('보조 함수', () => {
  test('shellProgram 은 cd 와 환경변수를 건너뛴다', () => {
    expect(shellProgram('cd /a && FOO=1 /usr/bin/python3 x.py')).toBe('python3');
    expect(shellProgram('ls | head')).toBe('ls');
    expect(shellProgram('( cd /a && "/Applications/Google Chrome" --x & pid=$! )')).toBe('Google');
    expect(shellProgram('(npm test)')).toBe('npm');
    expect(shellProgram('')).toBe('sh');
  });
  test('estTokens', () => {
    expect(estTokens(null)).toBe(0);
    expect(estTokens('abcde')).toBe(Math.ceil(5 * coefficients().ascii));
    expect(estTokens('한글')).toBe(Math.ceil(2 * coefficients().hangul));
    expect(estTokens({ a: 1 })).toBe(Math.ceil(7 * coefficients().ascii));
    const img = { type: 'image', source: { type: 'base64', data: 'A'.repeat(100000) } };
    expect(estTokens([img, { type: 'text', text: 'abcd' }])).toBe(1600 + Math.ceil(4 * coefficients().ascii));
  });
  test('preview 는 이미지를 자리표시로 바꾸고 길이를 자른다', () => {
    expect(preview([{ type: 'image' }, { type: 'text', text: 'hi' }])).toBe('[이미지]\nhi');
    expect(preview('x'.repeat(1000))).toHaveLength(600);
    expect(preview(null)).toBe('');
  });
  test('inputText 는 도구별로 읽을 부분을 뽑는다', () => {
    expect(inputText('Edit', { file_path: '/a', old_string: 'o', new_string: 'n' })).toBe('/a\n- o\n+ n');
    expect(inputText('Bash', {})).toBe('');
    expect(inputText('Grep', { pattern: 'p' })).toContain('"pattern": "p"');
    expect(inputText('Grep')).toBe('{}');
  });
  test('parseLines 는 깨진 줄과 빈 줄을 건너뛴다', () => {
    const lines = ['', '{broken', JSON.stringify(user('hi'))];
    expect(parseLines(lines, createState())).toHaveLength(1);
  });
});

describe('시스템 입력 · 슬래시 명령', () => {
  const userEntry = (content, extra = {}) => ({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content }, ...extra });
  test('작업 알림은 턴이 아니라 대화 영역에 실린 알림이다', () => {
    const ev = parseEntry(userEntry('<task-notification>\n<summary>Goal check-in</summary>\n</task-notification>', { promptSource: 'system' }), createState());
    expect(ev[0]).toMatchObject({ lobe: 'dialog', kind: 'load', id: 'dlg:notice:u1', label: '알림: Goal check-in' });
    const ev2 = parseEntry(userEntry('<task-notification>x</task-notification>'), createState());
    expect(ev2[0].kind).toBe('load');
    const ev3 = parseEntry(userEntry('<local-command-stdout>Goal set: x</local-command-stdout>'), createState());
    expect(ev3[0]).toMatchObject({ kind: 'load', label: '알림: Goal set: x' });
  });
  test('슬래시 명령은 /명령 인자로 보여 준다', () => {
    const ev = parseEntry(userEntry('<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>더 제대로</command-args>'), createState());
    expect(ev[0]).toMatchObject({ kind: 'use', label: '/goal 더 제대로' });
    expect(parseEntry(userEntry('<command-name>/clear</command-name>'), createState())[0].label).toBe('/clear');
  });
});
