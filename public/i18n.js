// 화면 언어. ?lang=en|ko > 지난 선택 > 브라우저 언어 순으로 정한다
(function (root) {
  let saved = null;
  try { saved = localStorage.getItem('cb-lang'); } catch (_) { /* 저장소를 못 쓰면 브라우저 언어 */ }
  const q = new URLSearchParams(location.search).get('lang');
  const pick = q || saved || ((navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en');
  const lang = pick === 'ko' ? 'ko' : 'en';
  const L = (ko, en) => (lang === 'en' ? en : ko);
  function set(next) {
    try { localStorage.setItem('cb-lang', next); } catch (_) { /* 이번 주소에만 반영 */ }
    const u = new URL(location.href);
    u.searchParams.set('lang', next);
    location.href = u.toString();
  }
  // 정적 HTML: data-en 은 글자, data-en-title 은 툴팁
  function apply() {
    document.documentElement.lang = lang;
    if (lang !== 'en') return;
    document.querySelectorAll('[data-en]').forEach((el) => { el.textContent = el.dataset.en; });
    document.querySelectorAll('[data-en-title]').forEach((el) => { el.title = el.dataset.enTitle; });
  }
  root.CBLang = { lang, L, set, apply };
})(window);
