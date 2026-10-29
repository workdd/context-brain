'use strict';
// 커지는 jsonl 파일을 폴링으로 따라 읽는다. 줄이 덜 쓰인 채 끝나면 다음 읽기까지 남겨 둔다.

const fs = require('fs');

class Tailer {
  constructor(file, onLines, { intervalMs = 400 } = {}) {
    this.file = file;
    this.onLines = onLines;
    this.intervalMs = intervalMs;
    this.offset = 0;
    this.rest = '';
    this.timer = null;
  }

  // 지금까지 쌓인 내용을 한 번 읽는다. 읽은 줄 배열을 돌려준다.
  readNew() {
    let size;
    try { size = fs.statSync(this.file).size; } catch (_) { return []; }
    if (size < this.offset) { this.offset = 0; this.rest = ''; }
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.rest + buf.toString('utf8');
      const lines = text.split('\n');
      this.rest = lines.pop();
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  }

  start() {
    const tick = () => {
      const lines = this.readNew();
      if (lines.length) this.onLines(lines);
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Tailer };
