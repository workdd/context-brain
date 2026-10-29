'use strict';
// 기본 브라우저로 주소를 연다. 실패해도 서버는 그대로 둔다
const { spawn } = require('child_process');

module.exports = function open(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch (_) { /* 브라우저를 못 열면 주소만 출력된다 */ }
};
