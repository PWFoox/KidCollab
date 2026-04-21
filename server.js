// =============================================================
//  server.js — DrawTogether v2
//  Состояния: lobby → waiting_word → drawing → grading → ... → finished
// =============================================================

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  httpCompression: true,
  perMessageDeflate: true,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

const rooms = {};

const PALETTE = [
  '#E53935','#1E88E5','#43A047','#FB8C00',
  '#8E24AA','#00ACC1','#F4511E','#3949AB',
  '#00897B','#C0CA33','#D81B60','#6D4C41',
];

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function pickColor(room) {
  const used = Object.values(room.players).map(p => p.color);
  return PALETTE.find(c => !used.includes(c))
    ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
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
  console.log(`[R] Round ${room.currentRound} ended  room=${roomId}`);
}

// Чистка комнат старше 4 часов (каждые 30 мин)
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, room] of Object.entries(rooms)) {
    if (room.createdAt < cutoff) {
      if (room.roundTimeout) clearTimeout(room.roundTimeout);
      delete rooms[id];
      console.log(`[R] Room ${id} expired`);
    }
  }
}, 30 * 60 * 1000);

// =============================================================
//  SOCKET.IO
// =============================================================
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ── ADMIN: create-room ───────────────────────────────────
  socket.on('create-room', ({ canvasWidth, canvasHeight } = {}, cb) => {
    const roomId = makeRoomId();
    rooms[roomId] = {
      adminSocketId: socket.id,
      status:        'lobby',
      createdAt:     Date.now(),
      settings: {
        totalRounds:  3,
        roundTime:    60,
        canvasWidth:  clamp(+canvasWidth  || 900, 400, 1600),
        canvasHeight: clamp(+canvasHeight || 600, 300, 1000),
        autoClean:    true,
        showWord:     false,
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

  // ── ADMIN: update-settings ───────────────────────────────
  socket.on('update-settings', patch => {
    const { roomId, role } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'lobby') return;

    const s = room.settings;
    if (patch.totalRounds  != null) s.totalRounds  = clamp(+patch.totalRounds,  1, 10);
    if (patch.roundTime    != null) s.roundTime    = clamp(+patch.roundTime,    15, 600);
    if (patch.canvasWidth  != null) s.canvasWidth  = clamp(+patch.canvasWidth,  400, 1600);
    if (patch.canvasHeight != null) s.canvasHeight = clamp(+patch.canvasHeight, 300, 1000);
    if (patch.autoClean    != null) s.autoClean    = !!patch.autoClean;
    if (patch.showWord     != null) s.showWord     = !!patch.showWord;
    if (patch.allowEraser  != null) s.allowEraser  = !!patch.allowEraser;
    if (patch.canvasColor  != null) s.canvasColor  = String(patch.canvasColor).slice(0, 7);
  });

  // ── PLAYER: join-room ────────────────────────────────────
  socket.on('join-room', ({ roomId, playerName } = {}, cb) => {
    const room = rooms[roomId];
    if (!room)                      return cb({ error: 'Комната не найдена.' });
    if (room.status === 'finished') return cb({ error: 'Игра уже завершена.' });

    const color = pickColor(room);
    room.players[socket.id] = { name: playerName, color };
    socket.join(roomId);
    socket.data = { roomId, role: 'player', playerName, color };

    io.to(room.adminSocketId).emit('player-joined', {
      id: socket.id, name: playerName, color,
      playerCount: Object.keys(room.players).length,
    });

    let remaining = null;
    if (room.status === 'drawing' && room.roundStartedAt)
      remaining = Math.max(0,
        room.settings.roundTime - (Date.now() - room.roundStartedAt) / 1000);

    cb({
      status:       room.status,
      settings:     room.settings,
      currentRound: room.currentRound,
      drawHistory:  room.status === 'drawing' ? room.drawHistory : [],
      color,
      grades:       room.grades,
      remaining,
      word:         wordDisplay(room),
    });
    console.log(`[P] ${playerName} joined ${roomId} (${room.status})`);
  });

  // ── ADMIN: start-game ────────────────────────────────────
  socket.on('start-game', () => {
    const { roomId, role } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;

    room.status       = 'waiting_word';
    room.currentRound = 0;
    room.grades       = [];
    room.drawHistory  = [];

    io.to(roomId).emit('game-started', { settings: room.settings });
    console.log(`[G] Game started  room=${roomId}`);
  });

  // ── ADMIN: start-round ───────────────────────────────────
  socket.on('start-round', ({ word } = {}, cb) => {
    const { roomId, role } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'waiting_word') return;

    room.currentRound++;
    room.currentWord    = (word || '???').trim().slice(0, 40);
    room.status         = 'drawing';
    room.roundStartedAt = Date.now();

    if (room.settings.autoClean) room.drawHistory = [];

    if (room.roundTimeout) clearTimeout(room.roundTimeout);
    room.roundTimeout = setTimeout(
      () => endRound(roomId),
      room.settings.roundTime * 1000,
    );

    const base = {
      roundNum:    room.currentRound,
      totalRounds: room.settings.totalRounds,
      duration:    room.settings.roundTime,
      canvasWidth: room.settings.canvasWidth,
      canvasHeight:room.settings.canvasHeight,
      allowEraser: room.settings.allowEraser,
      canvasColor: room.settings.canvasColor,
      word:        wordDisplay(room),
    };

    socket.to(roomId).emit('round-started', base);
    socket.emit('round-started', { ...base, secretWord: room.currentWord });

    if (cb) cb({ ok: true });
    console.log(`[G] Round ${room.currentRound}/${room.settings.totalRounds}  word="${room.currentWord}"`);
  });

  // ── ADMIN: stop-round ────────────────────────────────────
  socket.on('stop-round', () => {
    const { roomId, role } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;
    endRound(roomId);
  });

  // ── ADMIN: give-grade ────────────────────────────────────
  socket.on('give-grade', ({ grade } = {}) => {
    const { roomId, role } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'grading') return;

    const entry = { round: room.currentRound, word: room.currentWord, grade };
    const idx   = room.grades.findIndex(g => g.round === room.currentRound);
    if (idx >= 0) room.grades[idx] = entry; else room.grades.push(entry);

    socket.to(roomId).emit('grade-received', {
      grade, roundNum: room.currentRound, word: room.currentWord,
    });
  });

  // ── ADMIN: next-round ────────────────────────────────────
  socket.on('next-round', () => {
    const { roomId, role } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || role !== 'admin' || room.status !== 'grading') return;

    if (room.currentRound >= room.settings.totalRounds) {
      room.status = 'finished';
      io.to(roomId).emit('game-finished', { grades: room.grades });
      console.log(`[G] Game finished  room=${roomId}`);
    } else {
      room.status = 'waiting_word';
      io.to(roomId).emit('waiting-for-word', {
        currentRound: room.currentRound,
        totalRounds:  room.settings.totalRounds,
      });
    }
  });

  // ── PLAYER: draw ─────────────────────────────────────────
  socket.on('draw', data => {
    const { roomId } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || room.status !== 'drawing') return;

    if (room.drawHistory.length < 25_000) room.drawHistory.push(data);
    socket.to(roomId).emit('draw', data);
  });

  // ── PLAYER: cursor-move ──────────────────────────────────
  // Per-socket переменные (внутри closure) — не разделяются между соединениями
  let lastCursorAt = 0;
  let lastCX = 0, lastCY = 0;

  socket.on('cursor-move', ({ x, y }) => {
    const { roomId } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    const now = Date.now();
    const dx = x - lastCX, dy = y - lastCY;
    if (now - lastCursorAt < 40 && dx * dx + dy * dy < 16) return;
    lastCursorAt = now; lastCX = x; lastCY = y;

    socket.to(roomId).emit('cursor-move', {
      id: socket.id, name: player.name, color: player.color, x, y,
    });
  });

  // ── ADMIN: clear-canvas ──────────────────────────────────
  socket.on('clear-canvas', () => {
    const { roomId, role } = socket.data ?? {};
    const room = rooms[roomId];
    if (!room || role !== 'admin') return;
    room.drawHistory = [];
    io.to(roomId).emit('canvas-cleared', { canvasColor: room.settings.canvasColor });
  });

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomId, role } = socket.data ?? {};
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

function wordDisplay(room) {
  return room.settings.showWord && room.currentWord ? room.currentWord : null;
}

// =============================================================
//  СТАРТ
// =============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`\n🎨  DrawTogether v2  →  http://localhost:${PORT}\n`));
