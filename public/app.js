import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ── 뇌 모양 ────────────────────────────────────────────────
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
// 압축되면 컨텍스트에서 빠지는 영역 (규칙·시스템·도구 목록은 다시 실린다)
const COMPACTABLE = new Set(['dialog', 'files', 'shell', 'web', 'agents', 'mcp', 'output']);
const KIND_LABEL = { use: '사용', result: '결과', load: '로드', ref: '언급' };
const KIND_WEIGHT = { use: 1.2, result: 0.9, load: 0.7, ref: 1.0 };
const DECAY_SEC = 3.5;
const RETURN_COLOR = 0xffffff;
const HISTORY_MAX = 40;

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

function lobeAnchor(lobe) {
  const m = LOBE_META[lobe];
  return m.inner ? new THREE.Vector3(...m.inner) : surface(m.dir, 0.93);
}

function neuronPosition(lobe, id) {
  const m = LOBE_META[lobe];
  const rnd = hash(id);
  const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, rr = Math.cbrt(rnd());
  const s = Math.sqrt(1 - u * u);
  const off = new THREE.Vector3(s * Math.cos(th), u, s * Math.sin(th));
  if (m.inner) return new THREE.Vector3(...m.inner).addScaledVector(off, (m.spread || 0.2) * rr);
  const d = new THREE.Vector3(...m.dir).normalize().addScaledVector(off, 0.38 * rr);
  return surface([d.x, d.y, d.z], 0.86 + rnd() * 0.08);
}

// ── 장면 ──────────────────────────────────────────────────
const stage = document.getElementById('stage');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 50);
camera.position.set(3.4, 0.85, 1.5);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
stage.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
Object.assign(labels.domElement.style, { position: 'absolute', top: '0', pointerEvents: 'none' });
stage.appendChild(labels.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = 1.4;
controls.maxDistance = 7;
renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false; });

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.5);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// 표면 점 구름: 대뇌 두 반구 + 소뇌 + 뇌간
const shellPts = [];
(function buildShell() {
  const rnd = hash('brain');
  const sphere = () => { const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u); return [s * Math.cos(th), u, s * Math.sin(th)]; };
  for (let i = 0; i < 30000; i++) {
    let [x, y, z] = sphere();
    // 주름(이랑): 휘어진 줄무늬 위의 점만 남긴다
    const fold = Math.sin(9 * x + 2.2 * Math.sin(5 * z)) * Math.sin(8 * y + 3) + 0.8 * Math.sin(7 * z + 2 * Math.sin(6 * y));
    if (Math.abs(fold) > 0.42 && rnd() > 0.18) continue;
    x *= AX; y *= AY; z *= AZ;
    if (y < 0) y *= 0.82;
    x *= 1 - 0.1 * Math.max(0, z / AZ); // 앞쪽(전두엽)은 조금 좁게
    // 측두엽: 옆 아래로 불룩
    if (y < 0.05 && Math.abs(x) > 0.35) y -= 0.16 * Math.exp(-(((z - 0.1) / 0.42) ** 2)) * Math.min(1, (Math.abs(x) - 0.35) * 3);
    const g = 1 + 0.03 * Math.sin(13 * x + 2) * Math.sin(10 * y + 1) * Math.sin(12 * z);
    x *= g; y *= g; z *= g;
    // 실비우스 열구: 측두엽 위를 비스듬히 가르는 틈
    if (Math.abs(x) > 0.45 && z > -0.35 && z < 0.75 && Math.abs(y - (-0.02 + 0.22 * z)) < 0.035) continue;
    x += Math.sign(x || 1) * 0.04; // 좌우 반구 사이 틈
    if (y < -0.35 && z < -0.3 && Math.abs(x) < 0.5) continue; // 소뇌 자리 비우기
    shellPts.push(x, y, z);
  }
  for (let i = 0; i < 1800; i++) {
    let [x, y, z] = sphere();
    const g = 1 + 0.06 * Math.sin(45 * y);
    shellPts.push(x * 0.5 * g, -0.5 + y * 0.24 * g, -0.82 + z * 0.33 * g);
  }
  for (let i = 0; i < 500; i++) {
    const th = rnd() * Math.PI * 2, h = rnd();
    shellPts.push(Math.cos(th) * 0.11, -0.55 - h * 0.45, -0.4 + Math.sin(th) * 0.11 - h * 0.08);
  }
})();
const shellCount = shellPts.length / 3;
const shellGeo = new THREE.BufferGeometry();
shellGeo.setAttribute('position', new THREE.Float32BufferAttribute(shellPts, 3));
const shellColors = new Float32Array(shellCount * 3);
shellGeo.setAttribute('color', new THREE.BufferAttribute(shellColors, 3));
const shell = new THREE.Points(shellGeo, new THREE.PointsMaterial({
  size: 0.013, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
}));
scene.add(shell);

// 각 점이 어느 영역에 얼마나 속하는지 미리 계산 (가까운 영역만)
const lobeNames = Object.keys(LOBE_META);
const anchors = Object.fromEntries(lobeNames.map((l) => [l, lobeAnchor(l)]));
const pointLobe = new Int16Array(shellCount).fill(-1);
const pointWeight = new Float32Array(shellCount);
{
  const p = new THREE.Vector3();
  for (let i = 0; i < shellCount; i++) {
    p.fromArray(shellPts, i * 3);
    let best = -1, bd = Infinity;
    lobeNames.forEach((l, li) => { const d = p.distanceTo(anchors[l]); if (d < bd) { bd = d; best = li; } });
    const reach = LOBE_META[lobeNames[best]].inner ? 0.5 : 0.62;
    if (bd < reach) { pointLobe[i] = best; pointWeight[i] = (1 - bd / reach) ** 1.5; }
  }
}
const BASE = new THREE.Color(0x3a4a6a).multiplyScalar(0.55);

// 영역 이름표
const lobeState = {};
for (const l of lobeNames) {
  const el = document.createElement('div');
  el.className = 'lobe-label';
  const obj = new CSS2DObject(el);
  const a = anchors[l];
  obj.position.copy(LOBE_META[l].inner ? a.clone().add(new THREE.Vector3(0.0, 0, 0)) : a.clone().multiplyScalar(1.17));
  scene.add(obj);
  lobeState[l] = { act: 0, el, color: new THREE.Color(LOBE_META[l].color) };
}

// ── 뉴런 ──────────────────────────────────────────────────
const neuronGeo = new THREE.SphereGeometry(1, 16, 12);
const neurons = new Map();
const neuronGroup = new THREE.Group();
scene.add(neuronGroup);
let LOBE_NAMES = {};

function radiusFor(tokens) {
  return Math.min(0.065, 0.013 + 0.011 * Math.log10(1 + tokens / 40));
}

function getNeuron(e) {
  let n = neurons.get(e.id);
  if (n) return n;
  const mat = new THREE.MeshBasicMaterial({ color: LOBE_META[e.lobe].color, transparent: true, toneMapped: false });
  const mesh = new THREE.Mesh(neuronGeo, mat);
  mesh.position.copy(neuronPosition(e.lobe, e.id));
  neuronGroup.add(mesh);
  n = { id: e.id, lobe: e.lobe, label: e.label, mesh, act: 0, tokens: 0, uses: 0, counts: {}, compacted: false, last: null, history: [] };
  mesh.userData.neuron = n;
  neurons.set(e.id, n);
  return n;
}

// ── 신호 전달 (영역 사이를 지나가는 빛) ─────────────────────
const pulses = [];
const dotGeo = new THREE.SphereGeometry(0.012, 8, 6);
function spawnPulse(from, to, color) {
  if (pulses.length > 70) return;
  const mid = from.clone().add(to).multiplyScalar(0.5).multiplyScalar(0.45);
  const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.3), toneMapped: false }));
  scene.add(line, dot);
  pulses.push({ curve, line, dot, age: 0, life: 1.1 });
}

// ── 이벤트 적용 ────────────────────────────────────────────
let ctxHistory = [];
let globalFlash = 0;

function applyEvent(e, animate) {
  if (e.kind === 'usage') {
    ctxHistory.push(e.tokens);
    if (ctxHistory.length > 80) ctxHistory.shift();
    if (animate) drawCtx();
    return;
  }
  if (e.kind === 'compact') {
    for (const n of neurons.values()) if (COMPACTABLE.has(n.lobe)) n.compacted = true;
    if (animate) globalFlash = 1;
    return;
  }
  if (!LOBE_META[e.lobe]) return;
  const n = getNeuron(e);
  n.label = e.label || n.label;
  n.counts[e.kind] = (n.counts[e.kind] || 0) + 1;
  if (e.kind === 'use') n.uses++;
  if (e.tokens) n.tokens = e.kind === 'load' ? Math.max(n.tokens, e.tokens) : n.tokens + e.tokens;
  if (e.kind !== 'ref') n.compacted = false;
  n.last = e;
  n.history.push(e);
  if (n.history.length > HISTORY_MAX) n.history.shift();
  if (!animate) return;
  n.act = Math.min(1.4, n.act + (KIND_WEIGHT[e.kind] || 0.8));
  applyEventPulse(e);
  if (selected === n) renderDetail();
}

// ── 화면 패널 ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + new THREE.Color(c).getHexString();
const fmt = (n) => Math.round(n).toLocaleString('ko-KR');

function logEvent(e, fresh) {
  if (e.kind === 'usage') return;
  const li = document.createElement('li');
  const time = e.t ? new Date(e.t).toLocaleTimeString('ko-KR', { hour12: false }) : '';
  if (e.kind === 'compact') {
    li.className = 'compact';
    li.innerHTML = `<span class="time">${time}</span><span class="dot" style="background:#ff6b6b"></span>
      <span class="what">${e.label} <span class="meta">직전 ${fmt(e.tokens)} 토큰</span></span>`;
  } else {
    const lobeName = LOBE_NAMES[e.lobe] || e.lobe;
    li.innerHTML = `<span class="time">${time}</span><span class="dot" style="background:${hex(LOBE_META[e.lobe].color)}"></span>
      <span class="what"><span class="kind">${KIND_LABEL[e.kind] || e.kind}</span>${lobeName}: ${escapeHtml(e.label || '')}
      <div class="meta">${e.tokens ? ` · 약 ${fmt(e.tokens)} 토큰` : ''}${e.detail ? ' · ' + escapeHtml(e.detail) : ''}</div></span>`;
    li.addEventListener('click', () => { const n = neurons.get(e.id); if (n) select(n); });
  }
  if (fresh) li.classList.add('fresh');
  const list = $('events');
  list.prepend(li);
  while (list.children.length > 250) list.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderLegend() {
  const ul = $('lobes');
  ul.innerHTML = '';
  const sums = {};
  for (const n of neurons.values()) {
    const s = (sums[n.lobe] ||= { count: 0, tokens: 0 });
    s.count++;
    if (!n.compacted) s.tokens += n.tokens;
  }
  for (const l of lobeNames) {
    const s = sums[l] || { count: 0, tokens: 0 };
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${hex(LOBE_META[l].color)}"></span><span>${LOBE_NAMES[l] || l}</span>
      <span class="num">${s.count}개</span><span class="num">${s.tokens ? fmt(s.tokens) : '-'}</span>`;
    li.addEventListener('click', () => focusOn(anchors[l]));
    ul.appendChild(li);
    lobeState[l].el.textContent = `${LOBE_NAMES[l] || l}${s.count ? ' · ' + s.count : ''}`;
  }
}

function drawCtx() {
  const v = ctxHistory[ctxHistory.length - 1];
  $('ctx').textContent = v != null ? `${fmt(v)} 토큰` : '-';
  const c = $('spark'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (ctxHistory.length < 2) return;
  const max = Math.max(...ctxHistory) * 1.1;
  g.strokeStyle = '#7dd3ff';
  g.lineWidth = 1.5;
  g.beginPath();
  ctxHistory.forEach((y, i) => {
    const px = (i / (ctxHistory.length - 1)) * c.width, py = c.height - (y / max) * (c.height - 4) - 2;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  });
  g.stroke();
}

let focusTarget = null;
function focusOn(p) {
  controls.autoRotate = false;
  focusTarget = p.clone().multiplyScalar(0.5);
}

// 마우스를 올리면 뉴런 정보
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tip = $('tip');
renderer.domElement.addEventListener('pointermove', (ev) => {
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObjects(neuronGroup.children)[0];
  if (!hit) { tip.hidden = true; return; }
  const n = hit.object.userData.neuron;
  const counts = Object.entries(n.counts).map(([k, v]) => `${KIND_LABEL[k] || k} ${v}`).join(' · ');
  tip.innerHTML = `<b>${LOBE_NAMES[n.lobe] || n.lobe}: ${escapeHtml(n.label)}</b><span>${n.compacted ? '압축으로 빠짐 · ' : ''}클릭하면 자세히</span>
    <span>${counts}</span><span>약 ${fmt(n.tokens)} 토큰</span>${n.last && n.last.detail ? `<span>${escapeHtml(n.last.detail)}</span>` : ''}`;
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - 330) + 'px';
  tip.style.top = ev.clientY + 14 + 'px';
  tip.hidden = false;
});

// 클릭하면 상세 패널. 드래그로 돌린 것은 클릭으로 치지 않는다
let downAt = null;
let selected = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObjects(neuronGroup.children)[0];
  if (hit) select(hit.object.userData.neuron);
});

function select(n) {
  selected = n;
  n.act = Math.max(n.act, 1);
  focusOn(n.mesh.position);
  renderDetail();
}

function renderDetail() {
  const box = $('detail');
  if (!selected) { box.hidden = true; return; }
  const n = selected;
  const counts = Object.entries(n.counts).map(([k, v]) => `${KIND_LABEL[k] || k} ${v}회`).join(' · ');
  const rows = n.history.slice().reverse().map((e) => {
    const time = e.t ? new Date(e.t).toLocaleTimeString('ko-KR', { hour12: false }) : '';
    return `<li><div class="d-head"><span class="kind">${KIND_LABEL[e.kind] || e.kind}</span>${time}
      ${e.tokens ? ` · 약 ${fmt(e.tokens)} 토큰` : ''}${e.error ? ' · <b class="err">오류</b>' : ''}${e.tool ? ' · ' + e.tool : ''}</div>
      ${e.input ? `<pre>${escapeHtml(e.input)}</pre>` : e.detail ? `<div class="d-note">${escapeHtml(e.detail)}</div>` : ''}
      ${e.preview ? `<pre class="out">${escapeHtml(e.preview)}</pre>` : ''}</li>`;
  }).join('');
  box.innerHTML = `<button class="close" aria-label="닫기">×</button>
    <div class="d-lobe" style="color:${hex(LOBE_META[n.lobe].color)}">${LOBE_NAMES[n.lobe] || n.lobe}</div>
    <h3>${escapeHtml(n.label)}</h3>
    <div class="d-stats">${counts} · 약 ${fmt(n.tokens)} 토큰${n.compacted ? ' · 압축으로 컨텍스트에서 빠짐' : ''}</div>
    <div class="d-id">${escapeHtml(n.id)}</div>
    <ol class="d-list">${rows}</ol>`;
  box.querySelector('.close').addEventListener('click', () => { selected = null; renderDetail(); });
  box.hidden = false;
}

// ── 세션 연결 ─────────────────────────────────────────────
let source = null;
let currentFile = null;

function reset() {
  for (const n of neurons.values()) { neuronGroup.remove(n.mesh); n.mesh.material.dispose(); }
  neurons.clear();
  selected = null;
  renderDetail();
  ctxHistory = [];
  $('events').innerHTML = '';
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
    for (const e of data.events) { applyEvent(e, false); logEvent(e, false); }
    renderLegend();
    drawCtx();
    // 마지막 몇 개는 다시 재생해 지금 흐름을 보여 준다
    data.events.filter((e) => e.kind !== 'usage').slice(-14).forEach((e, i) => {
      setTimeout(() => { if (neurons.has(e.id)) { const n = neurons.get(e.id); n.act = Math.min(2, n.act + 0.9); applyEventPulse(e); } }, 250 + i * 170);
    });
    $('status').textContent = `과거 이벤트 ${data.events.length}개 불러옴 · 실시간 대기 중`;
  });
  source.addEventListener('events', (m) => {
    for (const e of JSON.parse(m.data)) { applyEvent(e, true); logEvent(e, true); }
    renderLegend();
    $('status').textContent = `실시간 · 마지막 갱신 ${new Date().toLocaleTimeString('ko-KR', { hour12: false })}`;
  });
  source.onerror = () => { $('status').textContent = '연결 끊김 · 다시 시도 중'; };
}

function applyEventPulse(e) {
  const n = neurons.get(e.id);
  if (!n || e.lobe === 'output') return;
  if (e.kind === 'use') spawnPulse(anchors.output, n.mesh.position, LOBE_META[e.lobe].color); // 나감: 영역 색
  else if (e.kind === 'result' || e.kind === 'ref') spawnPulse(n.mesh.position, anchors.output, RETURN_COLOR); // 돌아옴: 흰색
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

// ── 그리기 ────────────────────────────────────────────────
const clock = new THREE.Clock();
const tmp = new THREE.Color();
const grey = new THREE.Color(0x55607a);
const FLASH = new THREE.Color(0xff5050);
let shellDirty = true;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const decay = Math.exp(-dt / DECAY_SEC);
  globalFlash *= Math.exp(-dt / 0.6);

  for (const l of lobeNames) lobeState[l].act = 0;
  for (const n of neurons.values()) {
    n.act *= decay;
    const ls = lobeState[n.lobe];
    ls.act = Math.max(ls.act, n.act);
    const r = radiusFor(n.tokens) * (1 + 0.35 * Math.min(n.act, 1.5));
    n.mesh.scale.setScalar(r);
    if (n.compacted) {
      n.mesh.material.color.copy(grey).multiplyScalar(0.35 + n.act);
      n.mesh.material.opacity = 0.45;
    } else {
      n.mesh.material.color.copy(ls.color).multiplyScalar(0.35 + 0.8 * n.act);
      n.mesh.material.opacity = 1;
    }
  }

  // 표면 점: 활성 영역 근처가 그 영역 색으로 물든다. 조용할 때는 한 번만 바탕색으로 되돌린다
  const busy = globalFlash > 0.01 || lobeNames.some((l) => lobeState[l].act > 0.01);
  if (busy || shellDirty) for (let i = 0; i < shellCount; i++) {
    tmp.copy(BASE);
    const li = pointLobe[i];
    if (li >= 0) {
      const ls = lobeState[lobeNames[li]];
      if (ls.act > 0.01) tmp.lerp(ls.color, Math.min(1, ls.act * pointWeight[i] * 0.6)).multiplyScalar(1 + ls.act * pointWeight[i] * 0.6);
    }
    if (globalFlash > 0.01) tmp.lerp(FLASH, globalFlash * 0.5);
    shellColors[i * 3] = tmp.r; shellColors[i * 3 + 1] = tmp.g; shellColors[i * 3 + 2] = tmp.b;
  }
  if (busy || shellDirty) shellGeo.attributes.color.needsUpdate = true;
  shellDirty = busy;

  for (const l of lobeNames) lobeState[l].el.style.opacity = String(0.45 + Math.min(0.55, lobeState[l].act));

  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    p.age += dt;
    const k = p.age / p.life;
    p.dot.position.copy(p.curve.getPoint(Math.min(1, k)));
    p.line.material.opacity = 0.35 * (1 - k);
    if (k >= 1) {
      scene.remove(p.line, p.dot);
      p.line.geometry.dispose(); p.line.material.dispose(); p.dot.material.dispose();
      pulses.splice(i, 1);
    }
  }

  if (focusTarget) {
    controls.target.lerp(focusTarget, 0.06);
    if (controls.target.distanceTo(focusTarget) < 0.01) focusTarget = null;
  }
  controls.update();
  composer.render();
  labels.render(scene, camera);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});

refreshSessions().then(() => connect('latest'));
setInterval(refreshSessions, 5000);
frame();
