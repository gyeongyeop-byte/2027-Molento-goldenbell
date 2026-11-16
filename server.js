// 골든벨 — 실시간 객관식 점수제 퀴즈 서버
// 실행: npm install && npm start
// 환경변수: PORT(기본 3000), ADMIN_PASSWORD(기본 goldenbell), PUBLIC_URL(QR 주소, 선택), EVENT_TITLE(행사 이름, 선택)

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const GB = require('./public/shared.js');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'goldenbell';
const Q_FILE = path.join(__dirname, 'questions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const rid = () => crypto.randomBytes(5).toString('hex');

// ---------- 설정 (행사 이름, 디자인, 순위 규칙) ----------
let settings = {
  title: process.env.EVENT_TITLE || '골든벨',
  theme: { ...GB.DEFAULT_THEME },
  tieBreak: 'time',          // time: 동점이면 맞힌 문제의 응답 시간 합이 짧은 사람이 위 / shared: 공동 순위
  showRankToPlayers: true
};
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (typeof saved.title === 'string' && saved.title.trim()) settings.title = saved.title.trim().slice(0, 30);
  if (saved.tieBreak === 'time' || saved.tieBreak === 'shared') settings.tieBreak = saved.tieBreak;
  if (typeof saved.showRankToPlayers === 'boolean') settings.showRankToPlayers = saved.showRankToPlayers;
  settings.theme = GB.sanitizeTheme(saved.theme);
} catch {}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { console.warn('settings.json 저장 실패:', e.message); }
}

// ---------- 문제 (부문 > 문제) ----------
function sanitizeQuiz(data) {
  const sections = Array.isArray(data) ? [{ name: '기본', questions: data }] : (data && data.sections);
  if (!Array.isArray(sections) || !sections.length) throw new Error('부문이 하나 이상 있어야 합니다.');
  const ids = new Set();
  const uid = v => {
    let id = typeof v === 'string' && /^[a-z0-9]{4,20}$/.test(v) ? v : rid();
    while (ids.has(id)) id = rid();
    ids.add(id);
    return id;
  };
  return {
    sections: sections.map((s, si) => {
      const name = String(s.name || '').trim().slice(0, 30) || `${si + 1}부`;
      const qs = Array.isArray(s.questions) ? s.questions : [];
      if (!qs.length) throw new Error(`'${name}' 부문에 문제가 없습니다.`);
      return {
        id: uid(s.id),
        name,
        questions: qs.map((q, qi) => {
          const label = `'${name}' ${qi + 1}번 문제`;
          const text = String(q.text || '').trim();
          const options = (Array.isArray(q.options) ? q.options : []).map(o => String(o).trim()).filter(Boolean);
          const answer = Number(q.answer);
          if (!text) throw new Error(`${label}의 질문이 비어 있습니다.`);
          if (options.length < 2 || options.length > 5) throw new Error(`${label}의 보기는 2~5개여야 합니다.`);
          if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw new Error(`${label}의 정답 번호가 올바르지 않습니다.`);
          return {
            id: uid(q.id),
            text,
            options,
            answer,
            time: Math.max(3, Math.min(300, Math.round(Number(q.time)) || 20)),
            points: Math.max(1, Math.min(100, Math.round(Number(q.points)) || 1))
          };
        })
      };
    })
  };
}

let quiz = { sections: [] };
try {
  quiz = sanitizeQuiz(JSON.parse(fs.readFileSync(Q_FILE, 'utf8')));
} catch (e) {
  console.warn('questions.json을 읽지 못했습니다:', e.message);
  quiz = sanitizeQuiz([{ text: '예시 문제', options: ['O', 'X'], answer: 0 }]);
}
function saveQuiz() {
  try { fs.writeFileSync(Q_FILE, JSON.stringify(quiz, null, 2)); } catch (e) { console.warn('questions.json 저장 실패:', e.message); }
}

// ---------- 게임 상태 ----------
// phase: lobby(대기) · intro(부문 소개) · open(답 받는 중) · locked(마감) · revealed(정답 공개)
//        board(순위 발표) · ended(최종 결과)
const game = {
  phase: 'lobby',
  sIdx: -1,
  qIdx: -1,
  startedAt: 0,
  endsAt: 0,
  boardScope: 'total',
  joinOpen: true,
  joinUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
  message: '',
  lastReveal: null
};
const players = new Map();
let lockTimer = null;

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return 'localhost';
}
const defaultJoinUrl = () => `http://${lanAddress()}:${PORT}/`;
const joinUrl = () => game.joinUrl || defaultJoinUrl();
const curSection = () => quiz.sections[game.sIdx] || null;
const curQ = () => (curSection() && curSection().questions[game.qIdx]) || null;
const totalQuestions = () => quiz.sections.reduce((n, s) => n + s.questions.length, 0);
const timeLeft = () => game.phase === 'open' ? Math.max(0, game.endsAt - Date.now()) : 0;

// ---------- 점수와 순위 ----------
function scoreOf(p, sectionIdx) {
  const qids = sectionIdx == null ? null : new Set((quiz.sections[sectionIdx]?.questions || []).map(q => q.id));
  let score = 0, time = 0, correct = 0;
  for (const [qid, r] of p.results) {
    if (qids && !qids.has(qid)) continue;
    score += r.points;
    if (r.correct) { time += r.ms; correct++; }
  }
  if (sectionIdx == null) score += p.bonus;
  return { score, time, correct };
}
function ranking(sectionIdx = null) {
  const rows = [...players.values()].map(p => ({ p, ...scoreOf(p, sectionIdx) }));
  const byTime = settings.tieBreak === 'time';
  rows.sort((a, b) => (b.score - a.score) || (byTime ? a.time - b.time : 0) || a.p.name.localeCompare(b.p.name, 'ko'));
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const tied = prev && prev.score === r.score && (!byTime || prev.time === r.time);
    r.rank = tied ? prev.rank : i + 1;
  });
  return rows;
}
const rowView = r => ({ rank: r.rank, name: r.p.name, avatar: r.p.avatar, score: r.score, correct: r.correct, time: r.time });

function distribution() {
  const q = curQ();
  if (!q) return [];
  const d = q.options.map(() => 0);
  for (const p of players.values()) {
    const a = p.answers.get(q.id);
    if (a) d[a.choice]++;
  }
  return d;
}
function answeredCount() {
  const q = curQ();
  if (!q) return 0;
  let n = 0;
  for (const p of players.values()) if (p.answers.has(q.id)) n++;
  return n;
}

function boardData(totalRank) {
  if (game.phase !== 'board' && game.phase !== 'ended') return null;
  const scope = game.phase === 'ended' ? 'total' : game.boardScope;
  const rows = scope === 'section' ? ranking(game.sIdx) : totalRank;
  const totals = new Map(totalRank.map(r => [r.p.id, r.score]));
  const sec = game.sIdx >= 0 ? ranking(game.sIdx) : [];
  const secScores = new Map(sec.map(r => [r.p.id, r.score]));
  return {
    scope,
    sectionName: curSection()?.name || '',
    sectionDone: !!curSection() && game.qIdx >= curSection().questions.length - 1,
    rows: rows.slice(0, 10).map(r => ({ ...rowView(r), total: totals.get(r.p.id) || 0, section: secScores.get(r.p.id) || 0 }))
  };
}

function publicState(totalRank) {
  const q = curQ();
  const s = curSection();
  const revealed = game.phase === 'revealed';
  return {
    title: settings.title,
    theme: settings.theme,
    showRank: settings.showRankToPlayers,
    phase: game.phase,
    sIdx: game.sIdx,
    qIdx: game.qIdx,
    sections: quiz.sections.map(x => ({ name: x.name, count: x.questions.length })),
    section: s ? { name: s.name, count: s.questions.length } : null,
    question: q && ['open', 'locked', 'revealed'].includes(game.phase)
      ? { text: q.text, options: q.options, time: q.time, points: q.points, answer: revealed ? q.answer : null }
      : null,
    timeLeft: timeLeft(),
    joinOpen: game.joinOpen,
    joinUrl: joinUrl(),
    total: players.size,
    answered: answeredCount(),
    distribution: revealed ? distribution() : null,
    reveal: revealed ? game.lastReveal : null,
    lobbyNames: game.phase === 'lobby' || game.phase === 'intro'
      ? [...players.values()].map(p => ({ name: p.name, avatar: p.avatar })) : null,
    board: boardData(totalRank),
    message: game.message
  };
}

function playerView(p, rankRow, total) {
  const q = curQ();
  const a = q ? p.answers.get(q.id) : null;
  const r = q && game.phase === 'revealed' ? p.results.get(q.id) : null;
  const secRank = game.sIdx >= 0 && game.phase === 'board' && game.boardScope === 'section'
    ? ranking(game.sIdx).find(x => x.p.id === p.id) : null;
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    score: rankRow ? rankRow.score : 0,
    correct: rankRow ? rankRow.correct : 0,
    rank: rankRow ? rankRow.rank : null,
    of: total,
    sectionScore: game.sIdx >= 0 ? scoreOf(p, game.sIdx).score : 0,
    sectionRank: secRank ? secRank.rank : null,
    answer: a ? a.choice : null,
    canAnswer: game.phase === 'open' && Date.now() < game.endsAt,
    result: r ? { correct: r.correct, points: r.points } : null
  };
}

function adminState(totalRank) {
  const rankMap = new Map(totalRank.map(r => [r.p.id, r]));
  const q = curQ();
  return {
    ...publicState(totalRank),
    quiz,
    settings: { tieBreak: settings.tieBreak, showRankToPlayers: settings.showRankToPlayers },
    liveDistribution: distribution(),
    currentAnswer: q ? q.answer : null,
    defaultJoinUrl: defaultJoinUrl(),
    totalQuestions: totalQuestions(),
    players: totalRank.map(r => ({
      id: r.p.id,
      name: r.p.name,
      avatar: r.p.avatar,
      rank: r.rank,
      score: r.score,
      correct: r.correct,
      bonus: r.p.bonus,
      connected: r.p.sockets.size > 0,
      answer: q && r.p.answers.has(q.id) ? r.p.answers.get(q.id).choice : null,
      sectionScores: quiz.sections.map((_, i) => scoreOf(r.p, i).score)
    }))
  };
}

// ---------- 서버 ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch {
    res.status(500).send('QR 생성 실패');
  }
});

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

let broadcastPending = null;
function broadcast() {
  if (broadcastPending) return;
  broadcastPending = setTimeout(() => {
    broadcastPending = null;
    const totalRank = ranking();
    const pub = publicState(totalRank);
    io.to('screens').emit('state', pub);
    io.to('admins').emit('admin:state', adminState(totalRank));
    const rankMap = new Map(totalRank.map(r => [r.p.id, r]));
    for (const p of players.values()) {
      if (!p.sockets.size) continue;
      const view = { ...pub, me: playerView(p, rankMap.get(p.id), players.size) };
      for (const sid of p.sockets) io.sockets.sockets.get(sid)?.emit('state', view);
    }
  }, 60);
}

function clearLockTimer() { if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; } }
function scheduleLock() {
  clearLockTimer();
  lockTimer = setTimeout(() => {
    if (game.phase === 'open') { game.phase = 'locked'; broadcast(); }
  }, Math.max(0, game.endsAt - Date.now()) + 300);
}

function checkIndex(s, q) {
  const sec = quiz.sections[s];
  if (!sec) throw new Error('해당 부문이 없습니다.');
  if (q != null && !sec.questions[q]) throw new Error('해당 문제가 없습니다.');
}

function openQuestion(s, q) {
  checkIndex(s, q);
  game.sIdx = s; game.qIdx = q;
  const question = curQ();
  game.phase = 'open';
  game.message = '';
  game.lastReveal = null;
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + question.time * 1000;
  for (const p of players.values()) { p.answers.delete(question.id); p.results.delete(question.id); }
  scheduleLock();
}

function reveal() {
  const q = curQ();
  if (!q) throw new Error('진행 중인 문제가 없습니다.');
  clearLockTimer();
  game.phase = 'revealed';
  let correctCount = 0, fastest = null;
  for (const p of players.values()) {
    const a = p.answers.get(q.id);
    const correct = !!a && a.choice === q.answer;
    p.results.set(q.id, { correct, points: correct ? q.points : 0, ms: correct ? a.ms : 0 });
    if (correct) {
      correctCount++;
      if (!fastest || a.ms < fastest.ms) fastest = { name: p.name, avatar: p.avatar, ms: a.ms };
    }
  }
  game.lastReveal = { correctCount, answered: answeredCount(), fastest };
}

const adminTokens = new Set();

const commands = {
  intro({ s }) {
    checkIndex(s);
    clearLockTimer();
    Object.assign(game, { phase: 'intro', sIdx: s, qIdx: -1, message: '' });
  },
  start({ s, q }) { openQuestion(s, q); },
  lock() {
    if (game.phase !== 'open') throw new Error('답을 받는 중이 아닙니다.');
    clearLockTimer();
    game.phase = 'locked';
  },
  reveal() {
    if (game.phase !== 'open' && game.phase !== 'locked') throw new Error('공개할 문제가 없습니다.');
    reveal();
  },
  addTime({ seconds }) {
    const s = Number(seconds) || 10;
    if (game.phase === 'open') game.endsAt += s * 1000;
    else if (game.phase === 'locked') { game.phase = 'open'; game.endsAt = Date.now() + s * 1000; }
    else throw new Error('진행 중인 문제가 없습니다.');
    scheduleLock();
  },
  board({ scope }) {
    clearLockTimer();
    if (scope === 'section' && !curSection()) throw new Error('아직 진행한 부문이 없습니다.');
    game.phase = 'board';
    game.boardScope = scope === 'section' ? 'section' : 'total';
  },
  end() { clearLockTimer(); game.phase = 'ended'; },
  toLobby() { clearLockTimer(); game.phase = 'lobby'; },
  resetGame() {
    clearLockTimer();
    Object.assign(game, { phase: 'lobby', sIdx: -1, qIdx: -1, endsAt: 0, message: '', lastReveal: null });
    for (const p of players.values()) { p.answers.clear(); p.results.clear(); p.bonus = 0; }
    return '점수를 모두 0으로 되돌렸습니다';
  },
  clearPlayers() {
    for (const p of players.values()) {
      for (const sid of p.sockets) io.sockets.sockets.get(sid)?.emit('kicked', '진행자가 참가자 목록을 초기화했습니다. 다시 입장해 주세요.');
    }
    players.clear();
  },
  adjust({ id, delta }) {
    const p = players.get(id);
    if (!p) throw new Error('참가자를 찾을 수 없습니다.');
    const d = Math.round(Number(delta));
    if (!Number.isFinite(d) || !d) throw new Error('점수 변경값이 올바르지 않습니다.');
    p.bonus += d;
  },
  kick({ id }) {
    const p = players.get(id);
    if (!p) throw new Error('참가자를 찾을 수 없습니다.');
    for (const sid of p.sockets) io.sockets.sockets.get(sid)?.emit('kicked', '진행자에 의해 퇴장되었습니다.');
    players.delete(id);
  },
  setJoinOpen({ open }) { game.joinOpen = !!open; },
  setJoinUrl({ url }) { game.joinUrl = String(url || '').trim(); },
  setMessage({ text }) { game.message = String(text || '').slice(0, 120); },
  setTitle({ title }) {
    const t = String(title || '').trim().slice(0, 30);
    if (!t) throw new Error('행사 이름을 입력해 주세요.');
    settings.title = t; saveSettings();
    return '행사 이름을 바꿨습니다';
  },
  setTheme({ theme }) {
    settings.theme = GB.sanitizeTheme(theme); saveSettings();
    return '디자인을 모든 화면에 적용했습니다';
  },
  setRules({ tieBreak, showRankToPlayers }) {
    if (tieBreak === 'time' || tieBreak === 'shared') settings.tieBreak = tieBreak;
    if (typeof showRankToPlayers === 'boolean') settings.showRankToPlayers = showRankToPlayers;
    saveSettings();
  },
  saveQuiz({ quiz: next }) {
    const clean = sanitizeQuiz(next);
    const curId = curQ()?.id;
    const curSecId = curSection()?.id;
    let ns = -1, nq = -1;
    clean.sections.forEach((s, si) => {
      if (s.id === curSecId) ns = si;
      s.questions.forEach((q, qi) => { if (q.id === curId) { ns = si; nq = qi; } });
    });
    if ((game.phase === 'open' || game.phase === 'locked') && nq < 0) {
      throw new Error('지금 진행 중인 문제는 삭제할 수 없습니다. 마감·공개한 뒤 수정하세요.');
    }
    quiz = clean;
    saveQuiz();
    if (game.sIdx >= 0) {
      if (ns < 0) Object.assign(game, { phase: game.phase === 'ended' ? 'ended' : 'lobby', sIdx: -1, qIdx: -1 });
      else { game.sIdx = ns; game.qIdx = nq >= 0 ? nq : Math.min(game.qIdx, clean.sections[ns].questions.length - 1); }
    }
    return `${clean.sections.length}개 부문, ${totalQuestions()}문제를 저장했습니다`;
  }
};

function uniqueName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!name) return '';
  const taken = new Set([...players.values()].map(p => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}${i}`)) return `${name}${i}`;
}

io.on('connection', socket => {
  socket.on('screen:hello', () => {
    socket.join('screens');
    socket.emit('state', publicState(ranking()));
  });
  socket.on('screen:peek', () => socket.emit('state', publicState(ranking())));

  socket.on('player:join', ({ name, avatar, playerId } = {}, ack = () => {}) => {
    let p = playerId && players.get(playerId);
    if (!p) {
      if (!game.joinOpen) return ack({ ok: false, error: '지금은 입장이 닫혀 있습니다. 진행자에게 문의하세요.' });
      const n = uniqueName(name);
      if (!n) return ack({ ok: false, error: '닉네임을 입력해 주세요.' });
      if (players.size >= 500) return ack({ ok: false, error: '정원이 가득 찼습니다.' });
      p = {
        id: crypto.randomBytes(8).toString('hex'),
        name: n,
        avatar: GB.AVATARS.includes(avatar) ? avatar : GB.AVATARS[0],
        answers: new Map(),
        results: new Map(),
        bonus: 0,
        sockets: new Set()
      };
      players.set(p.id, p);
    }
    p.sockets.add(socket.id);
    socket.data.playerId = p.id;
    ack({ ok: true, playerId: p.id, name: p.name, avatar: p.avatar });
    broadcast();
  });

  socket.on('player:avatar', ({ avatar } = {}) => {
    const p = players.get(socket.data.playerId);
    if (p && GB.AVATARS.includes(avatar)) { p.avatar = avatar; broadcast(); }
  });

  socket.on('player:answer', ({ choice } = {}, ack = () => {}) => {
    const p = players.get(socket.data.playerId);
    const q = curQ();
    if (!p || !q) return ack({ ok: false, error: '참가 정보가 없습니다.' });
    if (game.phase !== 'open' || Date.now() > game.endsAt) return ack({ ok: false, error: '답안 제출이 마감되었습니다.' });
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return ack({ ok: false, error: '잘못된 보기입니다.' });
    p.answers.set(q.id, { choice: c, ms: Date.now() - game.startedAt });
    ack({ ok: true });
    broadcast();
  });

  socket.on('admin:auth', ({ password, token } = {}, ack = () => {}) => {
    if ((token && adminTokens.has(token)) || password === ADMIN_PASSWORD) {
      const t = token && adminTokens.has(token) ? token : crypto.randomBytes(16).toString('hex');
      adminTokens.add(t);
      socket.data.admin = true;
      socket.join('admins');
      ack({ ok: true, token: t });
      socket.emit('admin:state', adminState(ranking()));
    } else {
      ack({ ok: false, error: '비밀번호가 틀렸습니다.' });
    }
  });

  socket.on('admin:cmd', ({ type, ...args } = {}, ack = () => {}) => {
    if (!socket.data.admin) return ack({ ok: false, error: '관리자 인증이 필요합니다.' });
    const fn = commands[type];
    if (!fn) return ack({ ok: false, error: '알 수 없는 명령입니다.' });
    try {
      const msg = fn(args);
      ack({ ok: true, message: msg || '' });
      broadcast();
    } catch (e) {
      ack({ ok: false, error: e.message });
    }
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.data.playerId);
    if (p) { p.sockets.delete(socket.id); broadcast(); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = defaultJoinUrl();
  console.log(`\n  ${settings.title} 서버 실행 중`);
  console.log('  ─────────────────────────────────────');
  console.log(`  참가자 입장   ${joinUrl()}`);
  console.log(`  큰 화면(QR)   ${lan}screen`);
  console.log(`  관리자        ${lan}admin   (비밀번호: ${process.env.ADMIN_PASSWORD ? '환경변수로 설정됨' : ADMIN_PASSWORD})`);
  console.log('  ─────────────────────────────────────\n');
});
