// 골든벨 — 실시간 객관식 서바이벌 퀴즈 서버
// 실행: npm install && npm start
// 환경변수: PORT(기본 3000), ADMIN_PASSWORD(기본 goldenbell), PUBLIC_URL(QR에 넣을 주소, 선택), EVENT_TITLE(행사 이름, 선택)

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'goldenbell';
const Q_FILE = path.join(__dirname, 'questions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ---------- 행사 설정 ----------
let settings = { title: process.env.EVENT_TITLE || '골든벨' };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { console.warn('settings.json 저장 실패:', e.message); }
}

// ---------- 문제 ----------
function sanitizeQuestions(list) {
  if (!Array.isArray(list)) throw new Error('문제 목록 형식이 아닙니다.');
  return list.map((q, i) => {
    const text = String(q.text || '').trim();
    const options = (Array.isArray(q.options) ? q.options : []).map(o => String(o).trim()).filter(Boolean);
    const answer = Number(q.answer);
    const time = Math.max(3, Math.min(300, Number(q.time) || 20));
    if (!text) throw new Error(`${i + 1}번 문제의 질문이 비어 있습니다.`);
    if (options.length < 2 || options.length > 5) throw new Error(`${i + 1}번 문제의 보기는 2~5개여야 합니다.`);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw new Error(`${i + 1}번 문제의 정답 번호가 올바르지 않습니다.`);
    return { text, options, answer, time };
  });
}

let questions = [];
try {
  questions = sanitizeQuestions(JSON.parse(fs.readFileSync(Q_FILE, 'utf8')));
} catch (e) {
  console.warn('questions.json을 읽지 못했습니다:', e.message);
  questions = [];
}
function saveQuestions() {
  try { fs.writeFileSync(Q_FILE, JSON.stringify(questions, null, 2)); } catch (e) { console.warn('questions.json 저장 실패:', e.message); }
}

// ---------- 게임 상태 ----------
// phase: lobby(대기) → open(답 받는 중) → locked(마감) → revealed(정답 공개) → … → ended(종료)
const game = {
  phase: 'lobby',
  qIndex: -1,
  endsAt: 0,
  pausedLeft: 0,
  joinOpen: true,
  joinUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
  lastEliminated: [],
  message: ''
};
const players = new Map(); // id -> player
let lockTimer = null;

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return 'localhost';
}
function defaultJoinUrl() {
  return `http://${lanAddress()}:${PORT}/`;
}
function joinUrl() {
  return game.joinUrl || defaultJoinUrl();
}

function currentQ() {
  return game.qIndex >= 0 ? questions[game.qIndex] : null;
}
function alivePlayers() {
  return [...players.values()].filter(p => p.alive);
}
function timeLeft() {
  if (game.phase !== 'open') return 0;
  return Math.max(0, game.endsAt - Date.now());
}
function distribution() {
  const q = currentQ();
  if (!q) return [];
  const d = q.options.map(() => 0);
  for (const p of players.values()) {
    if (p.answerQ === game.qIndex && p.answer != null && p.aliveAtStart) d[p.answer]++;
  }
  return d;
}
function answeredCount() {
  let n = 0;
  for (const p of players.values()) if (p.aliveAtStart && p.answerQ === game.qIndex && p.answer != null) n++;
  return n;
}
function contenders() {
  return [...players.values()].filter(p => p.aliveAtStart);
}

function publicState() {
  const q = currentQ();
  const showAnswer = game.phase === 'revealed';
  const showDist = game.phase === 'revealed';
  const alive = alivePlayers();
  return {
    title: settings.title,
    phase: game.phase,
    qIndex: game.qIndex,
    qTotal: questions.length,
    question: q && game.phase !== 'lobby'
      ? { text: q.text, options: q.options, time: q.time, answer: showAnswer ? q.answer : null }
      : null,
    timeLeft: timeLeft(),
    joinOpen: game.joinOpen,
    joinUrl: joinUrl(),
    total: players.size,
    aliveCount: alive.length,
    contenders: contenders().length,
    answered: answeredCount(),
    distribution: showDist ? distribution() : null,
    survivors: (game.phase === 'revealed' || game.phase === 'ended' || game.phase === 'lobby')
      ? alive.map(p => p.name) : null,
    eliminatedNow: game.phase === 'revealed' ? game.lastEliminated : [],
    message: game.message,
    serverNow: Date.now()
  };
}

function playerView(p) {
  return {
    id: p.id,
    name: p.name,
    alive: p.alive,
    answer: p.answerQ === game.qIndex ? p.answer : null,
    canAnswer: game.phase === 'open' && p.alive && p.aliveAtStart,
    correctCount: p.correctCount,
    eliminatedAt: p.eliminatedAt
  };
}

function adminState() {
  const q = currentQ();
  return {
    ...publicState(),
    liveDistribution: distribution(),
    currentAnswer: q ? q.answer : null,
    questions,
    defaultJoinUrl: defaultJoinUrl(),
    players: [...players.values()]
      .sort((a, b) => (b.alive - a.alive) || a.name.localeCompare(b.name, 'ko'))
      .map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.sockets.size > 0,
        answer: p.answerQ === game.qIndex ? p.answer : null,
        contender: p.aliveAtStart,
        correctCount: p.correctCount,
        eliminatedAt: p.eliminatedAt
      }))
  };
}

// ---------- 서버 ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#10122b', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) {
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
    const pub = publicState();
    io.to('screens').emit('state', pub);
    io.to('admins').emit('admin:state', adminState());
    for (const p of players.values()) {
      for (const sid of p.sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('state', { ...pub, me: playerView(p) });
      }
    }
  }, 60);
}

function clearLockTimer() {
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}
function scheduleLock() {
  clearLockTimer();
  lockTimer = setTimeout(() => {
    if (game.phase === 'open') { game.phase = 'locked'; broadcast(); }
  }, Math.max(0, game.endsAt - Date.now()) + 300);
}

function openQuestion(idx) {
  if (!questions[idx]) throw new Error('해당 번호의 문제가 없습니다.');
  game.qIndex = idx;
  game.phase = 'open';
  game.lastEliminated = [];
  game.message = '';
  game.endsAt = Date.now() + questions[idx].time * 1000;
  for (const p of players.values()) {
    p.aliveAtStart = p.alive;
    p.answer = null;
    p.answerQ = idx;
  }
  scheduleLock();
}

function reveal() {
  const q = currentQ();
  if (!q) throw new Error('진행 중인 문제가 없습니다.');
  clearLockTimer();
  game.phase = 'revealed';
  const out = [];
  for (const p of players.values()) {
    if (!p.aliveAtStart) continue;
    if (p.answerQ === game.qIndex && p.answer === q.answer) {
      p.correctCount++;
    } else if (p.alive) {
      p.alive = false;
      p.eliminatedAt = game.qIndex;
      out.push(p.name);
    }
  }
  game.lastEliminated = out;
  const left = alivePlayers().length;
  if (left === 0) game.message = '전원 탈락! 패자부활을 진행할 수 있습니다.';
  else if (left === 1) game.message = '최후의 1인!';
  else game.message = '';
}

const adminTokens = new Set();

const commands = {
  start({ index }) {
    const idx = Number.isInteger(index) ? index : game.qIndex + 1;
    openQuestion(idx);
  },
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
    if (game.phase === 'open') {
      game.endsAt += s * 1000;
    } else if (game.phase === 'locked') {
      game.phase = 'open';
      game.endsAt = Date.now() + s * 1000;
    } else throw new Error('진행 중인 문제가 없습니다.');
    scheduleLock();
  },
  end() {
    clearLockTimer();
    game.phase = 'ended';
  },
  toLobby() {
    clearLockTimer();
    game.phase = 'lobby';
  },
  resetGame() {
    clearLockTimer();
    Object.assign(game, { phase: 'lobby', qIndex: -1, endsAt: 0, lastEliminated: [], message: '' });
    for (const p of players.values()) {
      Object.assign(p, { alive: true, aliveAtStart: true, answer: null, answerQ: -1, correctCount: 0, eliminatedAt: null });
    }
  },
  clearPlayers() {
    for (const p of players.values()) {
      for (const sid of p.sockets) io.sockets.sockets.get(sid)?.emit('kicked', '진행자가 참가자 목록을 초기화했습니다. 다시 입장해 주세요.');
    }
    players.clear();
  },
  revive({ ids, mode }) {
    let targets = [];
    if (mode === 'all') targets = [...players.values()].filter(p => !p.alive);
    else if (mode === 'last') {
      const names = new Set(game.lastEliminated);
      targets = [...players.values()].filter(p => !p.alive && p.eliminatedAt === game.qIndex && names.has(p.name));
    } else targets = (ids || []).map(id => players.get(id)).filter(Boolean);
    for (const p of targets) { p.alive = true; p.eliminatedAt = null; }
    if (alivePlayers().length > 0 && game.message.startsWith('전원 탈락')) game.message = '패자부활!';
    return `${targets.length}명 부활`;
  },
  eliminate({ id }) {
    const p = players.get(id);
    if (!p) throw new Error('참가자를 찾을 수 없습니다.');
    p.alive = false;
    p.eliminatedAt = game.qIndex;
  },
  kick({ id }) {
    const p = players.get(id);
    if (!p) throw new Error('참가자를 찾을 수 없습니다.');
    for (const sid of p.sockets) io.sockets.sockets.get(sid)?.emit('kicked', '진행자에 의해 퇴장되었습니다.');
    players.delete(id);
  },
  setJoinOpen({ open }) {
    game.joinOpen = !!open;
  },
  setJoinUrl({ url }) {
    game.joinUrl = String(url || '').trim();
  },
  setTitle({ title }) {
    const t = String(title || '').trim().slice(0, 30);
    if (!t) throw new Error('행사 이름을 입력해 주세요.');
    settings.title = t;
    saveSettings();
    return '행사 이름 변경됨';
  },
  setMessage({ text }) {
    game.message = String(text || '').slice(0, 120);
  },
  saveQuestions({ list }) {
    const clean = sanitizeQuestions(list);
    if ((game.phase === 'open' || game.phase === 'locked') && clean.length <= game.qIndex) {
      throw new Error('진행 중인 문제 번호보다 문제 수가 적어질 수 없습니다.');
    }
    questions = clean;
    saveQuestions();
    return `${clean.length}문제 저장됨`;
  }
};

function uniqueName(raw) {
  let name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!name) return '';
  const taken = new Set([...players.values()].map(p => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}${i}`)) return `${name}${i}`;
}

io.on('connection', socket => {
  socket.data.playerId = null;

  socket.on('screen:hello', () => {
    socket.join('screens');
    socket.emit('state', publicState());
  });

  // 입장 전 화면이 행사 이름 등을 받아 가는 용도 (브로드캐스트 대상 아님)
  socket.on('screen:peek', () => {
    socket.emit('state', publicState());
  });

  socket.on('player:join',({ name, playerId } = {}, ack = () => {}) => {
    let p = playerId && players.get(playerId);
    if (!p) {
      if (!game.joinOpen) return ack({ ok: false, error: '지금은 입장이 닫혀 있습니다. 진행자에게 문의하세요.' });
      const n = uniqueName(name);
      if (!n) return ack({ ok: false, error: '닉네임을 입력해 주세요.' });
      if (players.size >= 500) return ack({ ok: false, error: '정원이 가득 찼습니다.' });
      const inGame = game.qIndex >= 0 && game.phase !== 'lobby';
      p = {
        id: crypto.randomBytes(8).toString('hex'),
        name: n,
        alive: !inGame,            // 게임 도중 입장하면 관전(탈락) 상태로 시작
        aliveAtStart: false,
        answer: null,
        answerQ: -1,
        correctCount: 0,
        eliminatedAt: inGame ? game.qIndex : null,
        lateJoin: inGame,
        sockets: new Set()
      };
      players.set(p.id, p);
    }
    p.sockets.add(socket.id);
    socket.data.playerId = p.id;
    ack({ ok: true, playerId: p.id, name: p.name });
    broadcast();
  });

  socket.on('player:answer', ({ choice } = {}, ack = () => {}) => {
    const p = players.get(socket.data.playerId);
    const q = currentQ();
    if (!p || !q) return ack({ ok: false, error: '참가 정보가 없습니다.' });
    if (game.phase !== 'open' || Date.now() > game.endsAt) return ack({ ok: false, error: '답안 제출이 마감되었습니다.' });
    if (!p.alive || !p.aliveAtStart) return ack({ ok: false, error: '탈락한 상태에서는 답할 수 없습니다.' });
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return ack({ ok: false, error: '잘못된 보기입니다.' });
    p.answer = c;
    p.answerQ = game.qIndex;
    ack({ ok: true });
    broadcast();
  });

  socket.on('admin:auth', ({ password, token } = {}, ack = () => {}) => {
    if ((token && adminTokens.has(token)) || password === ADMIN_PASSWORD) {
      const t = token && adminTokens.has(token) ? token : crypto.randomBytes(16).toString('hex');
      adminTokens.add(t);
      socket.data.admin = true;
      socket.join('admins');
      socket.join('screens');
      ack({ ok: true, token: t });
      socket.emit('admin:state', adminState());
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
