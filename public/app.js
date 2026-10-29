import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const { squarify, splitSentences, findRefs, diagnose, describe, describeProject, labelEn } = window.CBModel;
const { L, lang } = window.CBLang;

// ════════════════════════════════════════════════════════════
// 공통
// ════════════════════════════════════════════════════════════
const AX = 0.95, AY = 0.78, AZ = 1.2; // 대뇌 타원체 반지름

// 영역마다 색과 자리. dir 은 표면 방향, inner 는 뇌 안쪽 고정 위치.
const LOBE_META = {
  output:    { color: 0xc9d1e0, dir: [0, 0.15, 1] },
  rules:     { color: 0xffb347, dir: [0, 0.75, 0.6] },
  abilities: { color: 0x5fd3ff, dir: [0, 1, -0.15] },
  agents:    { color: 0xff6fb5, dir: [-0.75, 0.45, 0.45] },
  web:       { color: 0x4da3ff, dir: [0.75, 0.45, 0.45] },
  skills:    { color: 0xb6ff5c, dir: [-0.75, 0.5, -0.45] },
  mcp:       { color: 0x3ee6c8, dir: [0.75, 0.5, -0.45] },
  dialog:    { color: 0x7dff9b, dir: [-1, -0.35, 0.15] },
  shell:     { color: 0xff7a59, dir: [1, -0.35, 0.15] },
  files:     { color: 0xffe066, dir: [0, 0.2, -1] },
  memory:    { color: 0xc48bff, inner: [0, -0.22, 0.12], spread: 0.2 },
  system:    { color: 0x8a9bb0, inner: [0, -0.62, -0.62], spread: 0.17 },
};
const lobeNames = Object.keys(LOBE_META);
// 압축되면 컨텍스트에서 빠지는 영역 (규칙·시스템·도구 목록은 다시 실린다)
const COMPACTABLE = new Set(['dialog', 'files', 'shell', 'web', 'agents', 'mcp', 'output']);
// 턴마다 새로 쓰지 않아도 늘 실려 있는 영역
const STANDING = ['rules', 'system', 'abilities', 'memory'];
const KIND_LABEL = L({ use: '사용', result: '결과', load: '로드', ref: '언급' }, { use: 'used', result: 'result', load: 'loaded', ref: 'named' });
const KIND_WEIGHT = { use: 1.0, result: 0.8, load: 0.6, ref: 0.9 };
const HISTORY_MAX = 40;
const ANSWER_LINES = 8;
const LABEL_TOP = 8;      // 늘 이름표를 붙이는 큰 항목 수
const LABEL_TURN = 12;    // 보고 있는 턴에서 이름표를 붙이는 항목 수
const FLOW_MAX = 30;      // 보고 있는 턴에서 그리는 빛줄기 수
const RED_MAX = 12;       // 붉게 표시하는 다시 안 쓰인 항목 수 (큰 것부터)
let LOBE_NAMES = {};
const LOBE_EN = { rules: 'Rules (CLAUDE.md)', system: 'System prompt', memory: 'Memory (hooks)', abilities: 'Tool list', dialog: 'Dialog',
  files: 'Files', shell: 'Shell', web: 'Web', agents: 'Subagents', skills: 'Skills', mcp: 'MCP', output: 'Response' };
const labelOf = (e) => (lang === 'en' ? window.CBModel.labelEn(e.id, e.label) : e.label);
const DETAIL_EN = { '스키마 로드': 'schema loaded', '스킬 본문 로드': 'skill body loaded', '답변에서 언급': 'named in the answer' };
const detailOf = (d) => (lang === 'en' && DETAIL_EN[d]) || d;

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + new THREE.Color(c).getHexString();
const fmt = (n) => Math.round(n || 0).toLocaleString(L('ko-KR', 'en-US'));
const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(Math.round(n || 0)));
const clock2 = (t) => (t ? new Date(t).toLocaleTimeString('en-GB') : '');
const lobeName = (l) => L(LOBE_NAMES[l] || l, LOBE_EN[l] || l);
const short = (s, n = 26) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function surface(dir, scale = 0.93) {
  const [x, y, z] = dir;
  const t = 1 / Math.sqrt((x / AX) ** 2 + (y / AY) ** 2 + (z / AZ) ** 2);
  return new THREE.Vector3(x * t * scale, y * t * scale, z * t * scale);
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
const anchors = Object.fromEntries(lobeNames.map((l) => {
  const m = LOBE_META[l];
  return [l, m.inner ? new THREE.Vector3(...m.inner) : surface(m.dir, 0.93)];
}));

// ════════════════════════════════════════════════════════════
// 상태: 뉴런(컨텍스트 항목) · 턴 · 압축 · 컨텍스트 크기
// ════════════════════════════════════════════════════════════
const neurons = new Map();
let turns = [];            // [{ n, prompt, t, steps, answers, items, added, done, ms, ctxEnd }]
let compactions = [];      // [{ afterTurn, tokens, t }]
let ctxHistory = [];
let compactAt = null;      // 이 세션 모델의 압축 기준 (값이 모일 때만)
let compactInfo = { at: null, range: null, n: 0 };
let byModel = null;
let curModel = null;
let viewTurn = null;       // 사용자가 고른 턴 번호. null 이면 지금 턴
let selected = null;       // { n } 또는 { lobe }
let wasteIds = new Set();
const showAll = new Set();

const curTurn = () => turns[turns.length - 1] || null;
const vt = () => viewTurn || turns.length;

function getNeuron(e) {
  let n = neurons.get(e.id);
  if (n) return n;
  n = { id: e.id, lobe: e.lobe, label: labelOf(e), act: 0, tokens: 0, counts: {}, compacted: false,
    history: [], turns: new Set(), lastTurn: 0, mesh: null, tag: null };
  neurons.set(e.id, n);
  brain.addNeuron(n);
  return n;
}

function startTurn(e) {
  turns.push({ n: turns.length + 1, prompt: labelOf(e), t: e.t, steps: [], answers: [], items: new Map(), added: 0, done: false, ms: 0, ctxEnd: null });
}

function trackTurn(e, n) {
  const tr = curTurn();
  if (!tr) return;
  if (e.kind === 'load' && e.lobe !== 'skills') return;
  n.turns.add(tr.n);
  n.lastTurn = tr.n;
  if (e.lobe === 'output') {
    if (e.id === 'out:answer' && e.text) tr.answers.push(e.text);
    return;
  }
  if (e.lobe === 'dialog') return;
  const it = tr.items.get(n.id) || { n, tokens: 0, kinds: new Set() };
  it.kinds.add(e.kind);
  if (e.kind === 'result' || e.kind === 'load') { it.tokens += e.tokens || 0; tr.added += e.tokens || 0; }
  tr.items.set(n.id, it);
  const last = tr.steps[tr.steps.length - 1];
  if (e.kind === 'load' && last && last.id === n.id) last.tokens += e.tokens || 0; // 스킬 호출 직후 본문 로드는 같은 칩으로
  else if (e.kind === 'use' || e.kind === 'load') tr.steps.push({ id: n.id, kind: e.kind, tokens: e.kind === 'load' ? e.tokens || 0 : 0, error: false });
  else if (e.kind === 'result') {
    const step = [...tr.steps].reverse().find((s) => s.id === n.id && s.kind === 'use' && !s.done);
    if (step) { step.tokens = e.tokens || 0; step.error = !!e.error; step.done = true; }
  }
}

function applyEvent(e, live) {
  if (e.kind === 'usage') {
    ctxHistory.push(e.tokens);
    if (e.model) curModel = e.model;
    if (ctxHistory.length > 120) ctxHistory.shift();
    const tr = curTurn();
    if (tr) tr.ctxEnd = e.tokens;
    return;
  }
  if (e.kind === 'turn_end') {
    const tr = curTurn();
    if (tr) { tr.done = true; tr.ms = e.durationMs; }
    return;
  }
  if (e.kind === 'compact') {
    for (const n of neurons.values()) if (COMPACTABLE.has(n.lobe)) n.compacted = true;
    compactions.push({ afterTurn: turns.length, tokens: e.tokens, t: e.t });
    if (live) brain.flash();
    return;
  }
  if (!LOBE_META[e.lobe]) return;
  if (e.lobe === 'dialog' && e.kind === 'use' && !e.id.startsWith('dlg:summary')) startTurn(e);
  const n = getNeuron(e);
  n.label = labelOf(e) || n.label;
  n.counts[e.kind] = (n.counts[e.kind] || 0) + 1;
  if (n.compacted && e.kind !== 'ref') { n.compacted = false; n.tokens = 0; } // 압축 뒤 다시 들어온 것은 새로 센다
  if (e.tokens) n.tokens = e.kind === 'load' ? Math.max(n.tokens, e.tokens) : n.tokens + e.tokens;
  n.history.push(e);
  if (n.history.length > HISTORY_MAX) n.history.shift();
  trackTurn(e, n);
  if (live) {
    n.act = Math.min(1.2, n.act + (KIND_WEIGHT[e.kind] || 0.8));
    brain.pulse(e, n);
  }
}

// 턴의 답변 문장에 이름이 그대로 나온 항목들
function evidenceOf(tr) {
  if (!tr) return new Set();
  const cands = [...neurons.values()].filter((n) => n.lobe !== 'output' && n.lobe !== 'dialog' && [...n.turns].some((t) => t <= tr.n));
  const ids = new Set();
  for (const s of tr.answers.flatMap(splitSentences)) for (const id of findRefs(s, cands)) ids.add(id);
  // 내용을 가린 공유 파일에는 답변 본문이 없다. 파서가 남긴 언급 기록으로 대신한다
  if (!tr.answers.length) for (const it of tr.items.values()) if (it.kinds.has('ref')) ids.add(it.n.id);
  return ids;
}

// ════════════════════════════════════════════════════════════
// 3D 뇌
// ════════════════════════════════════════════════════════════
const brain = (() => {
  const stage = $('stage');
  const size = () => [Math.max(1, stage.clientWidth), Math.max(1, stage.clientHeight)];
  const [w0, h0] = size();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, w0 / h0, 0.05, 50);
  camera.position.set(3.4, 0.85, 1.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w0, h0);
  stage.prepend(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(w0, h0);
  Object.assign(labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', zIndex: 1 });
  stage.insertBefore(labels.domElement, renderer.domElement.nextSibling);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.35;
  controls.minDistance = 1.2;
  controls.maxDistance = 7;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(w0, h0), 0.5, 0.45, 0.55));
  composer.addPass(new OutputPass());

  // ── 표면 점 구름: 대뇌 두 반구 + 소뇌 + 뇌간
  const pts = [];
  const rnd = hash('brain');
  const sphere = () => { const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u); return [s * Math.cos(th), u, s * Math.sin(th)]; };
  for (let i = 0; i < 30000; i++) {
    let [x, y, z] = sphere();
    const fold = Math.sin(9 * x + 2.2 * Math.sin(5 * z)) * Math.sin(8 * y + 3) + 0.8 * Math.sin(7 * z + 2 * Math.sin(6 * y));
    if (Math.abs(fold) > 0.42 && rnd() > 0.18) continue; // 주름(이랑)
    x *= AX; y *= AY; z *= AZ;
    if (y < 0) y *= 0.82;
    x *= 1 - 0.1 * Math.max(0, z / AZ);
    if (y < 0.05 && Math.abs(x) > 0.35) y -= 0.16 * Math.exp(-(((z - 0.1) / 0.42) ** 2)) * Math.min(1, (Math.abs(x) - 0.35) * 3); // 측두엽
    const g = 1 + 0.03 * Math.sin(13 * x + 2) * Math.sin(10 * y + 1) * Math.sin(12 * z);
    x *= g; y *= g; z *= g;
    if (Math.abs(x) > 0.45 && z > -0.35 && z < 0.75 && Math.abs(y - (-0.02 + 0.22 * z)) < 0.035) continue; // 실비우스 열구
    x += Math.sign(x || 1) * 0.04;
    if (y < -0.35 && z < -0.3 && Math.abs(x) < 0.5) continue;
    pts.push(x, y, z);
  }
  for (let i = 0; i < 1800; i++) {
    const [x, y, z] = sphere();
    const g = 1 + 0.06 * Math.sin(45 * y);
    pts.push(x * 0.5 * g, -0.5 + y * 0.24 * g, -0.82 + z * 0.33 * g);
  }
  for (let i = 0; i < 500; i++) {
    const th = rnd() * Math.PI * 2, hh = rnd();
    pts.push(Math.cos(th) * 0.11, -0.55 - hh * 0.45, -0.4 + Math.sin(th) * 0.11 - hh * 0.08);
  }
  const count = pts.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const colors = new Float32Array(count * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.013, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
  })));

  // 점마다 가장 가까운 영역과 그 영역에 속한 정도
  const pointLobe = new Int16Array(count).fill(-1);
  const pointWeight = new Float32Array(count);
  {
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      p.fromArray(pts, i * 3);
      let best = -1, bd = Infinity;
      lobeNames.forEach((l, li) => { const d = p.distanceTo(anchors[l]); if (d < bd) { bd = d; best = li; } });
      const reach = LOBE_META[lobeNames[best]].inner ? 0.5 : 0.62;
      if (bd < reach) { pointLobe[i] = best; pointWeight[i] = (1 - bd / reach) ** 1.3; }
    }
  }

  // ── 영역 이름표: 이름 + 토큰 합계. 누르면 그 영역으로 다가간다
  const lobeState = {};
  for (const l of lobeNames) {
    const el = document.createElement('div');
    el.className = 'lobe-label';
    el.style.color = hex(LOBE_META[l].color);
    el.addEventListener('click', () => focusLobe(l));
    const obj = new CSS2DObject(el);
    obj.position.copy(LOBE_META[l].inner ? anchors[l] : anchors[l].clone().multiplyScalar(1.2));
    scene.add(obj);
    lobeState[l] = { act: 0, hold: 0, present: false, el, color: new THREE.Color(LOBE_META[l].color) };
  }

  // ── 뉴런
  const neuronGeo = new THREE.SphereGeometry(1, 18, 14);
  const group = new THREE.Group();
  scene.add(group);
  const radiusFor = (tokens) => Math.min(0.07, 0.012 + 0.012 * Math.log10(1 + tokens / 40));

  function position(lobe, id) {
    const m = LOBE_META[lobe];
    const r = hash(id);
    const u = r() * 2 - 1, th = r() * Math.PI * 2, rr = Math.cbrt(r());
    const s = Math.sqrt(1 - u * u);
    const off = new THREE.Vector3(s * Math.cos(th), u, s * Math.sin(th));
    if (m.inner) return new THREE.Vector3(...m.inner).addScaledVector(off, (m.spread || 0.2) * rr);
    const d = new THREE.Vector3(...m.dir).normalize().addScaledVector(off, 0.38 * rr);
    return surface([d.x, d.y, d.z], 0.86 + r() * 0.08);
  }

  function addNeuron(n) {
    const mesh = new THREE.Mesh(neuronGeo, new THREE.MeshBasicMaterial({ color: LOBE_META[n.lobe].color, transparent: true, toneMapped: false }));
    mesh.position.copy(position(n.lobe, n.id));
    mesh.userData.neuron = n;
    group.add(mesh);
    n.mesh = mesh;
    const el = document.createElement('div');
    el.className = 'n-label';
    el.style.display = 'none';
    const tag = new CSS2DObject(el);
    tag.position.copy(mesh.position);
    scene.add(tag);
    n.tag = tag;
  }

  // ── 순간 신호 (실시간 이벤트가 들어올 때 한 번)
  const pulses = [];
  const dotGeo = new THREE.SphereGeometry(1, 8, 6);
  const curve = (a, b) => new THREE.QuadraticBezierCurve3(a.clone(), a.clone().add(b).multiplyScalar(0.225), b.clone());
  function spawn(from, to, color) {
    if (pulses.length > 40) return;
    const c = curve(from, to);
    const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6), toneMapped: false }));
    dot.scale.setScalar(0.016);
    scene.add(dot);
    pulses.push({ c, dot, age: 0, life: 0.9 });
  }
  function pulse(e, n) {
    if (e.lobe === 'output') return;
    if (e.kind === 'use') spawn(anchors.output, n.mesh.position, LOBE_META[e.lobe].color);
    else if (e.kind === 'result' || e.kind === 'ref') spawn(n.mesh.position, anchors.output, 0xffffff);
  }

  // ── 남는 흐름: 보고 있는 턴의 항목 → 응답. 굵기 = 들어온 토큰, 입자가 계속 흐른다
  let flows = [];
  let flowKey = '';
  function clearFlows() {
    for (const f of flows) {
      scene.remove(f.tube); f.tube.geometry.dispose(); f.tube.material.dispose();
      for (const d of f.dots) { scene.remove(d); d.material.dispose(); }
    }
    flows = [];
  }
  function buildFlows(no, evidence) {
    const tr = turns[no - 1];
    const list = tr ? [...tr.items.values()].sort((a, b) => b.tokens - a.tokens).slice(0, FLOW_MAX) : [];
    const key = `${no}|${list.map((it) => it.n.id + ':' + it.tokens).join(',')}|${[...evidence].join(',')}`;
    if (key === flowKey) return;
    flowKey = key;
    clearFlows();
    for (const it of list) {
      const n = it.n;
      const ev = evidence.has(n.id);
      const c = curve(n.mesh.position, anchors.output);
      const r = Math.min(0.016, 0.0035 + 0.0035 * Math.log10(1 + it.tokens / 60));
      const color = new THREE.Color(LOBE_META[n.lobe].color);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(c, 40, r, 6, false),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: ev ? 0.5 : 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
      scene.add(tube);
      const dots = [];
      for (let k = 0; k < (ev ? 3 : 2); k++) {
        const d = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({
          color: ev ? new THREE.Color(0xffffff).multiplyScalar(1.4) : color.clone().multiplyScalar(1.1), toneMapped: false }));
        d.scale.setScalar(ev ? 0.012 : 0.008);
        scene.add(d);
        dots.push(d);
      }
      flows.push({ c, tube, dots, u: hash(n.id)(), speed: ev ? 0.45 : 0.25 });
    }
  }

  // ── 카메라: 시점 버튼과 영역 확대
  let fly = null;
  function flyTo(pos, target) {
    fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, k: 0 };
  }
  const VIEWS = {
    side: [new THREE.Vector3(3.4, 0.6, 1.2), new THREE.Vector3(0, 0, 0)],
    top: [new THREE.Vector3(0.01, 4.0, 0.6), new THREE.Vector3(0, 0, 0)],
    front: [new THREE.Vector3(0.4, 0.5, 3.8), new THREE.Vector3(0, 0, 0)],
  };
  function setView(name) {
    const [p, t] = VIEWS[name];
    flyTo(p.clone(), t.clone());
  }
  function focusLobe(l) {
    const a = anchors[l];
    const dir = LOBE_META[l].inner ? new THREE.Vector3(1, 0.25, 0.3).normalize() : a.clone().normalize();
    flyTo(a.clone().add(dir.multiplyScalar(1.7)), a.clone().multiplyScalar(0.75));
    for (const n of neurons.values()) if (n.lobe === l) n.act = Math.max(n.act, 0.5);
    selectLobe(l);
  }

  // ── 화면 갱신 때 한 번: 이름표, 영역 합계, 흐름
  let surfaceDirty = true;
  let labelOrder = [];
  // 화면에서 겹치는 이름표는 우선순위(보고 있는 턴 → 토큰)가 낮은 쪽을 숨긴다
  function declutter() {
    const placed = lobeNames.map((l) => lobeState[l].el.getBoundingClientRect());
    const hit = (r) => placed.some((q) => r.left < q.right + 2 && r.right > q.left - 2 && r.top < q.bottom + 1 && r.bottom > q.top - 1);
    for (const n of labelOrder) {
      const el = n.tag.element;
      if (el.style.display === 'none') continue;
      el.style.visibility = 'visible';
      const r = el.getBoundingClientRect();
      if (!r.width || hit(r)) el.style.visibility = 'hidden';
      else placed.push(r);
    }
  }
  function refresh() {
    const no = vt();
    const live = [...neurons.values()].filter((n) => !n.compacted);
    const sums = {};
    for (const n of live) sums[n.lobe] = (sums[n.lobe] || 0) + n.tokens;
    for (const l of lobeNames) {
      const s = lobeState[l];
      const present = !!sums[l];
      if (present !== s.present) { s.present = present; surfaceDirty = true; }
      s.el.innerHTML = `${lobeName(l)}<em>${sums[l] ? kfmt(sums[l]) : '-'}</em>`;
      s.el.style.opacity = present ? '1' : '0.35';
    }
    const show = new Set(live.filter((n) => n.lobe !== 'output').sort((a, b) => b.tokens - a.tokens).slice(0, LABEL_TOP).map((n) => n.id));
    live.filter((n) => n.turns.has(no) && n.lobe !== 'output' && n.lobe !== 'dialog')
      .sort((a, b) => b.tokens - a.tokens).slice(0, LABEL_TURN).forEach((n) => show.add(n.id));
    labelOrder = [...show].map((id) => neurons.get(id)).sort((a, b) => (b.turns.has(no) - a.turns.has(no)) || (b.tokens - a.tokens));
    for (const n of neurons.values()) {
      const on = show.has(n.id);
      n.tag.element.style.display = on ? '' : 'none';
      if (on) {
        n.tag.element.className = 'n-label' + (wasteIds.has(n.id) ? ' waste' : '');
        n.tag.element.innerHTML = `${escapeHtml(short(n.label))}<em>${kfmt(n.tokens)}</em>`;
      }
    }
    buildFlows(no, evidenceOf(turns[no - 1]));
  }

  function clear() {
    for (const n of neurons.values()) { group.remove(n.mesh); n.mesh.material.dispose(); scene.remove(n.tag); }
    clearFlows();
    flowKey = '';
  }

  let flashV = 0;
  const flash = () => { flashV = 1; };

  // ── 클릭 · 툴팁
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const pick = (ev) => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObjects(group.children)[0];
    return hit ? hit.object.userData.neuron : null;
  };
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; fly = null; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
    const n = pick(ev);
    if (n) select(n);
  });
  renderer.domElement.addEventListener('pointermove', (ev) => {
    const n = pick(ev);
    renderer.domElement.style.cursor = n ? 'pointer' : '';
    if (n) showTip(ev, `<b>${lobeName(n.lobe)}: ${escapeHtml(n.label)}</b><span>${L(`약 ${fmt(n.tokens)} 토큰`, `~${fmt(n.tokens)} tokens`)}${n.compacted ? L(' · 압축으로 빠짐', ' · dropped by compaction') : ''}${wasteIds.has(n.id) ? L(' · 다시 안 쓰임', ' · never used again') : ''}</span><span>${L('클릭하면 자세히', 'click for details')}</span>`);
    else hideTip();
  });
  renderer.domElement.addEventListener('pointerleave', hideTip);

  function resize() {
    const [w, h] = size();
    camera.aspect = w / h;
    // 아래쪽 히스토리 띠만큼 뇌를 위로 올려 띠에 가리지 않게 한다
    const lift = Math.round(($('player').offsetHeight || 0) / 2);
    camera.setViewOffset(w, h, 0, lift, w, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    labels.setSize(w, h);
  }
  new ResizeObserver(resize).observe(stage);

  // ── 매 프레임
  const clk = new THREE.Clock();
  const tmp = new THREE.Color();
  const BASE = new THREE.Color(0x34425e).multiplyScalar(0.5);
  const GREY = new THREE.Color(0x55607a);
  const RED = new THREE.Color(0xff4a4a);
  const FLASH = new THREE.Color(0xff5050);
  const baseColors = new Float32Array(count * 3);
  function paintBase() {
    // 영역이 있는 자리는 표면에 그 영역 색을 옅게 늘 칠해 둔다
    for (let i = 0; i < count; i++) {
      tmp.copy(BASE);
      const li = pointLobe[i];
      if (li >= 0 && lobeState[lobeNames[li]].present) tmp.lerp(lobeState[lobeNames[li]].color, 0.28 * pointWeight[i]).multiplyScalar(1 + 0.5 * pointWeight[i]);
      baseColors[i * 3] = tmp.r; baseColors[i * 3 + 1] = tmp.g; baseColors[i * 3 + 2] = tmp.b;
    }
  }
  let shellBusy = true;
  let declutterAt = 0;
  function frame() {
    const dt = Math.min(clk.getDelta(), 0.1);
    const time = clk.elapsedTime;
    const decay = Math.exp(-dt / 2.5);
    flashV *= Math.exp(-dt / 0.6);
    const no = vt();
    for (const l of lobeNames) { lobeState[l].act = 0; lobeState[l].hold = 0; }
    for (const n of neurons.values()) {
      n.act *= decay;
      const ls = lobeState[n.lobe];
      // 밝기 = 최근에 쓰였는지: 보고 있는 턴 > 그 전 두 턴 > 늘 실린 것 > 오래된 것
      const inView = n.turns.has(no);
      const recent = !inView && (n.turns.has(no - 1) || n.turns.has(no - 2));
      const level = inView ? 0.6 : recent ? 0.22 : STANDING.includes(n.lobe) ? 0.18 : 0.06;
      ls.act = Math.max(ls.act, n.act);
      if (inView) ls.hold = 0.5;
      n.mesh.scale.setScalar(radiusFor(n.tokens) * (1 + 0.3 * Math.min(n.act, 1)));
      const m = n.mesh.material;
      if (n.compacted) { m.color.copy(GREY).multiplyScalar(0.3 + n.act); m.opacity = 0.4; }
      else if (wasteIds.has(n.id)) { m.color.copy(RED).multiplyScalar(0.45 + 0.35 * Math.sin(time * 3) + n.act); m.opacity = 1; }
      else { m.color.copy(ls.color).multiplyScalar(0.12 + 0.95 * (level + n.act)); m.opacity = 1; }
    }

    if (surfaceDirty) { paintBase(); surfaceDirty = false; shellBusy = true; }
    const busy = flashV > 0.01 || lobeNames.some((l) => lobeState[l].act > 0.01 || lobeState[l].hold > 0.01);
    if (busy || shellBusy) {
      for (let i = 0; i < count; i++) {
        tmp.setRGB(baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);
        const li = pointLobe[i];
        if (li >= 0) {
          const ls = lobeState[lobeNames[li]];
          const a = Math.max(ls.act, ls.hold * 0.5);
          if (a > 0.01) tmp.lerp(ls.color, Math.min(1, a * pointWeight[i] * 0.6)).multiplyScalar(1 + a * pointWeight[i] * 0.5);
        }
        if (flashV > 0.01) tmp.lerp(FLASH, flashV * 0.5);
        colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
      }
      geo.attributes.color.needsUpdate = true;
    }
    shellBusy = busy;

    for (const f of flows) {
      f.u = (f.u + dt * f.speed) % 1;
      f.dots.forEach((d, k) => d.position.copy(f.c.getPoint((f.u + k / f.dots.length) % 1)));
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i];
      q.age += dt;
      const k = q.age / q.life;
      q.dot.position.copy(q.c.getPoint(Math.min(1, k)));
      if (k >= 1) { scene.remove(q.dot); q.dot.material.dispose(); pulses.splice(i, 1); }
    }
    if (fly) {
      fly.k = Math.min(1, fly.k + dt / 0.8);
      const e = 1 - (1 - fly.k) ** 3;
      camera.position.lerpVectors(fly.p0, fly.p1, e);
      controls.target.lerpVectors(fly.t0, fly.t1, e);
      if (fly.k >= 1) fly = null;
    }
    controls.update();
    composer.render();
    labels.render(scene, camera);
    if ((declutterAt -= dt) <= 0) { declutterAt = 0.3; declutter(); }
    requestAnimationFrame(frame);
  }
  frame();

  const toggleRotate = () => (controls.autoRotate = !controls.autoRotate);
  return { addNeuron, pulse, flash, refresh, clear, setView, focusLobe, toggleRotate };
})();

// ── 뇌 막대: 턴 이동 · 시점 · 회전 · 크게
document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => brain.setView(b.dataset.cam)));
$('rotate').addEventListener('click', () => $('rotate').classList.toggle('on', brain.toggleRotate()));
$('turn-prev').addEventListener('click', () => setViewTurn(Math.max(1, vt() - 1)));
$('turn-next').addEventListener('click', () => setViewTurn(vt() + 1));
$('brain-size').addEventListener('click', () => {
  const big = $('brainbox').classList.toggle('big');
  document.body.classList.toggle('brain-big', big);
  $('brain-size').textContent = big ? L('작게 (Esc)', 'Smaller (Esc)') : L('크게', 'Bigger');
});
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && $('brainbox').classList.contains('big')) $('brain-size').click();
  if (ev.target.closest('input, select, textarea')) return;
  if (ev.key === '[') $('turn-prev').click();
  if (ev.key === ']') $('turn-next').click();
  if (ev.key === ' ') { ev.preventDefault(); $('play').click(); }
});

// ════════════════════════════════════════════════════════════
// 툴팁 · 선택
// ════════════════════════════════════════════════════════════
const tip = $('tip');
function showTip(ev, html) {
  tip.innerHTML = html;
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - 330) + 'px';
  tip.hidden = false;
  // 화면 아래쪽(히스토리 띠)에서는 커서 위로 띄운다
  const h = tip.offsetHeight;
  tip.style.top = (ev.clientY + 14 + h > innerHeight ? Math.max(8, ev.clientY - h - 12) : ev.clientY + 14) + 'px';
}
function hideTip() { tip.hidden = true; }

function select(n) {
  selected = { n };
  n.act = Math.max(n.act, 1);
  renderDetail();
}
function selectLobe(l) {
  selected = { lobe: l };
  renderDetail();
}

function setViewTurn(no) {
  viewTurn = no && no < turns.length ? no : null;
  scheduleRender();
}

// 클릭 위임: data-id 는 뉴런, data-more 는 답변 전체 보기
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-id]');
  if (t && neurons.has(t.dataset.id)) { select(neurons.get(t.dataset.id)); return; }
  const more = ev.target.closest('[data-more]');
  if (more) { const no = Number(more.dataset.more); showAll.has(no) ? showAll.delete(no) : showAll.add(no); scheduleRender(); return; }
});
document.addEventListener('mouseover', (ev) => {
  const t = ev.target.closest('[data-id]');
  if (!t || !neurons.has(t.dataset.id)) return;
  const n = neurons.get(t.dataset.id);
  n.act = Math.max(n.act, 0.8); // 목록에서 가리킨 항목을 뇌에서도 짚어 준다
});

// ════════════════════════════════════════════════════════════
// 화면: 링 · 면적 지도
// ════════════════════════════════════════════════════════════
function renderRing(now) {
  const box = $('ring');
  if (now == null) { box.innerHTML = `<span>${L('컨텍스트 기록 없음', 'no context yet')}</span>`; return; }
  const r = compactAt ? Math.min(1, now / compactAt) : 0;
  const color = r > 0.85 ? '#ff8a8a' : r > 0.65 ? '#ffc76b' : '#9be7a8';
  const C = 2 * Math.PI * 17;
  const rg = compactInfo.range;
  // 기준이 있으면 남은 양, 없으면 같은 모델에서 자동 압축이 일어난 범위만 밝힌다
  const sub = compactAt
    ? L(`압축까지 약 ${kfmt(Math.max(0, compactAt - now))} (같은 모델 자동 압축 ${compactInfo.n}건 기준)`, `~${kfmt(Math.max(0, compactAt - now))} until compaction (from ${compactInfo.n} auto-compactions)`)
    : rg ? L(`지난 자동 압축 ${kfmt(rg[0])}~${kfmt(rg[1])} (${compactInfo.n}건, 흩어져 기준 없음)`, `past auto-compactions ${kfmt(rg[0])}–${kfmt(rg[1])} (${compactInfo.n}, too spread for a threshold)`)
      : L('이 모델의 자동 압축 기록 없음', 'no auto-compaction seen for this model');
  box.innerHTML = `${compactAt ? `<svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="17" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="5"/>
      <circle cx="22" cy="22" r="17" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"
        stroke-dasharray="${(C * r).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 22 22)"/>
      <text x="22" y="26" text-anchor="middle" font-size="11" fill="#e3e9f5">${Math.round(r * 100)}%</text></svg>` : ''}
    <div><b>${kfmt(now)} ${L('토큰', 'tokens')}</b>${sub}
      ${report && report.reclaim ? `<a class="reclaim" href="#doctor">${L(`되찾을 수 있는 양 약 ${kfmt(report.reclaim)}`, `~${kfmt(report.reclaim)} reclaimable`)}</a>` : ''}</div>`;
}

// ════════════════════════════════════════════════════════════
// 화면: 컨텍스트 진단 (뇌 아래 첫 카드)
// ════════════════════════════════════════════════════════════
let report = null;
const SEV_LABEL = { high: L('높음', 'High'), mid: L('중간', 'Medium'), low: L('낮음', 'Low') };
function renderDoctor() {
  report = diagnose(allEvents.slice(0, player.i), { compactAt });
  // 뇌에서 붉게 숨쉬는 뉴런 · 면적 지도의 빗금은 진단의 '다시 안 쓰인 항목' 중 큰 것만 (숫자는 진단 카드와 같다)
  const dead = report.findings.find((f) => f.type === 'dead-weight');
  wasteIds = new Set(dead ? dead.items.slice(0, RED_MAX).map((i) => i.id) : []);
  const box = $('doctor-body');
  if (!report.findings.length) {
    box.innerHTML = `<div class="empty">${L('아직 고칠 것이 없습니다', 'Nothing to fix yet')}</div>`;
    return;
  }
  const head = `<div class="doc-head"><div><b>${kfmt(report.reclaim)}</b><span>${L('지금 되찾을 수 있는 토큰', 'tokens reclaimable now')}</span></div>
    <div><b>${report.findings.length}</b><span>${L('진단', 'findings')}</span></div>
    </div>`;
  const cards = report.findings.map((f0) => {
    const f = lang === 'en' ? { ...f0, items: f0.items.map((i) => ({ ...i, label: window.CBModel.labelEn(i.id, i.label) })) } : f0;
    const d = describe(f, L);
    const chips = f.items.slice(0, 6).map((i) => {
      const label = i.label;
      const n = i.count > 1 ? (f.type === 'dead-weight' ? L(` · ${i.count}턴`, ` · ${i.count} turns`) : ` ×${i.count}`) : '';
      return `<span class="chip"${neurons.has(i.id) ? ` data-id="${escapeHtml(i.id)}"` : ''}>${escapeHtml(short(label, 34))} <em>${kfmt(i.tokens)}${n}</em></span>`;
    }).join('');
    const more = f.items.length > 6 ? `<span class="chip more-chip">+${f.items.length - 6}</span>` : '';
    return `<li class="doc ${f.severity}"><div class="doc-title"><span class="sev">${SEV_LABEL[f.severity]}</span>${escapeHtml(d.title)}</div>
      <div class="doc-fix">${escapeHtml(d.fix)}</div>${chips || more ? `<div class="flow">${chips}${more}</div>` : ''}</li>`;
  }).join('');
  box.innerHTML = head + `<ol class="docs">${cards}</ol>`;
}

// ════════════════════════════════════════════════════════════
// 화면: 프로젝트 진단 (요청할 때만 서버에서 계산)
// ════════════════════════════════════════════════════════════
async function runProject() {
  if (!currentFile) return;
  const body = $('project-body');
  $('project-run').disabled = true;
  body.innerHTML = `<div class="empty">${L('세션을 읽는 중…', 'reading sessions…')}</div>`;
  try {
    const r = await fetch('/api/project?file=' + encodeURIComponent(currentFile)).then((x) => x.json());
    renderProject(r);
  } catch (_) {
    body.innerHTML = `<div class="empty">${L('분석하지 못했습니다', 'analysis failed')}</div>`;
  }
  $('project-run').disabled = false;
}

function renderProject(r) {
  const loc = (i) => (lang === 'en' ? { ...i, label: labelEn(i.id, i.label) } : i);
  const maxCtx = Math.max(1, ...r.rows.map((x) => x.context || 0), compactAt || 0);
  const bars = r.rows.map((x) => {
    const w = ((x.context || 0) / maxCtx) * 100;
    const mark = compactAt ? `<i class="cut" style="left:${(compactAt / maxCtx) * 100}%"></i>` : '';
    const ago = Math.round((Date.now() - x.mtime) / 3600000);
    return `<li data-session="${escapeHtml(x.file)}" class="${x.file === currentFile ? 'cur' : ''}">
      <span class="ps-title">${escapeHtml(short(x.title || x.file.split('/').pop().slice(0, 8), 30))}</span>
      <span class="ps-bar"><b style="width:${w.toFixed(1)}%"></b>${mark}</span>
      <span class="ps-meta">${kfmt(x.context || 0)} · ${L(`턴 ${x.turns}`, `${x.turns} turns`)}${x.compactions ? L(` · 압축 ${x.compactions}`, ` · ${x.compactions} compacted`) : ''}${x.reclaim ? ` · <em>${L('되찾을 양', 'reclaim')} ${kfmt(x.reclaim)}</em>` : ''} · ${ago < 1 ? L('방금', 'now') : ago < 48 ? L(`${ago}시간 전`, `${ago}h ago`) : L(`${Math.round(ago / 24)}일 전`, `${Math.round(ago / 24)}d ago`)}</span></li>`;
  }).join('');
  const cards = r.findings.map((f0) => {
    const f = { ...f0, items: f0.items.map(loc) };
    const d = describeProject(f, L);
    const chips = f.items.slice(0, 6).map((i) => `<span class="chip"${neurons.has(i.id) ? ` data-id="${escapeHtml(i.id)}"` : ''}>${escapeHtml(short(i.label, 34))} <em>${kfmt(i.tokens)} · ${
      f.type === 'p-loud-shell' ? L(`${i.count}회`, `×${i.count}`) : L(`세션 ${i.count}`, `${i.count} sessions`)}</em></span>`).join('');
    return `<li class="doc ${f.severity}"><div class="doc-title"><span class="sev">${SEV_LABEL[f.severity]}</span>${escapeHtml(d.title)}</div>
      <div class="doc-fix">${escapeHtml(d.fix)}</div><div class="flow">${chips}</div></li>`;
  }).join('');
  $('project-body').innerHTML = `<div class="doc-head">
      <div><b>${r.sessions}</b><span>${L('세션', 'sessions')}</span></div>
      <div><b>${kfmt(r.medianContext || 0)}</b><span>${L('컨텍스트 중앙값', 'median context')}</span></div>
      <div><b>${r.compactions}</b><span>${L('압축', 'compactions')}</span></div>
      <div><b>${kfmt(r.fixed)}</b><span>${L('세션당 고정 비용', 'fixed per session')}</span></div></div>
    <ol class="psessions">${bars}</ol>
    ${cards ? `<ol class="docs">${cards}</ol>` : `<div class="empty">${L('반복되는 낭비가 없습니다', 'no repeated leaks')}</div>`}`;
}
$('project-run').addEventListener('click', runProject);
$('project-body').addEventListener('click', (ev) => {
  const li = ev.target.closest('[data-session]');
  if (!li) return;
  $('follow').checked = false;
  connect(li.dataset.session);
  document.querySelectorAll('.psessions li').forEach((x) => x.classList.toggle('cur', x === li));
  scrollTo({ top: 0, behavior: 'smooth' });
});

function renderBudget() {
  const now = ctxHistory[ctxHistory.length - 1];
  renderRing(now);

  // 면적 지도: 지금 컨텍스트에 남아 있는 항목. 크기는 추정치라 실측과의 차이는 위에 한 줄로 밝힌다
  const live = [...neurons.values()].filter((n) => !n.compacted && n.tokens > 0);
  const groups = lobeNames.map((l) => ({ lobe: l, items: live.filter((n) => n.lobe === l) }))
    .map((g) => ({ ...g, value: g.items.reduce((s, n) => s + n.tokens, 0) })).filter((g) => g.value > 0);
  const est = groups.reduce((s, g) => s + g.value, 0);
  $('map-note').textContent = now
    ? L(`추정 합계 ${kfmt(est)} / 실측 ${kfmt(now)}${now > est ? ` · 차이 ${kfmt(now - est)}는 도구 정의, 대화 틀처럼 로그로 셀 수 없는 부분` : ''}`,
      `estimated ${kfmt(est)} / measured ${kfmt(now)}${now > est ? ` · the ${kfmt(now - est)} gap is what the log cannot see (tool definitions, message framing)` : ''}`)
    : '';
  const box = $('treemap');
  const W = box.clientWidth, H = box.clientHeight;
  let html = '';
  for (const g of squarify(groups, 0, 0, W, H)) {
    const G = g.item;
    const color = hex(LOBE_META[G.lobe].color);
    // 영역 안을 항목별로 다시 나누되, 너무 작은 것은 "그 밖" 하나로 묶는다
    const minArea = 900 * (G.value / (g.w * g.h || 1));
    const big = G.items.filter((n) => n.tokens >= minArea);
    const rest = G.items.filter((n) => n.tokens < minArea);
    const parts = big.map((n) => ({ value: n.tokens, n }));
    const restSum = rest.reduce((s, n) => s + n.tokens, 0);
    if (restSum) parts.push({ value: restSum, rest: rest.length });
    for (const c of squarify(parts, g.x, g.y, g.w, g.h)) {
      const it = c.item;
      if (it.n) {
        const cls = [wasteIds.has(it.n.id) ? 'waste' : '', STANDING.includes(G.lobe) || it.n.turns.has(vt()) ? '' : 'old'].join(' ');
        html += tileHtml(c, cls, it.n.id, `${lobeName(G.lobe)}: ${it.n.label}`, kfmt(it.n.tokens), color);
      } else {
        html += tileHtml(c, 'old', null, `${lobeName(G.lobe)}: ${L(`그 밖 ${it.rest}개`, `${it.rest} more`)}`, kfmt(it.value), color);
      }
    }
  }
  box.innerHTML = html || `<div class="empty" style="padding:12px">${L('아직 컨텍스트 항목이 없습니다', 'no context items yet')}</div>`;
}

function tileHtml(r, cls, id, name, val, color) {
  const big = r.w > 70 && r.h > 30;
  const style = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;${color ? `background:${color}` : ''}`;
  return `<div class="tile ${cls}" style="${style}" ${id ? `data-id="${escapeHtml(id)}"` : ''} title="${escapeHtml(name)} · ${escapeHtml(val)}">
    ${big ? `<b>${escapeHtml(name)}</b><span>${escapeHtml(val)}</span>` : ''}</div>`;
}


// ════════════════════════════════════════════════════════════
// 화면: 보고 있는 턴 (뇌 · 히스토리 띠 · ◀ ▶ 가 고른 턴 하나)
// ════════════════════════════════════════════════════════════
// 옆에서 본 작은 뇌. 그 턴에 쓰인 영역만 색을 칠한다
function miniBrain(tr) {
  const used = {};
  for (const it of tr.items.values()) used[it.n.lobe] = (used[it.n.lobe] || 0) + Math.max(it.tokens, 1);
  used.dialog = 1;
  if (tr.answers.length) used.output = 1;
  const W = 56, H = 40, cx = 29, cy = 19;
  let dots = '';
  for (const l of lobeNames) {
    const a = anchors[l];
    const x = cx - a.z * 21 + a.x * 3.5, y = cy - a.y * 17 + a.x * 1.5;
    const v = used[l];
    const r = v ? Math.min(5.5, 2.2 + Math.log10(1 + v / 200) * 1.6) : 1.4;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${v ? hex(LOBE_META[l].color) : '#3a4560'}"${v ? '' : ' opacity="0.7"'}/>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="M6 22 C4 9 18 2 31 3 C45 4 53 12 51 22 C50 28 44 31 38 31 C33 34 25 35 18 32 C10 31 7 27 6 22 Z" fill="none" stroke="#4a5878" stroke-width="1.2"/>
    <ellipse cx="41" cy="31.5" rx="8" ry="4.5" fill="none" stroke="#4a5878" stroke-width="1"/>${dots}</svg>`;
}

function chip(n, extra = '', cls = '') {
  return `<span class="chip ${cls}" data-id="${escapeHtml(n.id)}"><i class="dot" style="background:${hex(LOBE_META[n.lobe].color)}"></i>
    <span class="nm">${escapeHtml(n.label)}</span>${extra}</span>`;
}

function turnHtml(tr) {
  const items = [...tr.items.values()];
  const byLobe = {};
  for (const it of items) byLobe[it.n.lobe] = (byLobe[it.n.lobe] || 0) + 1;
  const sum = lobeNames.filter((l) => byLobe[l]).map((l) => `<span><i class="dot" style="background:${hex(LOBE_META[l].color)}"></i> ${lobeName(l)} ${byLobe[l]}</span>`).join('');
  const state = tr.done ? `<span class="state done">${L(`완료 ${(tr.ms / 1000).toFixed(1)}초`, `done in ${(tr.ms / 1000).toFixed(1)}s`)}</span>`
    : tr.n === turns.length ? `<span class="state live">${L('진행 중', 'running')}</span>` : `<span class="state">${L('기록 없음', 'no record')}</span>`;
  const flow = tr.steps.map((s) => {
    const n = neurons.get(s.id);
    return chip(n, s.tokens ? `<em>${kfmt(s.tokens)}</em>` : '', s.error ? 'err' : '');
  }).join('<span class="arrow">→</span>');
  // 답변 문장마다 이름이 그대로 나온 근거를 붙인다. 이 턴과 그 전에 다룬 항목이 후보
  const cands = [...neurons.values()].filter((n) => n.lobe !== 'output' && n.lobe !== 'dialog' && [...n.turns].some((t) => t <= tr.n));
  const rows = tr.answers.flatMap(splitSentences).map((s) => ({ s, refs: findRefs(s, cands) }));
  const all = showAll.has(tr.n);
  const shown = all ? rows : rows.slice(0, ANSWER_LINES);
  const hits = rows.filter((r) => r.refs.length).length;
  const answer = rows.length ? `<ul class="answer">${shown.map((r) => `<li class="${r.refs.length ? 'hit' : ''}"><span class="s">${escapeHtml(r.s)}</span>
      ${r.refs.length ? `<span class="refs">${r.refs.map((id) => chip(neurons.get(id))).join('')}</span>` : ''}</li>`).join('')}</ul>
    ${rows.length > ANSWER_LINES ? `<button class="more" data-more="${tr.n}">${all ? L('접기', 'collapse') : L(`전체 ${rows.length}문장 보기`, `show all ${rows.length} sentences`)}</button>` : ''}`
    : `<div class="empty">${L('아직 답변이 없습니다', 'no answer yet')}</div>`;
  const cut = compactions.filter((c) => c.afterTurn === tr.n).map((c) =>
    `<div class="compact-row">${L(`이 턴 뒤 압축 · 직전 ${fmt(c.tokens)} 토큰. 파일 · 셸 · 웹 결과가 컨텍스트에서 빠졌습니다`, `Compacted after this turn at ${fmt(c.tokens)} tokens. File, shell and web results left the context`)}</div>`).join('');
  return `<div class="turn viewing">
    <div class="turn-head">${miniBrain(tr)}
      <div class="turn-title"><span class="prompt"><span class="no">#${tr.n}</span>${escapeHtml(tr.prompt)}</span><span class="sum">${sum || L('도구 사용 없음', 'no tools')}</span></div>
      <div class="turn-meta">${state}<br>${clock2(tr.t)} · +${kfmt(tr.added)}${tr.ctxEnd ? ` · ${L('컨텍스트', 'context')} ${kfmt(tr.ctxEnd)}` : ''}</div>
    </div>
    <div class="turn-body">
      <div class="sec"><div class="sec-label">${L('흐름 (도구 호출 순서 · 숫자 = 결과로 들어온 토큰)', 'Flow (tool calls in order · number = tokens returned)')}</div>
        <div class="flow">${flow || `<span class="empty">${L('도구를 쓰지 않았습니다', 'no tools used')}</span>`}</div></div>
      <div class="sec"><div class="sec-label">${L('답변과 근거', 'Answer and evidence')} ${rows.length ? L(`· ${rows.length}문장 중 ${hits}문장에 근거 이름이 나옴`, `· ${hits} of ${rows.length} sentences name a source`) : ''}</div>${answer}</div>
    </div>${cut}</div>`;
}

function renderTimeline() {
  const tr = turns[vt() - 1];
  $('turns').innerHTML = tr ? turnHtml(tr) : `<div class="empty">${L('아직 사용자 입력이 없습니다', 'no prompts yet')}</div>`;
}

function renderTurnLabel() {
  const no = vt();
  $('turn-label').textContent = turns.length ? (viewTurn ? L(`턴 #${no} / ${turns.length}`, `turn #${no} / ${turns.length}`) : L(`지금 턴 #${no}`, `now: turn #${no}`)) : L('턴 없음', 'no turns');
  $('turn-prev').disabled = no <= 1;
  $('turn-next').disabled = !viewTurn;
}

// ════════════════════════════════════════════════════════════
// 화면: 상세 (뇌 위 오른쪽)
// ════════════════════════════════════════════════════════════
function renderDetail() {
  const box = $('detail');
  if (!selected) { box.hidden = true; return; }
  if (selected.lobe) {
    const l = selected.lobe;
    const list = [...neurons.values()].filter((n) => n.lobe === l).sort((a, b) => (a.compacted - b.compacted) || (b.tokens - a.tokens));
    const total = list.filter((n) => !n.compacted).reduce((s, n) => s + n.tokens, 0);
    box.innerHTML = `<button class="close" aria-label="닫기">×</button>
      <div class="d-lobe" style="color:${hex(LOBE_META[l].color)}">${L('영역', 'Region')}</div>
      <h3>${lobeName(l)}</h3>
      <div class="d-stats">${L(`${list.length}개 · 컨텍스트에 남은 양 약 ${fmt(total)} 토큰`, `${list.length} items · ~${fmt(total)} tokens still in context`)}</div>
      <ol class="l-items">${list.map((n) => `<li data-id="${escapeHtml(n.id)}" class="${n.compacted ? 'off' : ''} ${wasteIds.has(n.id) ? 'waste' : ''}">
        <span>${escapeHtml(n.label)}</span><em>${n.compacted ? L('압축됨', 'compacted') : kfmt(n.tokens)}${n.lastTurn ? ` · #${n.lastTurn}` : ''}</em></li>`).join('') || `<li>${L('항목 없음', 'no items')}</li>`}</ol>`;
  } else {
    const n = selected.n;
    const counts = Object.entries(n.counts).map(([k, v]) => L(`${KIND_LABEL[k] || k} ${v}회`, `${KIND_LABEL[k] || k} ×${v}`)).join(' · ');
    const rows = n.history.slice().reverse().map((e) => `<li><div class="d-head"><span class="kind">${KIND_LABEL[e.kind] || e.kind}</span>${clock2(e.t)}
        ${e.tokens ? L(` · 약 ${fmt(e.tokens)} 토큰`, ` · ~${fmt(e.tokens)} tokens`) : ''}${e.error ? ` · <b class="err">${L('오류', 'error')}</b>` : ''}${e.tool ? ' · ' + e.tool : ''}</div>
        ${e.input ? `<pre>${escapeHtml(e.input)}</pre>` : e.detail ? `<div class="d-note">${escapeHtml(detailOf(e.detail))}</div>` : ''}
        ${e.preview ? `<pre class="out">${escapeHtml(e.preview)}</pre>` : ''}</li>`).join('');
    const usedIn = [...n.turns].sort((a, b) => a - b).map((t) => '#' + t).join(' ');
    box.innerHTML = `<button class="close" aria-label="닫기">×</button>
      <div class="d-lobe" style="color:${hex(LOBE_META[n.lobe].color)}">${lobeName(n.lobe)}</div>
      <h3>${escapeHtml(n.label)}</h3>
      <div class="d-stats">${counts} · ${L(`약 ${fmt(n.tokens)} 토큰`, `~${fmt(n.tokens)} tokens`)}${n.compacted ? L(' · 압축으로 컨텍스트에서 빠짐', ' · dropped from context by compaction') : ''}${wasteIds.has(n.id) ? L(' · 다시 안 쓰임', ' · never used again') : ''}${usedIn ? ` · ${L('쓰인 턴', 'used in turns')} ${usedIn}` : ''}</div>
      <ol class="d-list">${rows}</ol>`;
  }
  box.querySelector('.close').addEventListener('click', () => { selected = null; renderDetail(); });
  box.hidden = false;
}

// 이벤트가 몰려 들어와도 화면은 0.25초에 한 번만 다시 그린다
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (byModel) { compactInfo = window.CBModel.pickCompact(byModel, curModel); compactAt = compactInfo.at; }
    renderDoctor();        // 링이 되찾을 양을 보여 주므로 예산보다 먼저
    renderBudget();
    brain.refresh();
    renderTimeline();
    renderTurnLabel();
    drawStrip();
    if (selected) renderDetail();
  }, 250);
}
new ResizeObserver(scheduleRender).observe($('treemap'));

// ════════════════════════════════════════════════════════════
// 재생: 세션을 처음부터 다시 흘려 본다
// ════════════════════════════════════════════════════════════
let allEvents = [];        // 이 세션의 모든 이벤트. player.i 까지가 화면에 반영돼 있다
const player = { on: false, i: 0, timer: null };
const atHead = () => !player.on && player.i === allEvents.length;

function applyUpTo(k) {
  reset();
  for (let j = 0; j < k; j++) applyEvent(allEvents[j], false);
  player.i = k;
  scheduleRender();
  renderPlayer();
}
function step() {
  if (player.i >= allEvents.length) { stopPlay(); return; }
  const e = allEvents[player.i++];
  applyEvent(e, true);
  scheduleRender();
  renderPlayer();
  const next = allEvents[player.i];
  const gap = next && e.t && next.t ? (new Date(next.t) - new Date(e.t)) / Number($('speed').value) : 0;
  player.timer = setTimeout(step, Math.max(25, Math.min(1500, gap || 0)));
}
function startPlay() {
  if (player.i >= allEvents.length) applyUpTo(0);
  player.on = true;
  step();
}
function stopPlay() {
  player.on = false;
  clearTimeout(player.timer);
  renderPlayer();
}
function renderPlayer() {
  const total = allEvents.length;
  $('play').textContent = player.on ? L('❚❚ 멈춤', '❚❚ Pause') : player.i >= total ? L('▶ 처음부터 재생', '▶ Replay') : L('▶ 이어서 재생', '▶ Resume');
  $('to-live').hidden = player.i >= total;
  $('player').classList.toggle('rewound', player.i < total);
  const sm = sampleAt(player.i);
  const s = series().samples;
  $('play-time').textContent = player.i >= total
    ? L(`지금 · API 호출 ${s.length}번 · 턴 ${turns.length}`, `now · ${s.length} API calls · ${turns.length} turns`)
    : `${clock2(sm && sm.t)} · ${L(`턴 #${turns.length} · ${kfmt(sm ? sm.ctx : 0)} 토큰 · 되돌아본 시점`, `turn #${turns.length} · ${kfmt(sm ? sm.ctx : 0)} tokens · looking back`)}`;
  drawStripCursor();
}
$('play').addEventListener('click', () => (player.on ? stopPlay() : startPlay()));
$('to-live').addEventListener('click', () => { stopPlay(); applyUpTo(allEvents.length); });

// ════════════════════════════════════════════════════════════
// 컨텍스트 히스토리 띠: API 호출마다 영역별 크기를 쌓아 그린다.
// 마우스를 올리면 그 호출 직전에 무엇이 들어왔는지, 누르면 뇌가 그 시점으로 돌아간다.
// ════════════════════════════════════════════════════════════
const STRIP_ORDER = ['system', 'rules', 'abilities', 'memory', 'skills', 'mcp', 'agents', 'web', 'files', 'shell', 'dialog', 'output'];
let seriesCache = { n: -1, v: null };
function series() {
  if (seriesCache.n !== allEvents.length) seriesCache = { n: allEvents.length, v: window.CBModel.contextSeries(allEvents) };
  return seriesCache.v;
}
// player.i 시점에 화면에 반영된 마지막 표본
function sampleIndexAt(i) {
  const s = series().samples;
  let lo = -1;
  for (let k = 0; k < s.length && s[k].i < i; k++) lo = k;
  return lo;
}
const sampleAt = (i) => series().samples[sampleIndexAt(i)] || null;

const strip = { w: 0, h: 84, top: 14, bottom: 14, x: null, key: '' };
function drawStrip() {
  const svg = $('strip');
  const { samples, turns: tlist, compactions } = series();
  const w = Math.max(100, svg.clientWidth);
  const key = `${samples.length}:${w}:${compactAt}:${lang}`;
  if (key === strip.key) { drawStripCursor(); return; }
  strip.key = key;
  strip.w = w;
  svg.setAttribute('viewBox', `0 0 ${w} ${strip.h}`);
  if (samples.length < 2) {
    svg.innerHTML = `<text x="8" y="44">${L('API 호출이 두 번 이상 쌓이면 그려집니다', 'appears after two API calls')}</text>`;
    return;
  }
  const n = samples.length;
  const maxV = Math.max(...samples.map((x) => Math.max(x.ctx, x.est)), compactAt && compactAt < 1.6 * Math.max(...samples.map((x) => x.ctx)) ? compactAt : 0);
  const plotH = strip.h - strip.top - strip.bottom;
  const X = (k) => (k / (n - 1)) * (w - 2) + 1;
  const Y = (v) => strip.top + plotH - (v / maxV) * plotH;
  strip.x = X;
  let html = '';
  // 영역별 추정을 쌓은 띠
  const base = new Array(n).fill(0);
  for (const l of STRIP_ORDER) {
    if (!samples.some((x) => x.lobes[l])) continue;
    const upper = samples.map((x, k) => base[k] + (x.lobes[l] || 0));
    const pts = upper.map((v, k) => `${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const back = base.map((v, k) => `${X(k).toFixed(1)},${Y(v).toFixed(1)}`).reverse().join(' ');
    html += `<polygon points="${pts} ${back}" fill="${hex(LOBE_META[l].color)}" fill-opacity="0.5"/>`;
    upper.forEach((v, k) => (base[k] = v));
  }
  // 위쪽 글자들이 겹치지 않게 차지한 가로 구간을 기억한다
  const taken = [];
  const free = (x0, x1) => taken.every(([a, b]) => x1 < a - 6 || x0 > b + 6);
  const textW = (str) => [...str].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 10 : 5.8), 0);
  // 실측 크기 선, 압축 기준
  html += `<polyline points="${samples.map((x, k) => `${X(k).toFixed(1)},${Y(x.ctx).toFixed(1)}`).join(' ')}" fill="none" stroke="#fff" stroke-width="1.4"/>`;
  if (compactAt && compactAt <= maxV) {
    html += `<line x1="0" x2="${w}" y1="${Y(compactAt)}" y2="${Y(compactAt)}" stroke="#ff8a8a" stroke-dasharray="4 4" stroke-opacity="0.7"/>
      <text class="cmp" x="${w - 4}" y="${Y(compactAt) - 3}" text-anchor="end">${L('압축 기준', 'compaction point')} ${kfmt(compactAt)}</text>`;
    const cw = textW(`${L('압축 기준', 'compaction point')} ${kfmt(compactAt)}`);
    taken.push([w - 4 - cw, w]);
  }
  // 턴 경계: 번호가 겹치면 건너뛴다
  let lastTick = -Infinity;
  for (const t of tlist) {
    const x = X(Math.min(n - 1, t.at));
    html += `<line x1="${x}" x2="${x}" y1="${strip.top}" y2="${strip.h - strip.bottom}" stroke="#fff" stroke-opacity="0.08"/>`;
    if (x - lastTick >= 30) { html += `<text class="tick" x="${x + 2}" y="${strip.h - 3}">#${t.n}</text>`; lastTick = x; }
  }

  // 압축 지점
  for (const c of compactions) {
    const x = X(Math.min(n - 1, c.at));
    const label = `${L('압축', 'compacted')} ${kfmt(c.tokens)}`;
    html += `<line x1="${x}" x2="${x}" y1="${strip.top - 4}" y2="${strip.h - strip.bottom}" stroke="#ff5a5a" stroke-width="2"/>
      <text class="cmp" x="${x + 3}" y="10">${label}</text>`;
    taken.push([x, x + 3 + textW(label)]);
  }
  // 가장 크게 불어난 지점에 이름표
  for (const { k, s: x } of window.CBModel.growthSpikes(samples, Math.max(2, Math.floor(w / 220)), Math.ceil(n / 12))) {
    const top = x.added[0];
    const name = top && top.tokens > x.delta * 0.25 ? short(lang === 'en' ? labelEn(top.id, top.label) : top.label, 22) : L('응답 생성', 'response');
    const label = `+${kfmt(x.delta)} ${name}`;
    const lw = textW(label);
    const anchor = X(k) + lw > w - 4 ? 'end' : 'start';
    const x0 = anchor === 'end' ? X(k) - 4 - lw : X(k) + 4;
    html += `<circle cx="${X(k)}" cy="${Y(x.ctx)}" r="2.5" fill="#fff"/>`;
    if (!free(x0, x0 + lw)) continue;
    taken.push([x0, x0 + lw]);
    html += `<text class="spike" x="${anchor === 'end' ? X(k) - 4 : X(k) + 4}" y="${Math.max(10, Y(x.ctx) - 4)}" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
  }
  html += `<rect id="strip-dim" y="0" height="${strip.h}" fill="#03050a" fill-opacity="0.6"/>
    <line id="strip-cursor" y1="0" y2="${strip.h}" stroke="#7dd3ff" stroke-width="2"/>
    <line id="strip-hover" y1="0" y2="${strip.h}" stroke="#fff" stroke-opacity="0.5" visibility="hidden"/>`;
  svg.innerHTML = html;
  drawStripCursor();
}
function drawStripCursor() {
  const cur = $('strip-cursor');
  if (!cur || !strip.x) return;
  const n = series().samples.length;
  const k = player.i >= allEvents.length ? n - 1 : Math.max(0, sampleIndexAt(player.i));
  const x = strip.x(k);
  cur.setAttribute('x1', x); cur.setAttribute('x2', x);
  const dim = $('strip-dim');
  dim.setAttribute('x', x); dim.setAttribute('width', Math.max(0, strip.w - x));
}
function stripSample(ev) {
  const s = series().samples;
  if (s.length < 2) return -1;
  const r = $('strip').getBoundingClientRect();
  return Math.max(0, Math.min(s.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (s.length - 1))));
}
function stripTip(k) {
  const x = series().samples[k];
  const rows = x.added.map((a) => `<span><i class="dot" style="background:${hex(LOBE_META[a.lobe] ? LOBE_META[a.lobe].color : 0x888888)}"></i>${
    escapeHtml(short(lang === 'en' ? labelEn(a.id, a.label) : a.label, 34))} <em>+${kfmt(a.tokens)}</em></span>`).join('');
  const hidden = x.delta - x.addedTotal;
  return `<b>${L(`턴 #${x.turn}`, `turn #${x.turn}`)} · ${clock2(x.t)} · ${kfmt(x.ctx)} ${L('토큰', 'tokens')}</b>
    <span>${L('구성', 'made of')}: ${Object.entries(x.lobes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, v]) => `${lobeName(l)} ${kfmt(v)}`).join(' · ')}</span>
    <span>${x.delta >= 0 ? '+' : ''}${kfmt(x.delta)} ${L('직전 호출 대비', 'since the previous call')}</span>${rows}
    ${hidden > 500 ? `<span>${L(`+${kfmt(hidden)} 응답 생성 등 로그에 내용이 없는 증가`, `+${kfmt(hidden)} response generation and other growth the log has no content for`)}</span>` : ''}
    <span>${L('누르면 뇌가 이 시점으로', 'click to see the brain at this point')}</span>`;
}
$('strip').addEventListener('mousemove', (ev) => {
  const k = stripSample(ev);
  if (k < 0) return;
  const hv = $('strip-hover');
  if (hv) { hv.setAttribute('x1', strip.x(k)); hv.setAttribute('x2', strip.x(k)); hv.setAttribute('visibility', 'visible'); }
  showTip(ev, stripTip(k));
});
$('strip').addEventListener('mouseleave', () => { hideTip(); const hv = $('strip-hover'); if (hv) hv.setAttribute('visibility', 'hidden'); });
$('strip').addEventListener('click', (ev) => {
  const k = stripSample(ev);
  if (k < 0) return;
  stopPlay();
  const s = series().samples;
  applyUpTo(k === s.length - 1 ? allEvents.length : s[k].i + 1);
});
// ← → 로 API 호출 한 번씩 이동
addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, select, textarea') || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
  const s = series().samples;
  if (s.length < 2) return;
  ev.preventDefault();
  stopPlay();
  const cur = player.i >= allEvents.length ? s.length - 1 : Math.max(0, sampleIndexAt(player.i));
  const k = Math.max(0, Math.min(s.length - 1, cur + (ev.key === 'ArrowRight' ? 1 : -1)));
  applyUpTo(k === s.length - 1 ? allEvents.length : s[k].i + 1);
});
new ResizeObserver(() => drawStrip()).observe($('strip'));

// ════════════════════════════════════════════════════════════
// 세션 연결
// ════════════════════════════════════════════════════════════
let source = null;
let currentFile = null;

function reset() {
  brain.clear();
  neurons.clear();
  turns = [];
  compactions = [];
  ctxHistory = [];
  curModel = null;
  selected = null;
  viewTurn = null;
  wasteIds = new Set();
  showAll.clear();
  renderDetail();
}

function connect(file) {
  if (source) source.close();
  $('status').textContent = L('연결 중…', 'connecting…');
  source = new EventSource('/api/stream?file=' + encodeURIComponent(file || 'latest'));
  source.addEventListener('replay', (m) => {
    const data = JSON.parse(m.data);
    reset();
    LOBE_NAMES = data.lobes;
    currentFile = data.file;
    $('session').value = currentFile;
    stopPlay();
    allEvents = data.events;
    applyUpTo(allEvents.length);
    $('status').textContent = L(`기록 ${data.events.length}개 불러옴`, `${data.events.length} events loaded`);
  });
  source.addEventListener('events', (m) => {
    const head = atHead();
    allEvents.push(...JSON.parse(m.data));
    if (head) {
      for (; player.i < allEvents.length; player.i++) applyEvent(allEvents[player.i], true);
      scheduleRender();
      $('status').textContent = `${L('실시간', 'live')} · ${clock2(Date.now())}`;
    } else $('status').textContent = L('재생 중 · 새 기록은 재생이 끝나면 이어서 반영', 'replaying · new events will follow when the replay ends');
    renderPlayer();
  });
  source.onerror = () => { $('status').textContent = L('연결 끊김 · 다시 시도 중', 'disconnected · retrying'); };
}

async function refreshSessions() {
  const list = await fetch('/api/sessions').then((r) => r.json()).catch(() => []);
  const sel = $('session');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.file;
    const ago = Math.round((Date.now() - s.mtime) / 60000);
    const proj = s.project.replace(/^-Users-[^-]+-/, '').slice(-28);
    o.textContent = `${s.title || s.file.split('/').pop().slice(0, 8)} · ${proj} · ${ago < 1 ? L('방금', 'just now') : L(ago + '분 전', ago + ' min ago')}`;
    sel.appendChild(o);
  }
  sel.value = currentFile || keep;
  if ($('follow').checked && list[0] && currentFile && list[0].file !== currentFile) connect(list[0].file);
}

$('session').addEventListener('change', (ev) => { $('follow').checked = false; connect(ev.target.value); });
$('follow').addEventListener('change', (ev) => { if (ev.target.checked) refreshSessions(); });

$('export').addEventListener('click', () => {
  if (!currentFile) return;
  location.href = '/api/export?file=' + encodeURIComponent(currentFile) + ($('redact').checked ? '&redact=1' : '');
});

window.CBLang.apply();
$('brain-size').textContent = L('크게', 'Bigger');
$('lang').textContent = L('English', '한국어');
$('lang').addEventListener('click', () => window.CBLang.set(L('en', 'ko')));
renderPlayer();

// 공유된 HTML 은 기록을 품고 있다. 서버 없이 처음부터 재생한다
const embedded = $('cb-data');
if (embedded) {
  const d = JSON.parse(embedded.textContent);
  document.body.classList.add('static');
  LOBE_NAMES = d.lobes || {};
  compactAt = d.compactAt || null;
  compactInfo = { at: compactAt, range: d.compactRange || null, n: d.compactN || 0 };
  allEvents = (d.variants && d.variants[lang]) || d.events || [];
  const title = (d.titles && d.titles[lang]) || d.title;
  $('status').textContent = title ? `${L('공유된 세션', 'Shared session')} · ${title}` : L('공유된 세션', 'Shared session');
  if (d.autoplay) { applyUpTo(0); setTimeout(startPlay, 800); } else applyUpTo(allEvents.length);
} else {
  fetch('/api/limits').then((r) => r.json()).then((l) => { byModel = l.byModel || {}; scheduleRender(); }).catch(() => {});
  refreshSessions().then(() => connect('latest'));
  setInterval(refreshSessions, 5000);
}
