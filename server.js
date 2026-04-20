// =============================================================
//  server.js — DrawTogether v2 (multi-round)
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

function endRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'drawing') return;

  if (room.roundTimeout) { clearTimeout(room.roundTimeout); room.roundTimeout = null; }
  room.status = 'grading';

  io.to(roomId).emit('round-ended', {
    roundNum:    room.currentRound,
    totalRounds: room.settings.totalRounds,
    word:        room.currentWord,
  });
  console.log(`[R] Round ${room.currentRound} ended in ${roomId}`);
}

// Очистка брошенных комнат (старше 4 часов)
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, room] of Object.entries(rooms)) {
    if (room.createdAt < cutoff) {
      if (room.roundTimeout) clearTimeout(room.roundTimeout);
      delete rooms[id];
      console.log(`[R] Room ${id} expired and removed`);
    }
  }
}, 30 * 60 * 1000);

// =============================================================
//  SOCKET.IO
// =============================================================
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ADMIN: create-room
  socket.on('create-room', ({ canvasWidth, canvasHeight } = {}, cb) => {
    const roomId = makeRoomId();
    rooms[roomId] = {
      adminSocketId:  socket.id,
      status:         'lobby',
      createdAt:      Date.now(),
      settings: {
        totalRounds:  3,
        roundTime:    60,
        canvasWidth:  clamp(+canvasWidth  || 900, 400, 1600),
        canvasHeight: clamp(+canvasHeight || 600, 300, 1000),
        autoClean:    true,
        showWord:     false,   // показывать слово ученикам целиком
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

  // ADMIN: update-settings
  socket.on('update-settings', (patch) => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'lobby') return;

    const s = room.settings;
    if (patch.totalRounds  !== undefined) s.totalRounds  = clamp(+patch.totalRounds, 1, 10);
    if (patch.roundTime    !== undefined) s.roundTime    = clamp(+patch.roundTime, 15, 600);
    if (patch.canvasWidth  !== undefined) s.canvasWidth  = clamp(+patch.canvasWidth, 400, 1600);
    if (patch.canvasHeight !== undefined) s.canvasHeight = clamp(+patch.canvasHeight, 300, 1000);
    if (patch.autoClean    !== undefined) s.autoClean    = !!patch.autoClean;
    if (patch.showWord     !== undefined) s.showWord     = !!patch.showWord;
    if (patch.allowEraser  !== undefined) s.allowEraser  = !!patch.allowEraser;
    if (patch.canvasColor  !== undefined) s.canvasColor  = patch.canvasColor;
  });

  // PLAYER: join-room
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

    let remaining = null;
    if (room.status === 'drawing' && room.roundStartedAt) {
      remaining = Math.max(0, room.settings.roundTime - (Date.now() - room.roundStartedAt) / 1000);
    }

    const wordForPlayer = makeWordDisplay(room);

    console.log(`[P] ${playerName} joined ${roomId} (status=${room.status})`);
    cb({
      status:       room.status,
      settings:     room.settings,
      currentRound: room.currentRound,
      drawHistory:  room.status === 'drawing' ? room.drawHistory : [],
      color,
      grades:       room.grades,
      remaining,
      word:         wordForPlayer,
    });
  });

  // ADMIN: start-game
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

  // ADMIN: start-round
  socket.on('start-round', ({ word } = {}, cb) => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'waiting_word') return;

    room.currentRound++;
    room.currentWord    = (word || '???').trim();
    room.status         = 'drawing';
    room.roundStartedAt = Date.now();

    if (room.settings.autoClean) room.drawHistory = [];

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
      word:        makeWordDisplay(room),   // полное слово если showWord, иначе null
    };

    // Игрокам — без секретного слова
    socket.to(roomId).emit('round-started', roundData);
    // Учителю — со словом всегда
    socket.emit('round-started', { ...roundData, secretWord: room.currentWord });

    if (cb) cb({ ok: true });
    console.log(`[G] Round ${room.currentRound}/${room.settings.totalRounds} in ${roomId}, word="${room.currentWord}"`);
  });

  // ADMIN: stop-round
  socket.on('stop-round', () => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;
    endRound(roomId);
  });

  // ADMIN: give-grade
  socket.on('give-grade', ({ grade } = {}) => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'grading') return;

    const entry = { round: room.currentRound, word: room.currentWord, grade };
    const idx = room.grades.findIndex(g => g.round === room.currentRound);
    if (idx >= 0) room.grades[idx] = entry; else room.grades.push(entry);

    socket.to(roomId).emit('grade-received', { grade, roundNum: room.currentRound, word: room.currentWord });
  });

  // ADMIN: next-round
  socket.on('next-round', () => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'grading') return;

    if (room.currentRound >= room.settings.totalRounds) {
      room.status = 'finished';
      io.to(roomId).emit('game-finished', { grades: room.grades });
      console.log(`[G] Game finished in ${roomId}`);
    } else {
      room.status = 'waiting_word';
      io.to(roomId).emit('waiting-for-word', {
        currentRound: room.currentRound,
        totalRounds:  room.settings.totalRounds,
      });
    }
  });

  // PLAYER: draw — OPTIMIZED: throttle 16ms (~60fps)
  const drawThrottle = {};
  socket.on('draw', (data) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.status !== 'drawing') return;

    const now = Date.now();
    const lastDraw = drawThrottle[socket.id] || 0;
    if (now - lastDraw < 16) {
      // Буферизация для отправки позже
      if (!room.drawBuffer) room.drawBuffer = [];
      room.drawBuffer.push(data);
      return;
    }
    
    drawThrottle[socket.id] = now;
    
    // Отправка буферизированных данных
    if (room.drawBuffer && room.drawBuffer.length > 0) {
      const batch = room.drawBuffer.splice(0, 10);
      batch.forEach(d => {
        if (room.drawHistory.length < 20000) room.drawHistory.push(d);
      });
      socket.to(roomId).emit('draw-batch', batch);
    }
    
    if (room.drawHistory.length < 20000) room.drawHistory.push(data);
    socket.to(roomId).emit('draw', data);
  });

  // PLAYER: cursor-move — OPTIMIZED: throttle 50ms + only when changed significantly
  let lastCursorEmit = 0;
  let lastCursorPos = { x: 0, y: 0 };
  socket.on('cursor-move', ({ x, y }) => {
    const { roomId } = socket.data;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    
    const now = Date.now();
    const dx = x - lastCursorPos.x;
    const dy = y - lastCursorPos.y;
    
    // Отправляем только если прошло 50мс ИЛИ курсор сместился значительно
    if (now - lastCursorEmit < 50 && Math.sqrt(dx*dx + dy*dy) < 5) return;
    
    lastCursorEmit = now;
    lastCursorPos = { x, y };
    socket.to(roomId).emit('cursor-move', { id: socket.id, name: player.name, color: player.color, x, y });
  });

  // ADMIN: clear-canvas
  socket.on('clear-canvas', () => {
    const { roomId, role } = socket.data;
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;
    room.drawHistory = [];
    io.to(roomId).emit('canvas-cleared', { canvasColor: room.settings.canvasColor });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const { roomId, role } = socket.data || {};
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    if (role === 'player') {
      delete room.players[socket.id];
      // Очистка буфера при отключении
      if (room.drawBuffer) room.drawBuffer = room.drawBuffer.filter(d => true);
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

// Если showWord=true → полное слово, иначе null
function makeWordDisplay(room) {
  if (!room.settings.showWord || !room.currentWord) return null;
  return room.currentWord;
}

// =============================================================
//  СТАРТ
// =============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎨  DrawTogether v2  →  http://localhost:${PORT}\n`);
});
