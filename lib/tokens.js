'use strict';
// 글자 → 토큰 추정. 계수는 실측 사용량에 맞춘 값이다 (lib/calibrate.js).
// ~/.config/context-brain/tokens.json 이 있으면 그 값을 쓴다 (context-brain calibrate 가 만든다).

const fs = require('fs');
const os = require('os');
const path = require('path');

// 기본값: Claude Code 세션 455개에서 뽑은 도구 결과 표본 226개로 맞춤 (중앙 오차 6%)
const DEFAULT = { ascii: 1 / 2.25, hangul: 1.45, other: 2.43, perResult: 35, image: 1600, source: 'default' };
const FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'context-brain', 'tokens.json');

function load(file = FILE) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if ([c.ascii, c.hangul, c.other].every((v) => typeof v === 'number' && v > 0)) return { ...DEFAULT, ...c, source: file };
  } catch (_) { /* 없으면 기본값 */ }
  return { ...DEFAULT };
}

let coef = load();

function isHangul(code) {
  return (code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f);
}

function countText(s) {
  let ascii = 0;
  let hangul = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) ascii++;
    else if (isHangul(c)) hangul++;
    else if (c < 0xdc00 || c > 0xdfff) other++; // 서로게이트 쌍은 한 글자로 센다
  }
  return Math.ceil(ascii * coef.ascii + hangul * coef.hangul + other * coef.other);
}

// 이미지 크기(가로 · 세로)를 base64 머리에서 읽는다. PNG · JPEG · GIF · WebP
function imageSize(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const head = Buffer.from(b64.slice(0, 64), 'base64');
  if (head[0] === 0x89 && head[1] === 0x50 && head.length >= 24) return [head.readUInt32BE(16), head.readUInt32BE(20)];
  if (head[0] === 0x47 && head[1] === 0x49 && head.length >= 10) return [head.readUInt16LE(6), head.readUInt16LE(8)];
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP' && head.length >= 30) {
    const kind = head.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3)];
    if (kind === 'VP8 ') return [head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L') { const b = head.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    const buf = Buffer.from(b64.slice(0, 200000), 'base64'); // SOF 는 보통 앞쪽에 있다
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// 이미지 토큰은 가로 × 세로 / 750 (실측과 3% 안에서 맞음). 크기를 못 읽으면 기본값
function imageTokens(block) {
  const size = imageSize(block && block.source && block.source.data);
  return size && size[0] > 0 && size[1] > 0 ? Math.ceil((size[0] * size[1]) / 750) : coef.image;
}

module.exports = {
  countText,
  imageTokens,
  imageSize,
  coefficients: () => coef,
  setCoefficients: (c) => { coef = { ...DEFAULT, ...c }; },
  load,
  FILE,
  DEFAULT,
};
