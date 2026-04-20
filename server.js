// =============================================================
//  server.js — DrawTogether v2 (multi-round)
//
//  Машина состояний комнаты:
//  lobby → waiting_word → drawing → grading → waiting_word → ... → finished
// =============================================================

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// =============================================================
//  СТРУКТУРА КОМНАТЫ
//  rooms[roomId] = {
//    adminSocketId   : string
//    status          : 'lobby'|'waiting_word'|'drawing'|'grading'|'finished'
//    settings        : Settings
//    currentRound    : number          (0 до старта)
//    currentWord     : string
//    grades          : GradeEntry[]    [{round, word, grade}]
//    players         : { [sid]: {name, color} }
//    drawHistory     : DrawEvent[]
//    roundStartedAt  : number|null     (Date.now() при старте раунда)
//    roundTimeout    : Timeout|null    (авто-стоп по таймеру)
//  }
//
//  Settings = {
//    totalRounds  : 1-10           (кол-во раундов)
//    roundTime    : секунды        (время раунда)
//    canvasWidth  : px
//    canvasHeight : px
//    autoClean    : bool           (чистить холст между раундами)
//    showHint     : bool           (первая буква слова ученикам)
//    allowEraser  : bool           (разрешить ластик ученикам)
//    canvasColor  : hex            (цвет фона холста)
//  }
// =============================================================
const rooms = {};

const PALETTE = [
  '#E53935','#1E88E5','#43A047','#FB8C00',
  '#8E24AA','#00ACC1','#F4511E','#3949AB',
  '#00897B','#C0CA33','#D81B60','#6D4C41'
];

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function pickColor(room) {
  const used = Object.values(room.players).map(p => p.color);
  return PALETTE.find(c => !used.includes(c)) || PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

/** Завершить текущий раунд — переход в grading */
function endRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'drawing') return;

  if (room.roundTimeout) { clearTimeout(room.roundTimeout); room.roundTimeout = null; }
  room.status = 'grading';

  io.to(roomId).emit('round-ended', {
    roundNum:    room.currentRound,
    totalRounds: room.settings.totalRounds,
    word:        room.currentWord,           // чтобы игрок узнал слово после раунда
  });

  console.log(`[R] Round ${room.currentRound} ended in ${roomId}, word="${room.currentWord}"`);
}

// =============================================================
//  SOCKET.IO
// =============================================================
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // -----------------------------------------------------------
  //  ADMIN: create-room
  //  Payload : { canvasWidth, canvasHeight }
  //  Callback: { roomId }
  // -----------------------------------------------------------
  socket.on('create-room', ({ canvasWidth, canvasHeight } = {}, cb) => {
    const roomId = makeRoomId();

    rooms[roomId] = {
      adminSocketId:  socket.id,
      status:         'lobby',
      settings: {
        totalRounds:  3,
        roundTime:    60,
        canvasWidth:  clamp(+canvasWidth  || 900, 400, 1600),
        canvasHeight: clamp(+canvasHeight || 600, 300, 1000),
        autoClean:    true,
        showHint:     false,
        allowEraser:  true,
        canvasColor:  '#ffffff',
      },
      currentRound:   0,
      currentWord:    '',
      grades:         [],
      players:        {},
      drawHistory:    [],
      roundStartedAt: null,
      roundTimeout:   null,
    };

    socket.join(roomId);
    socket.data = { roomId, role: 'admin' };
    console.log(`[R] Created ${roomId}`);
    cb({ roomId });
  });

  // -----------------------------------------------------------
  //  ADMIN: update-settings — можно вызывать несколько раз до старта
  //  Payload: Partial<Settings>
  // -----------------------------------------------------------
  socket.on('update-settings', (patch) => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'lobby') return;

    // Валидация и применение
    const s = room.settings;
    if (patch.totalRounds  !== undefined) s.totalRounds  = clamp(+patch.totalRounds, 1, 10);
    if (patch.roundTime    !== undefined) s.roundTime    = clamp(+patch.roundTime, 15, 600);
    if (patch.canvasWidth  !== undefined) s.canvasWidth  = clamp(+patch.canvasWidth, 400, 1600);
    if (patch.canvasHeight !== undefined) s.canvasHeight = clamp(+patch.canvasHeight, 300, 1000);
    if (patch.autoClean    !== undefined) s.autoClean    = !!patch.autoClean;
    if (patch.showHint     !== undefined) s.showHint     = !!patch.showHint;
    if (patch.allowEraser  !== undefined) s.allowEraser  = !!patch.allowEraser;
    if (patch.canvasColor  !== undefined) s.canvasColor  = patch.canvasColor;
  });

  // -----------------------------------------------------------
  //  PLAYER: join-room
  //  Payload : { roomId, playerName }
  //  Callback: { status, settings, currentRound, drawHistory,
  //              color, grades, remaining, hint } | { error }
  // -----------------------------------------------------------
  socket.on('join-room', ({ roomId, playerName } = {}, cb) => {
    const room = rooms[roomId];
    if (!room)                         return cb({ error: 'Комната не найдена. Проверь ID.' });
    if (room.status === 'finished')    return cb({ error: 'Игра уже завершена.' });

    const color = pickColor(room);
    room.players[socket.id] = { name: playerName, color };
    socket.join(roomId);
    socket.data = { roomId, role: 'player', playerName, color };

    io.to(room.adminSocketId).emit('player-joined', {
      id: socket.id, name: playerName, color,
      playerCount: Object.keys(room.players).length,
    });

    // Для опоздавших — сколько секунд осталось в текущем раунде
    let remaining = null;
    if (room.status === 'drawing' && room.roundStartedAt) {
      remaining = Math.max(0, room.settings.roundTime - (Date.now() - room.roundStartedAt) / 1000);
    }

    // Подсказка (только если показывать и слово уже загадано)
    const hint = makeHint(room);

    console.log(`[P] ${playerName} joined ${roomId} (status=${room.status})`);

    cb({
      status:       room.status,
      settings:     room.settings,
      currentRound: room.currentRound,
      drawHistory:  room.status === 'drawing' ? room.drawHistory : [],
      color,
      grades:       room.grades,
      remaining,
      hint,
    });
  });

  // -----------------------------------------------------------
  //  ADMIN: start-game — перевод в waiting_word, раунды ещё не идут
  // -----------------------------------------------------------
  socket.on('start-game', () => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;

    room.status       = 'waiting_word';
    room.currentRound = 0;
    room.grades       = [];
    room.drawHistory  = [];

    io.to(roomId).emit('game-started', { settings: room.settings });
    console.log(`[G] Game started in ${roomId}`);
  });

  // -----------------------------------------------------------
  //  ADMIN: start-round — учитель вводит слово, начинается раунд
  //  Payload: { word }
  // -----------------------------------------------------------
  socket.on('start-round', ({ word } = {}, cb) => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;
    if (room.status !== 'waiting_word') return;

    room.currentRound++;
    room.currentWord    = (word || '???').trim();
    room.status         = 'drawing';
    room.roundStartedAt = Date.now();

    if (room.settings.autoClean) room.drawHistory = [];

    // Таймер авто-финиша раунда на сервере
    if (room.roundTimeout) clearTimeout(room.roundTimeout);
    room.roundTimeout = setTimeout(() => endRound(roomId), room.settings.roundTime * 1000);

    const roundData = {
      roundNum:    room.currentRound,
      totalRounds: room.settings.totalRounds,
      duration:    room.settings.roundTime,
      canvasWidth: room.settings.canvasWidth,
      canvasHeight:room.settings.canvasHeight,
      allowEraser: room.settings.allowEraser,
      canvasColor: room.settings.canvasColor,
      hint:        makeHint(room),
    };

    // Игрокам — без слова
    socket.to(roomId).emit('round-started', roundData);
    // Учителю — со словом
    socket.emit('round-started', { ...roundData, word: room.currentWord });

    if (cb) cb({ ok: true });
    console.log(`[G] Round ${room.currentRound}/${room.settings.totalRounds} started in ${roomId}, word="${room.currentWord}"`);
  });

  // -----------------------------------------------------------
  //  ADMIN: stop-round — досрочная остановка раунда
  // -----------------------------------------------------------
  socket.on('stop-round', () => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;
    endRound(roomId);
  });

  // -----------------------------------------------------------
  //  ADMIN: give-grade
  //  Payload: { grade }   (null = без оценки)
  // -----------------------------------------------------------
  socket.on('give-grade', ({ grade } = {}) => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'grading') return;

    const entry = { round: room.currentRound, word: room.currentWord, grade };
    // Перезаписать если уже была оценка за этот раунд
    const idx = room.grades.findIndex(g => g.round === room.currentRound);
    if (idx >= 0) room.grades[idx] = entry; else room.grades.push(entry);

    // Уведомить игроков
    socket.to(roomId).emit('grade-received', { grade, roundNum: room.currentRound, word: room.currentWord });
  });

  // -----------------------------------------------------------
  //  ADMIN: next-round — следующий раунд или конец игры
  // -----------------------------------------------------------
  socket.on('next-round', () => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'grading') return;

    if (room.currentRound >= room.settings.totalRounds) {
      // Игра завершена
      room.status = 'finished';
      io.to(roomId).emit('game-finished', { grades: room.grades });
      console.log(`[G] Game finished in ${roomId}`);
    } else {
      // Следующий раунд — ждём слово
      room.status = 'waiting_word';
      io.to(roomId).emit('waiting-for-word', {
        currentRound: room.currentRound,
        totalRounds:  room.settings.totalRounds,
      });
    }
  });

  // -----------------------------------------------------------
  //  PLAYER: draw — сохранить в историю и раздать всем
  // -----------------------------------------------------------
  socket.on('draw', (data) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.status !== 'drawing') return;

    if (room.drawHistory.length < 20000) room.drawHistory.push(data);
    socket.to(roomId).emit('draw', data);
  });

  // -----------------------------------------------------------
  //  PLAYER: cursor-move — живые курсоры
  // -----------------------------------------------------------
  socket.on('cursor-move', ({ x, y }) => {
    const { roomId } = socket.data;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    socket.to(roomId).emit('cursor-move', { id: socket.id, name: player.name, color: player.color, x, y });
  });

  // -----------------------------------------------------------
  //  ADMIN: clear-canvas
  // -----------------------------------------------------------
  socket.on('clear-canvas', () => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;
    room.drawHistory = [];
    io.to(roomId).emit('canvas-cleared', { canvasColor: room.settings.canvasColor });
  });

  // -----------------------------------------------------------
  //  DISCONNECT
  // -----------------------------------------------------------
  socket.on('disconnect', () => {
    const { roomId, role } = socket.data || {};
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    if (role === 'player') {
      delete room.players[socket.id];
      const playerCount = Object.keys(room.players).length;
      io.to(room.adminSocketId).emit('player-left', { id: socket.id, playerCount });
    } else if (role === 'admin') {
      if (room.roundTimeout) clearTimeout(room.roundTimeout);
      io.to(roomId).emit('admin-disconnected');
      delete rooms[roomId];
      console.log(`[R] Room ${roomId} closed`);
    }
    console.log(`[-] ${socket.id} (${role})`);
  });
});

// =============================================================
//  УТИЛИТЫ
// =============================================================
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function makeHint(room) {
  if (!room.settings.showHint || !room.currentWord) return null;
  return room.currentWord[0] + '_ '.repeat(room.currentWord.length - 1).trim();
}

// =============================================================
//  СТАРТ
// =============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎨  DrawTogether v2  →  http://localhost:${PORT}\n`);
});
