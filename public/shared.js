// 서버와 브라우저가 함께 쓰는 설정: 아바타 목록, 기본 디자인, 디자인 프리셋, 글꼴
(function (root) {
  const AVATAR_GROUPS = [
    { name: '동물', items: ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐧', '🐤', '🦉', '🐢', '🐬', '🐳', '🦄', '🐹', '🦔'] },
    { name: '곤충', items: ['🐝', '🐞', '🦋', '🐜', '🦗', '🪲', '🐛', '🦟', '🪳', '🪰', '🕷️', '🐌'] },
    { name: '하트', items: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '🖤', '💖', '💘'] },
    { name: '기타', items: ['⭐', '🍀', '🔥', '🌸', '🍓', '🍉', '🌈', '⚡', '🎈', '👑', '🎯', '🧪'] }
  ];
  const AVATARS = AVATAR_GROUPS.flatMap(g => g.items);

  const DISPLAY_FONTS = {
    'Black Han Sans': { label: '검은고딕 (굵고 강함)', spec: 'Black+Han+Sans' },
    'Jua': { label: '주아 (둥글고 귀여움)', spec: 'Jua' },
    'Do Hyeon': { label: '도현 (단단함)', spec: 'Do+Hyeon' },
    'Gaegu': { label: '개구 (손글씨)', spec: 'Gaegu:wght@400;700' },
    'Gamja Flower': { label: '감자꽃 (손글씨)', spec: 'Gamja+Flower' },
    'Dongle': { label: '동글 (말랑함)', spec: 'Dongle:wght@400;700' },
    'Nanum Pen Script': { label: '나눔손글씨 펜', spec: 'Nanum+Pen+Script' }
  };
  const BODY_FONTS = {
    'Noto Sans KR': { label: '본고딕 (기본)', spec: 'Noto+Sans+KR:wght@400;700;900' },
    'Nanum Gothic': { label: '나눔고딕', spec: 'Nanum+Gothic:wght@400;700;800' },
    'Gowun Dodum': { label: '고운돋움 (부드러움)', spec: 'Gowun+Dodum' },
    'IBM Plex Sans KR': { label: 'IBM Plex (깔끔함)', spec: 'IBM+Plex+Sans+KR:wght@400;700' },
    'Jua': { label: '주아 (귀여움)', spec: 'Jua' }
  };

  const COLOR_KEYS = [
    ['bg', '전체 배경'],
    ['surface', '카드·입력칸 배경'],
    ['text', '글자'],
    ['textDim', '보조 글자'],
    ['accent', '강조색 (제목·버튼·점수)'],
    ['ok', '정답 표시'],
    ['bad', '오답 표시'],
    ['opt0', '1번 보기'],
    ['opt1', '2번 보기'],
    ['opt2', '3번 보기'],
    ['opt3', '4번 보기'],
    ['opt4', '5번 보기']
  ];

  const PRESETS = {
    '무대 남색': { bg: '#11133a', surface: '#1a1d4f', text: '#f5f3ec', textDim: '#a9abd0', accent: '#f4c542', ok: '#3ccf8e', bad: '#ff5c6c', opt0: '#ff6b57', opt1: '#3aa0ff', opt2: '#2fc48d', opt3: '#a678ff', opt4: '#f29d38', fontDisplay: 'Black Han Sans', fontBody: 'Noto Sans KR' },
    '화이트 클린': { bg: '#f4f3ef', surface: '#ffffff', text: '#1d1f2b', textDim: '#676b7c', accent: '#2f5bea', ok: '#178a55', bad: '#d6334a', opt0: '#e5533d', opt1: '#2f7fe0', opt2: '#1a9a68', opt3: '#7d52dc', opt4: '#dd8419', fontDisplay: 'Do Hyeon', fontBody: 'Noto Sans KR' },
    '숲속 캠프': { bg: '#13261c', surface: '#1c3828', text: '#f1f5e9', textDim: '#a6bfa3', accent: '#f2b544', ok: '#7fe08a', bad: '#ff7a63', opt0: '#e2683c', opt1: '#3b93c9', opt2: '#4caf6a', opt3: '#9a74c9', opt4: '#d9a22b', fontDisplay: 'Jua', fontBody: 'Gowun Dodum' },
    '핑크 하트': { bg: '#fff0f4', surface: '#ffffff', text: '#3a1f2b', textDim: '#8c6474', accent: '#ff3d84', ok: '#1f9d63', bad: '#e0413a', opt0: '#ff5c7a', opt1: '#4c8dff', opt2: '#2bb37b', opt3: '#a066ff', opt4: '#ff9a3d', fontDisplay: 'Jua', fontBody: 'Gowun Dodum' },
    '밤하늘 퍼플': { bg: '#1b1030', surface: '#2a1a47', text: '#f7f1ff', textDim: '#b9a8d6', accent: '#7cf2c8', ok: '#7cf2c8', bad: '#ff6b8b', opt0: '#ff6f91', opt1: '#5ab0ff', opt2: '#3fd0a0', opt3: '#b388ff', opt4: '#ffb454', fontDisplay: 'Black Han Sans', fontBody: 'Noto Sans KR' }
  };
  const DEFAULT_THEME = PRESETS['무대 남색'];

  function sanitizeTheme(t) {
    const out = { ...DEFAULT_THEME };
    if (!t || typeof t !== 'object') return out;
    for (const [k] of COLOR_KEYS) {
      if (typeof t[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(t[k])) out[k] = t[k].toLowerCase();
    }
    if (DISPLAY_FONTS[t.fontDisplay]) out.fontDisplay = t.fontDisplay;
    if (BODY_FONTS[t.fontBody]) out.fontBody = t.fontBody;
    return out;
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  // 배경색 위에서 읽기 좋은 글자색 (검정 또는 흰색)
  function onColor(hex) {
    const L = luminance(hex);
    return 1.05 / (L + 0.05) >= 3 ? '#ffffff' : '#16161d';
  }

  function applyTheme(theme) {
    if (typeof document === 'undefined') return;
    const t = sanitizeTheme(theme);
    const s = document.documentElement.style;
    const map = { bg: '--bg', surface: '--surface', text: '--ink', textDim: '--ink-dim', accent: '--accent', ok: '--ok', bad: '--bad' };
    for (const k in map) s.setProperty(map[k], t[k]);
    for (let i = 0; i < 5; i++) {
      s.setProperty('--opt-' + i, t['opt' + i]);
      s.setProperty('--on-opt-' + i, onColor(t['opt' + i]));
    }
    s.setProperty('--on-accent', onColor(t.accent));
    s.setProperty('--on-ok', onColor(t.ok));
    s.setProperty('--on-bad', onColor(t.bad));
    const dark = luminance(t.bg) < 0.2;
    s.setProperty('color-scheme', dark ? 'dark' : 'light');
    document.documentElement.dataset.tone = dark ? 'dark' : 'light';
    s.setProperty('--font-display', `"${t.fontDisplay}", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`);
    s.setProperty('--font-body', `"${t.fontBody}", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif`);
    const href = 'https://fonts.googleapis.com/css2?family=' + DISPLAY_FONTS[t.fontDisplay].spec +
      (t.fontBody !== t.fontDisplay ? '&family=' + BODY_FONTS[t.fontBody].spec : '') + '&display=swap';
    let link = document.getElementById('gb-font');
    if (!link) { link = document.createElement('link'); link.id = 'gb-font'; link.rel = 'stylesheet'; document.head.appendChild(link); }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', t.bg);
  }

  const api = { AVATAR_GROUPS, AVATARS, DISPLAY_FONTS, BODY_FONTS, COLOR_KEYS, PRESETS, DEFAULT_THEME, sanitizeTheme, applyTheme, onColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GB = api;
})(typeof window !== 'undefined' ? window : this);
