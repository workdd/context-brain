import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const { squarify, splitSentences, findRefs, wasteCandidates } = window.CBModel;

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
const KIND_LABEL = { use: '사용', result: '결과', load: '로드', ref: '언급' };
const KIND_WEIGHT = { use: 1.2, result: 0.9, load: 0.7, ref: 1.0 };
const HISTORY_MAX = 40;
const ANSWER_LINES = 8;
let LOBE_NAMES = {};

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + new THREE.Color(c).getHexString();
const fmt = (n) => Math.round(n || 0).toLocaleString('ko-KR');
const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(Math.round(n || 0)));
const clock2 = (t) => (t ? new Date(t).toLocaleTimeString('en-GB') : '');
const lobeName = (l) => LOBE_NAMES[l] || l;
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
let ctxModel = '';
let compactAt = null;
let viewTurn = null;       // 사용자가 고른 턴 번호. null 이면 지금 턴
let selected = null;
const openTurns = new Set();
const closedTurns = new Set();
const showAll = new Set();

const curTurn = () => turns[turns.length - 1] || null;

function getNeuron(e) {
  let n = neurons.get(e.id);
  if (n) return n;
  n = { id: e.id, lobe: e.lobe, label: e.label, act: 0, tokens: 0, counts: {}, compacted: false,
    history: [], turns: new Set(), lastTurn: 0, mesh: null };
  neurons.set(e.id, n);
  brain.addNeuron(n);
  return n;
}

function startTurn(e) {
  turns.push({ n: turns.length + 1, prompt: e.label, t: e.t, steps: [], answers: [], items: new Map(), added: 0, done: false, ms: 0, ctxEnd: null });
}

function trackTurn(e, n) {
  const tr = curTurn();
  if (!tr) return;
  const counted = e.kind !== 'load' || e.lobe === 'skills';
  if (!counted) return;
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
    if (ctxHistory.length > 120) ctxHistory.shift();
    ctxModel = e.model || ctxModel;
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
  n.label = e.label || n.label;
  n.counts[e.kind] = (n.counts[e.kind] || 0) + 1;
  if (n.compacted && e.kind !== 'ref') { n.compacted = false; n.tokens = 0; } // 압축 뒤 다시 들어온 것은 새로 센다
  if (e.tokens) n.tokens = e.kind === 'load' ? Math.max(n.tokens, e.tokens) : n.tokens + e.tokens;
  n.history.push(e);
  if (n.history.length > HISTORY_MAX) n.history.shift();
  trackTurn(e, n);
  if (live) {
    n.act = Math.min(1.4, n.act + (KIND_WEIGHT[e.kind] || 0.8));
    brain.pulse(e, n);
  }
}

// ════════════════════════════════════════════════════════════
// 3D 뇌 (미니맵)
// ════════════════════════════════════════════════════════════
const brain = (() => {
  const stage = $('stage');
  const size = () => [Math.max(1, stage.clientWidth), Math.max(1, stage.clientHeight)];
  const [w0, h0] = size();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, w0 / h0, 0.05, 50);
  camera.position.set(3.4, 0.85, 1.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w0, h0);
  stage.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(w0, h0);
  Object.assign(labels.domElement.style, { position: 'absolute', top: '0', pointerEvents: 'none', display: 'none' });
  stage.appendChild(labels.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  controls.minDistance = 1.4;
  controls.maxDistance = 7;
  controls.enableZoom = false;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(w0, h0), 0.55, 0.45, 0.5));
  composer.addPass(new OutputPass());

  // 표면 점 구름: 대뇌 두 반구 + 소뇌 + 뇌간
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
    size: 0.013, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
  })));

  const pointLobe = new Int16Array(count).fill(-1);
  const pointWeight = new Float32Array(count);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.fromArray(pts, i * 3);
    let best = -1, bd = Infinity;
    lobeNames.forEach((l, li) => { const d = p.distanceTo(anchors[l]); if (d < bd) { bd = d; best = li; } });
    const reach = LOBE_META[lobeNames[best]].inner ? 0.5 : 0.62;
    if (bd < reach) { pointLobe[i] = best; pointWeight[i] = (1 - bd / reach) ** 1.5; }
  }

  const lobeState = {};
  for (const l of lobeNames) {
    const el = document.createElement('div');
    el.className = 'lobe-label';
    const obj = new CSS2DObject(el);
    obj.position.copy(LOBE_META[l].inner ? anchors[l] : anchors[l].clone().multiplyScalar(1.17));
    scene.add(obj);
    lobeState[l] = { act: 0, hold: 0, el, color: new THREE.Color(LOBE_META[l].color) };
  }

  const neuronGeo = new THREE.SphereGeometry(1, 16, 12);
  const group = new THREE.Group();
  scene.add(group);
  const radiusFor = (tokens) => Math.min(0.065, 0.013 + 0.011 * Math.log10(1 + tokens / 40));

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
  }

  // 신호선
  const pulses = [];
  const dotGeo = new THREE.SphereGeometry(0.012, 8, 6);
  const curve = (a, b) => new THREE.QuadraticBezierCurve3(a.clone(), a.clone().add(b).multiplyScalar(0.225), b.clone());
  function spawn(from, to, color) {
    if (pulses.length > 70) return;
    const c = curve(from, to);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.getPoints(32)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.3), toneMapped: false }));
    scene.add(line, dot);
    pulses.push({ c, line, dot, age: 0, life: 1.1 });
  }
  function pulse(e, n) {
    if (e.lobe === 'output') return;
    if (e.kind === 'use') spawn(anchors.output, n.mesh.position, LOBE_META[e.lobe].color);
    else if (e.kind === 'result' || e.kind === 'ref') spawn(n.mesh.position, anchors.output, 0xffffff);
  }

  // 보고 있는 턴의 경로는 켜 둔다
  let paths = [];
  function showTurn(no) {
    for (const l of paths) { scene.remove(l); l.geometry.dispose(); l.material.dispose(); }
    paths = [];
    if (!no) return;
    for (const n of neurons.values()) {
      if (!n.turns.has(no) || n.lobe === 'output') continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve(anchors.output, n.mesh.position).getPoints(32)),
        new THREE.LineBasicMaterial({ color: LOBE_META[n.lobe].color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
      scene.add(line);
      paths.push(line);
    }
  }

  function clear() {
    for (const n of neurons.values()) { group.remove(n.mesh); n.mesh.material.dispose(); }
    showTurn(null);
  }

  let flashV = 0;
  const flash = () => { flashV = 1; };

  // 클릭 · 툴팁
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
  renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; controls.autoRotate = false; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
    const n = pick(ev);
    if (n) select(n);
  });
  renderer.domElement.addEventListener('pointermove', (ev) => {
    const n = pick(ev);
    if (n) showTip(ev, `<b>${lobeName(n.lobe)}: ${escapeHtml(n.label)}</b><span>약 ${fmt(n.tokens)} 토큰${n.compacted ? ' · 압축으로 빠짐' : ''} · 클릭하면 자세히</span>`);
    else hideTip();
  });
  renderer.domElement.addEventListener('pointerleave', hideTip);

  function resize() {
    const [w, h] = size();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    labels.setSize(w, h);
  }
  new ResizeObserver(resize).observe(stage);
  const setLabels = (on) => { labels.domElement.style.display = on ? '' : 'none'; };

  const clk = new THREE.Clock();
  const tmp = new THREE.Color();
  const BASE = new THREE.Color(0x3a4a6a).multiplyScalar(0.55);
  const GREY = new THREE.Color(0x55607a);
  const FLASH = new THREE.Color(0xff5050);
  let dirty = true;
  function frame() {
    const dt = Math.min(clk.getDelta(), 0.1);
    const decay = Math.exp(-dt / 3.5);
    flashV *= Math.exp(-dt / 0.6);
    const vt = viewTurn || turns.length;
    for (const l of lobeNames) { lobeState[l].act = 0; lobeState[l].hold = 0; }
    for (const n of neurons.values()) {
      n.act *= decay;
      const hold = !n.compacted && n.turns.has(vt) ? 0.45 : 0;
      const ls = lobeState[n.lobe];
      ls.act = Math.max(ls.act, n.act);
      ls.hold = Math.max(ls.hold, hold);
      n.mesh.scale.setScalar(radiusFor(n.tokens) * (1 + 0.35 * Math.min(n.act + hold, 1.5)));
      if (n.compacted) { n.mesh.material.color.copy(GREY).multiplyScalar(0.35 + n.act); n.mesh.material.opacity = 0.45; }
      else { n.mesh.material.color.copy(ls.color).multiplyScalar(0.25 + 0.8 * (n.act + hold)); n.mesh.material.opacity = 1; }
    }
    const busy = flashV > 0.01 || lobeNames.some((l) => lobeState[l].act > 0.01 || lobeState[l].hold > 0.01);
    if (busy || dirty) {
      for (let i = 0; i < count; i++) {
        tmp.copy(BASE);
        const li = pointLobe[i];
        if (li >= 0) {
          const ls = lobeState[lobeNames[li]];
          const a = Math.max(ls.act, ls.hold * 0.6);
          if (a > 0.01) tmp.lerp(ls.color, Math.min(1, a * pointWeight[i] * 0.6)).multiplyScalar(1 + a * pointWeight[i] * 0.6);
        }
        if (flashV > 0.01) tmp.lerp(FLASH, flashV * 0.5);
        colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
      }
      geo.attributes.color.needsUpdate = true;
    }
    dirty = busy;
    for (const l of lobeNames) {
      const s = lobeState[l];
      s.el.textContent = lobeName(l);
      s.el.style.opacity = String(0.45 + Math.min(0.55, s.act + s.hold));
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i];
      q.age += dt;
      const k = q.age / q.life;
      q.dot.position.copy(q.c.getPoint(Math.min(1, k)));
      q.line.material.opacity = 0.35 * (1 - k);
      if (k >= 1) { scene.remove(q.line, q.dot); q.line.geometry.dispose(); q.line.material.dispose(); q.dot.material.dispose(); pulses.splice(i, 1); }
    }
    controls.update();
    composer.render();
    labels.render(scene, camera);
    requestAnimationFrame(frame);
  }
  frame();

  return { addNeuron, pulse, flash, showTurn, clear, setLabels, resize };
})();

$('brain-size').addEventListener('click', () => {
  const big = $('brainbox').classList.toggle('big');
  $('brain-size').textContent = big ? '작게' : '크게';
  brain.setLabels(big);
});
addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && $('brainbox').classList.contains('big')) $('brain-size').click(); });

// ════════════════════════════════════════════════════════════
// 툴팁 · 선택
// ════════════════════════════════════════════════════════════
const tip = $('tip');
function showTip(ev, html) {
  tip.innerHTML = html;
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - 330) + 'px';
  tip.style.top = ev.clientY + 14 + 'px';
  tip.hidden = false;
}
function hideTip() { tip.hidden = true; }

function select(n) {
  selected = n;
  n.act = Math.max(n.act, 1);
  renderDetail();
  $('detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setViewTurn(no) {
  viewTurn = no && no !== turns.length ? no : null;
  brain.showTurn(viewTurn || turns.length);
  $('brain-title').textContent = viewTurn ? `컨텍스트 뇌 · 턴 #${viewTurn}` : '컨텍스트 뇌';
  scheduleRender();
}

// 클릭 위임: data-id 는 뉴런, data-turn 은 턴
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-id]');
  if (t && neurons.has(t.dataset.id)) { select(neurons.get(t.dataset.id)); return; }
  const more = ev.target.closest('[data-more]');
  if (more) { const no = Number(more.dataset.more); showAll.has(no) ? showAll.delete(no) : showAll.add(no); scheduleRender(); return; }
  const view = ev.target.closest('[data-view]');
  if (view) { setViewTurn(Number(view.dataset.view)); return; }
  const head = ev.target.closest('[data-turn]');
  if (head) {
    const no = Number(head.dataset.turn);
    if (isOpen(no)) { closedTurns.add(no); openTurns.delete(no); } else { openTurns.add(no); closedTurns.delete(no); }
    scheduleRender();
  }
});
document.addEventListener('mouseover', (ev) => {
  const t = ev.target.closest('[data-id]');
  if (!t || !neurons.has(t.dataset.id) || t.closest('#stage')) return;
  const n = neurons.get(t.dataset.id);
  n.act = Math.max(n.act, 0.8); // 화면 목록에 올린 항목을 뇌에서도 짚어 준다
});

// ════════════════════════════════════════════════════════════
// 화면: 예산 · 면적 지도 · 낭비 후보
// ════════════════════════════════════════════════════════════
function renderBudget() {
  const now = ctxHistory[ctxHistory.length - 1];
  $('ctx').textContent = now != null ? `${fmt(now)} 토큰` : '-';
  const fill = $('gauge-fill');
  const note = $('gauge-note');
  if (now != null && compactAt) {
    const r = Math.min(1, now / compactAt);
    fill.style.width = (r * 100).toFixed(1) + '%';
    fill.style.background = r > 0.85 ? 'var(--bad)' : r > 0.65 ? 'var(--warn)' : 'var(--good)';
    note.innerHTML = `압축 기준 약 <b>${kfmt(compactAt)}</b> (최근 세션에서 실제 압축이 일어난 크기) · 남은 양 약 <b>${kfmt(Math.max(0, compactAt - now))}</b> · ${Math.round(r * 100)}%`;
  } else {
    fill.style.width = '0';
    note.textContent = now == null ? '아직 API 사용량 기록이 없습니다' : '최근 세션에서 압축이 일어난 적이 없어 압축 기준을 모릅니다';
  }
  drawSpark();

  // 면적 지도: 지금 컨텍스트에 남아 있는 항목. 크기는 추정치라 실측과 차이는 회색 타일로 둔다
  const live = [...neurons.values()].filter((n) => !n.compacted && n.tokens > 0);
  const waste = wasteCandidates(live, turns.length);
  const wasteIds = new Set(waste.map((n) => n.id));
  const groups = lobeNames.map((l) => ({ lobe: l, items: live.filter((n) => n.lobe === l) }))
    .map((g) => ({ ...g, value: g.items.reduce((s, n) => s + n.tokens, 0) })).filter((g) => g.value > 0);
  const est = groups.reduce((s, g) => s + g.value, 0);
  $('map-note').textContent = now
    ? `추정 합계 ${kfmt(est)} / 실측 ${kfmt(now)}${now > est ? ` · 차이 ${kfmt(now - est)}는 도구 정의, 대화 틀, 한글 과소 추정처럼 로그로 셀 수 없는 부분` : ''}`
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
        const cls = [wasteIds.has(it.n.id) ? 'waste' : '', STANDING.includes(G.lobe) || it.n.turns.has(viewTurn || turns.length) ? '' : 'old'].join(' ');
        html += tileHtml(c, cls, it.n.id, `${lobeName(G.lobe)}: ${it.n.label}`, kfmt(it.n.tokens), color);
      } else {
        html += tileHtml(c, 'old', null, `${lobeName(G.lobe)}: 그 밖 ${it.rest}개`, kfmt(it.value), color);
      }
    }
  }
  box.innerHTML = html || '<div class="empty" style="padding:12px">아직 컨텍스트 항목이 없습니다</div>';

  const wbox = $('waste');
  const wsum = waste.reduce((s, n) => s + n.tokens, 0);
  wbox.innerHTML = `<h3>낭비 후보 ${waste.length ? `· 약 ${kfmt(wsum)} 토큰` : ''}</h3>
    <div class="why">800토큰 이상 들어왔는데 마지막으로 쓰인 뒤 2턴 넘게 다시 쓰이지 않은 항목. 지도에서 붉은 점선</div>
    ${waste.length ? `<ol>${waste.map((n) => `<li data-id="${escapeHtml(n.id)}"><i class="dot" style="background:${hex(LOBE_META[n.lobe].color)}"></i>
      <span>${lobeName(n.lobe)}: ${escapeHtml(n.label)}</span><em>${kfmt(n.tokens)} · #${n.lastTurn} 이후</em></li>`).join('')}</ol>`
      : '<div class="none">없음</div>'}`;
}

function tileHtml(r, cls, id, name, val, color) {
  const big = r.w > 70 && r.h > 30;
  const style = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;${color ? `background:${color}` : ''}`;
  return `<div class="tile ${cls}" style="${style}" ${id ? `data-id="${escapeHtml(id)}"` : ''} title="${escapeHtml(name)} · ${escapeHtml(val)}">
    ${big ? `<b>${escapeHtml(name)}</b><span>${escapeHtml(val)}</span>` : ''}</div>`;
}

function drawSpark() {
  const c = $('spark'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (ctxHistory.length < 2) return;
  const max = Math.max(...ctxHistory, compactAt || 0) * 1.05;
  const y = (v) => c.height - (v / max) * (c.height - 4) - 2;
  if (compactAt) {
    g.strokeStyle = 'rgba(255,138,138,0.5)';
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(0, y(compactAt)); g.lineTo(c.width, y(compactAt)); g.stroke();
    g.setLineDash([]);
  }
  g.strokeStyle = '#7dd3ff';
  g.lineWidth = 1.5;
  g.beginPath();
  ctxHistory.forEach((v, i) => { const px = (i / (ctxHistory.length - 1)) * c.width; i ? g.lineTo(px, y(v)) : g.moveTo(px, y(v)); });
  g.stroke();
}

// ════════════════════════════════════════════════════════════
// 화면: 턴 타임라인
// ════════════════════════════════════════════════════════════
const isOpen = (no) => openTurns.has(no) || (no === turns.length && !closedTurns.has(no));

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
  const state = tr.done ? `<span class="state done">완료 ${(tr.ms / 1000).toFixed(1)}초</span>`
    : tr.n === turns.length ? '<span class="state live">진행 중</span>' : '<span class="state">기록 없음</span>';
  const viewing = (viewTurn || turns.length) === tr.n;
  let body = '';
  if (isOpen(tr.n)) {
    const flow = tr.steps.map((s) => {
      const n = neurons.get(s.id);
      return chip(n, s.tokens ? `<em>${kfmt(s.tokens)}</em>` : '', s.error ? 'err' : '');
    }).join('<span class="arrow">→</span>');
    // 답변 문장마다 이름이 그대로 나온 근거를 붙인다. 이 턴과 그 전에 다룬 항목이 후보
    const cands = [...neurons.values()].filter((n) => n.lobe !== 'output' && n.lobe !== 'dialog' && [...n.turns].some((t) => t <= tr.n));
    const sentences = tr.answers.flatMap(splitSentences);
    const rows = sentences.map((s) => ({ s, refs: findRefs(s, cands) }));
    const all = showAll.has(tr.n);
    const shown = all ? rows : rows.slice(0, ANSWER_LINES);
    const hits = rows.filter((r) => r.refs.length).length;
    const answer = rows.length ? `<ul class="answer">${shown.map((r) => `<li class="${r.refs.length ? 'hit' : ''}"><span class="s">${escapeHtml(r.s)}</span>
        ${r.refs.length ? `<span class="refs">${r.refs.map((id) => chip(neurons.get(id))).join('')}</span>` : ''}</li>`).join('')}</ul>
      ${rows.length > ANSWER_LINES ? `<button class="more" data-more="${tr.n}">${all ? '접기' : `전체 ${rows.length}문장 보기`}</button>` : ''}`
      : '<div class="empty">아직 답변이 없습니다</div>';
    const standing = STANDING.map((l) => {
      let c = 0, t = 0;
      for (const n of neurons.values()) if (n.lobe === l && !n.compacted) { c++; t += n.tokens; }
      return c ? `<span class="chip"><i class="dot" style="background:${hex(LOBE_META[l].color)}"></i>${lobeName(l)} ${c}개 <em>${kfmt(t)}</em></span>` : '';
    }).join('');
    body = `<div class="turn-body">
      <div class="sec"><div class="sec-label">흐름 (도구 호출 순서 · 숫자 = 결과로 들어온 토큰)</div>
        <div class="flow">${flow || '<span class="empty">도구를 쓰지 않았습니다</span>'}</div></div>
      <div class="sec"><div class="sec-label">답변과 근거 ${rows.length ? `· ${rows.length}문장 중 ${hits}문장에 근거 이름이 나옴` : ''}</div>${answer}</div>
      <div class="sec"><div class="sec-label">늘 실려 있던 것</div><div class="flow">${standing}</div></div>
      <div class="sec">${viewing && viewTurn ? '<button class="btn" data-view="0">지금 턴으로 돌아가기</button>' : !viewing ? `<button class="btn" data-view="${tr.n}">이 턴을 뇌에서 보기</button>` : ''}</div>
    </div>`;
  }
  return `<li class="turn ${viewing ? 'viewing' : ''}">
    <div class="turn-head" data-turn="${tr.n}">${miniBrain(tr)}
      <div class="turn-title"><span class="prompt"><span class="no">#${tr.n}</span>${escapeHtml(tr.prompt)}</span><span class="sum">${sum || '도구 사용 없음'}</span></div>
      <div class="turn-meta">${state}<br>${clock2(tr.t)} · +${kfmt(tr.added)}${tr.ctxEnd ? ` · 컨텍스트 ${kfmt(tr.ctxEnd)}` : ''}</div>
    </div>${body}</li>`;
}

function renderTimeline() {
  if (!turns.length) { $('turns').innerHTML = '<li class="empty">아직 사용자 입력이 없습니다</li>'; return; }
  let html = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    for (const c of compactions.filter((x) => x.afterTurn === i + 1)) {
      html += `<li class="compact-row">압축 · 직전 ${fmt(c.tokens)} 토큰. 이 아래 턴들의 파일 · 셸 · 웹 결과는 컨텍스트에서 빠졌습니다</li>`;
    }
    html += turnHtml(turns[i]);
  }
  $('turns').innerHTML = html;
}

// ════════════════════════════════════════════════════════════
// 화면: 상세
// ════════════════════════════════════════════════════════════
function renderDetail() {
  const box = $('detail');
  if (!selected) { box.hidden = true; return; }
  const n = selected;
  const counts = Object.entries(n.counts).map(([k, v]) => `${KIND_LABEL[k] || k} ${v}회`).join(' · ');
  const rows = n.history.slice().reverse().map((e) => `<li><div class="d-head"><span class="kind">${KIND_LABEL[e.kind] || e.kind}</span>${clock2(e.t)}
      ${e.tokens ? ` · 약 ${fmt(e.tokens)} 토큰` : ''}${e.error ? ' · <b class="err">오류</b>' : ''}${e.tool ? ' · ' + e.tool : ''}</div>
      ${e.input ? `<pre>${escapeHtml(e.input)}</pre>` : e.detail ? `<div class="d-note">${escapeHtml(e.detail)}</div>` : ''}
      ${e.preview ? `<pre class="out">${escapeHtml(e.preview)}</pre>` : ''}</li>`).join('');
  const usedIn = [...n.turns].sort((a, b) => a - b).map((t) => '#' + t).join(' ');
  box.innerHTML = `<button class="close" aria-label="닫기">×</button>
    <div class="d-lobe" style="color:${hex(LOBE_META[n.lobe].color)}">${lobeName(n.lobe)}</div>
    <h3>${escapeHtml(n.label)}</h3>
    <div class="d-stats">${counts} · 약 ${fmt(n.tokens)} 토큰${n.compacted ? ' · 압축으로 컨텍스트에서 빠짐' : ''}${usedIn ? ` · 쓰인 턴 ${usedIn}` : ''}</div>
    <ol class="d-list">${rows}</ol>`;
  box.querySelector('.close').addEventListener('click', () => { selected = null; renderDetail(); });
  box.hidden = false;
}

// 이벤트가 몰려 들어와도 화면은 0.25초에 한 번만 다시 그린다
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderBudget();
    renderTimeline();
    if (selected) renderDetail();
  }, 250);
}
new ResizeObserver(scheduleRender).observe($('treemap'));

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
  selected = null;
  viewTurn = null;
  openTurns.clear(); closedTurns.clear(); showAll.clear();
  renderDetail();
}

function connect(file) {
  if (source) source.close();
  $('status').textContent = '연결 중…';
  source = new EventSource('/api/stream?file=' + encodeURIComponent(file || 'latest'));
  source.addEventListener('replay', (m) => {
    const data = JSON.parse(m.data);
    reset();
    LOBE_NAMES = data.lobes;
    currentFile = data.file;
    $('session').value = currentFile;
    for (const e of data.events) applyEvent(e, false);
    brain.showTurn(turns.length);
    scheduleRender();
    $('status').textContent = `기록 ${data.events.length}개 불러옴`;
  });
  source.addEventListener('events', (m) => {
    const before = turns.length;
    for (const e of JSON.parse(m.data)) applyEvent(e, true);
    if (!viewTurn || turns.length !== before) brain.showTurn(viewTurn || turns.length);
    scheduleRender();
    $('status').textContent = `실시간 · ${clock2(Date.now())}`;
  });
  source.onerror = () => { $('status').textContent = '연결 끊김 · 다시 시도 중'; };
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
    o.textContent = `${s.title || s.file.split('/').pop().slice(0, 8)} · ${proj} · ${ago < 1 ? '방금' : ago + '분 전'}`;
    sel.appendChild(o);
  }
  sel.value = currentFile || keep;
  if ($('follow').checked && list[0] && currentFile && list[0].file !== currentFile) connect(list[0].file);
}

$('session').addEventListener('change', (ev) => { $('follow').checked = false; connect(ev.target.value); });
$('follow').addEventListener('change', (ev) => { if (ev.target.checked) refreshSessions(); });

fetch('/api/limits').then((r) => r.json()).then((l) => { compactAt = l.compactAt; scheduleRender(); }).catch(() => {});
refreshSessions().then(() => connect('latest'));
setInterval(refreshSessions, 5000);
