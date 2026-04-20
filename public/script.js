// =============================================================
//  script.js — DrawTogether v2
// =============================================================

const App = (() => {

  const socket = io();

  // =============================================================
  //  СОСТОЯНИЕ
  // =============================================================
  const S = {
    role:         null,
    roomId:       null,
    myName:       null,
    myColor:      null,
    gameStatus:   null,
    currentRound: 0,
    totalRounds:  3,
    word:         null,
    allowEraser:  true,
    grades:       [],

    // Canvas
    canvas:        null,
    ctx:           null,
    previewCanvas: null,
    previewCtx:    null,
    isDrawing:     false,
    lastX: 0, lastY: 0,
    lastClientX: undefined, lastClientY: undefined,
    shapeStart:    null,

    // Tools
    tool:       'brush',
    brushColor: '#1a1a1a',
    brushSize:  6,
    filled:     false,

    // Timer — FIX: используем Date.now() вместо счётчика
    timerTotal:    60,
    timerStartAt:  null,
    timerStartLeft:60,
    timerInterval: null,

    // Settings (admin)
    settings: {
      totalRounds: 3,
      roundTime:   60,
      autoClean:   true,
      showWord:    false,
      allowEraser: true,
      canvasColor: '#ffffff',
      canvasWidth: 900,
      canvasHeight:600,
    },

    // FIX: флаг против повторного навешивания слушателей
    _toolbarBound: false,
  };

  const cursors = {};

  // Инструменты в порядке добавления в тулбар
  const TOOLS = ['brush', 'eraser', 'line', 'rect', 'ellipse', 'spray'];

  // =============================================================
  //  НАВИГАЦИЯ
  // =============================================================
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function goAdminSetup() { showScreen('screen-admin-setup'); }
  function goJoin()       { showScreen('screen-join'); }

  (() => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get('room');
    if (r) { document.getElementById('join-room-id').value = r.toUpperCase(); showScreen('screen-join'); }
  })();

  // =============================================================
  //  ADMIN: пресет холста
  // =============================================================
  function pickPreset(btn) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.settings.canvasWidth  = +btn.dataset.w;
    S.settings.canvasHeight = +btn.dataset.h;
  }

  // =============================================================
  //  ADMIN: создать комнату
  // =============================================================
  function createRoom() {
    socket.emit('create-room', {
      canvasWidth:  S.settings.canvasWidth,
      canvasHeight: S.settings.canvasHeight,
    }, (res) => {
      if (res.error) { toast(res.error, 'error'); return; }
      S.roomId = res.roomId;
      S.role   = 'admin';
      document.getElementById('display-room-id').textContent = res.roomId;
      updateColorSwatch(S.settings.canvasColor);
      showScreen('screen-admin-lobby');
    });
  }

  function copyLink() {
    const url = `${location.origin}?room=${S.roomId}`;
    navigator.clipboard.writeText(url)
      .then(() => toast('Ссылка скопирована! 📋', 'success'))
      .catch(()  => toast(`Код: ${S.roomId}`, 'info'));
  }

  // =============================================================
  //  ADMIN: настройки
  // =============================================================
  function syncSettings() {
    const s = S.settings;
    s.roundTime   = +document.getElementById('s-roundTime').value;
    s.autoClean   = document.getElementById('s-autoClean').checked;
    s.showWord    = document.getElementById('s-showWord').checked;
    s.allowEraser = document.getElementById('s-allowEraser').checked;
    s.canvasColor = document.getElementById('s-canvasColor').value;
    updateColorSwatch(s.canvasColor);
    socket.emit('update-settings', s);
  }

  function updateColorSwatch(hex) {
    const sw  = document.getElementById('canvas-color-preview');
    const hex_ = document.getElementById('canvas-color-hex');
    if (sw)   sw.style.background = hex;
    if (hex_) hex_.textContent    = hex;
  }

  function adjustSetting(key, delta) {
    const limits = { totalRounds: [1, 10] };
    const [mn, mx] = limits[key] || [1, 999];
    S.settings[key] = Math.min(mx, Math.max(mn, S.settings[key] + delta));
    const el = document.getElementById(`s-${key}`);
    if (el) el.textContent = S.settings[key];
    socket.emit('update-settings', { [key]: S.settings[key] });
  }

  // =============================================================
  //  ADMIN: игровые действия
  // =============================================================
  function startGame() {
    syncSettings();
    socket.emit('start-game');
  }

  function startRound() {
    const word = document.getElementById('word-input').value.trim();
    if (!word) { toast('Введи слово для раунда!', 'error'); return; }
    document.getElementById('word-input').value = '';
    socket.emit('start-round', { word });
  }

  function stopRound() { socket.emit('stop-round'); }

  function giveGrade(grade) {
    socket.emit('give-grade', { grade });
    const text = grade === null ? 'без оценки' : `${grade} ${'⭐'.repeat(grade)}`;
    document.getElementById('grade-given-text').textContent = text;
    document.getElementById('grade-given-display').classList.remove('hidden');
    document.querySelectorAll('.grade-btn').forEach(b => b.style.opacity = '.35');
  }

  function nextRound() { socket.emit('next-round'); }

  // =============================================================
  //  PLAYER: войти в комнату
  // =============================================================
  function joinRoom() {
    const roomId = document.getElementById('join-room-id').value.trim().toUpperCase();
    const name   = document.getElementById('join-name').value.trim();
    if (roomId.length !== 6) { toast('Введи 6-символьный код', 'error'); return; }
    if (!name)               { toast('Введи своё имя', 'error'); return; }

    S.myName = name;
    socket.emit('join-room', { roomId, playerName: name }, (res) => {
      if (res.error) { toast(res.error, 'error'); return; }

      S.roomId      = roomId;
      S.role        = 'player';
      S.myColor     = res.color;
      S.brushColor  = res.color;
      S.grades      = res.grades || [];
      S.allowEraser = res.settings?.allowEraser ?? true;
      S.totalRounds = res.settings?.totalRounds ?? 3;

      if (res.status === 'drawing') {
        initGameScreen(res.settings);
        replayHistory(res.drawHistory);
        showOverlay(null);
        startClientTimer(res.remaining ?? res.settings.roundTime, res.settings.roundTime);
        setRoundInfo(res.currentRound, S.totalRounds);
        if (res.word) showWordBadge(res.word);
      } else if (res.status === 'grading') {
        initGameScreen(res.settings);
        showGradingOverlay(res.currentRound, S.totalRounds, null);
      } else {
        document.getElementById('lobby-greeting').textContent = `Привет, ${name}! 👋`;
        showScreen('screen-player-lobby');
      }
    });
  }

  // =============================================================
  //  ИНИЦИАЛИЗАЦИЯ ИГРОВОГО ЭКРАНА
  // =============================================================
  function initGameScreen(settings) {
    showScreen('screen-game');

    S.canvas       = document.getElementById('main-canvas');
    S.ctx          = S.canvas.getContext('2d');
    S.previewCanvas = document.getElementById('preview-canvas');
    S.previewCtx   = S.previewCanvas.getContext('2d');

    S.canvas.width  = settings.canvasWidth;
    S.canvas.height = settings.canvasHeight;
    S.previewCanvas.width  = settings.canvasWidth;
    S.previewCanvas.height = settings.canvasHeight;

    S.totalRounds = settings.totalRounds;
    S.allowEraser = settings.allowEraser;

    fillBackground(settings.canvasColor || '#ffffff');

    if (S.role === 'admin') {
      document.getElementById('toolbar-admin').classList.remove('hidden');
      document.getElementById('ta-round').textContent = `Раунд — / ${settings.totalRounds}`;
    } else {
      document.getElementById('toolbar-player').classList.remove('hidden');
      document.getElementById('brush-color').value = S.myColor;
      S.brushColor = S.myColor;
      const badge = document.getElementById('player-badge');
      badge.textContent           = S.myName;
      badge.style.backgroundColor = S.myColor;
      if (!S.allowEraser) document.getElementById('btn-eraser').style.display = 'none';

      // FIX: навешиваем слушатели только один раз
      if (!S._toolbarBound) {
        S._toolbarBound = true;
        attachCanvasEvents();
        initToolbarControls();
      }
    }
  }

  // =============================================================
  //  TOOLBAR CONTROLS
  // =============================================================
  function initToolbarControls() {
    document.getElementById('brush-color').addEventListener('input', e => {
      S.brushColor = e.target.value;
    });
    document.getElementById('brush-size').addEventListener('input', e => {
      S.brushSize = +e.target.value;
      document.getElementById('size-val').textContent = S.brushSize;
    });
    document.getElementById('shape-filled').addEventListener('change', e => {
      S.filled = e.target.checked;
    });
  }

  function setTool(tool) {
    S.tool = tool;

    // Обновить активную кнопку с анимацией
    TOOLS.forEach(t => {
      const btn = document.getElementById(`btn-${t}`);
      if (btn) btn.classList.toggle('active-tool', t === tool);
    });

    // Показать/скрыть опцию заливки
    const shapeOpts = document.getElementById('shape-options');
    if (shapeOpts) shapeOpts.classList.toggle('hidden', tool !== 'rect' && tool !== 'ellipse');

    // Курсор
    const cursor = tool === 'eraser' ? 'cell' : 'crosshair';
    if (S.canvas) S.canvas.style.cursor = cursor;

    // Сбросить незавершённую фигуру при смене инструмента
    S.shapeStart = null;
    clearPreviewCanvas();
  }

  // =============================================================
  //  CANVAS EVENTS
  // =============================================================
  function attachCanvasEvents() {
    S.canvas.addEventListener('mousedown',  onDown);
    S.canvas.addEventListener('mousemove',  onMove);
    S.canvas.addEventListener('mouseup',    onUp);
    S.canvas.addEventListener('mouseleave', onLeave);
    S.canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    S.canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
    S.canvas.addEventListener('touchend',   onTouchEnd,   { passive: false });
  }

  function getPos(cx, cy) {
    const r = S.canvas.getBoundingClientRect();
    return {
      x: (cx - r.left) * (S.canvas.width  / r.width),
      y: (cy - r.top)  * (S.canvas.height / r.height),
    };
  }

  function onDown(e) {
    if (S.gameStatus !== 'drawing') return;
    const { x, y } = getPos(e.clientX, e.clientY);
    S.lastClientX = e.clientX; S.lastClientY = e.clientY;
    S.isDrawing = true;

    if (S.tool === 'brush' || S.tool === 'eraser') {
      S.lastX = x; S.lastY = y;
      const { color, size } = drawParams();
      drawDot(x, y, color, size);
      socket.emit('draw', { type: 'dot', x, y, color, size });
    } else if (S.tool === 'spray') {
      doSpray(x, y);
    } else {
      // line / rect / ellipse — начало фигуры
      S.shapeStart = { x, y };
    }
  }

  function onMove(e) {
    const { x, y } = getPos(e.clientX, e.clientY);
    S.lastClientX = e.clientX; S.lastClientY = e.clientY;
    socket.emit('cursor-move', { x, y });
    if (!S.isDrawing || S.gameStatus !== 'drawing') return;

    if (S.tool === 'brush' || S.tool === 'eraser') {
      const { color, size } = drawParams();
      drawLine(S.lastX, S.lastY, x, y, color, size);
      socket.emit('draw', { type: 'line', x0: S.lastX, y0: S.lastY, x1: x, y1: y, color, size });
      S.lastX = x; S.lastY = y;
    } else if (S.tool === 'spray') {
      doSpray(x, y);
    } else if (S.shapeStart) {
      // Превью фигуры на preview-canvas
      clearPreviewCanvas();
      const { color, size } = drawParams();
      drawShape(S.previewCtx, S.tool, S.shapeStart.x, S.shapeStart.y, x, y, color, size, S.filled);
    }
  }

  function onUp(e) {
    if (!S.isDrawing) return;
    S.isDrawing = false;

    if (S.shapeStart) {
      const { x, y } = e
        ? getPos(e.clientX, e.clientY)
        : (S.lastClientX !== undefined ? getPos(S.lastClientX, S.lastClientY) : S.shapeStart);

      clearPreviewCanvas();
      const { color, size } = drawParams();
      drawShape(S.ctx, S.tool, S.shapeStart.x, S.shapeStart.y, x, y, color, size, S.filled);

      const typeMap = { line: 'straight', rect: 'rect', ellipse: 'ellipse' };
      socket.emit('draw', {
        type: typeMap[S.tool],
        x0: S.shapeStart.x, y0: S.shapeStart.y, x1: x, y1: y,
        color, size, filled: S.filled,
      });
      S.shapeStart = null;
    }
  }

  function onLeave() {
    // Завершить фигуру по последней известной позиции
    if (S.isDrawing && S.shapeStart && S.lastClientX !== undefined) {
      onUp({ clientX: S.lastClientX, clientY: S.lastClientY });
    } else {
      S.isDrawing = false;
    }
  }

  function onTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    onDown({ clientX: t.clientX, clientY: t.clientY });
  }
  function onTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    S.lastClientX = t.clientX; S.lastClientY = t.clientY;
    onMove({ clientX: t.clientX, clientY: t.clientY });
  }
  function onTouchEnd(e) {
    e.preventDefault();
    if (S.shapeStart && S.lastClientX !== undefined) {
      onUp({ clientX: S.lastClientX, clientY: S.lastClientY });
    } else {
      onUp(null);
    }
  }

  function drawParams() {
    return {
      color: S.tool === 'eraser' ? (S.canvas.dataset.bgColor || '#ffffff') : S.brushColor,
      size:  S.tool === 'eraser' ? S.brushSize * 3 : S.brushSize,
    };
  }

  // =============================================================
  //  РИСОВАНИЕ
  // =============================================================
  function drawLine(x0, y0, x1, y1, color, size) {
    const c = S.ctx;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
    c.strokeStyle = color; c.lineWidth = size;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.stroke();
  }

  function drawDot(x, y, color, size) {
    const c = S.ctx;
    c.beginPath(); c.arc(x, y, size / 2, 0, Math.PI * 2);
    c.fillStyle = color; c.fill();
  }

  /** Универсальная отрисовка фигуры на произвольном ctx */
  function drawShape(ctx, tool, x0, y0, x1, y1, color, size, filled) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = size;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    ctx.beginPath();

    if (tool === 'line') {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (tool === 'rect') {
      const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
      ctx.rect(rx, ry, rw, rh);
      if (filled) { ctx.fillStyle = color; ctx.fill(); }
      ctx.stroke();
    } else if (tool === 'ellipse') {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
      if (filled) { ctx.fillStyle = color; ctx.fill(); }
      ctx.stroke();
    }

    ctx.restore();
  }

  function fillBackground(color) {
    if (!S.ctx) return;
    S.ctx.fillStyle = color;
    S.ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
    if (S.canvas) S.canvas.dataset.bgColor = color;
  }

  function clearPreviewCanvas() {
    if (S.previewCtx) {
      S.previewCtx.clearRect(0, 0, S.previewCanvas.width, S.previewCanvas.height);
    }
  }

  // ── Аэрограф ────────────────────────────────────────────────
  let _lastSprayTime = 0;
  function doSpray(x, y) {
    const now = Date.now();
    if (now - _lastSprayTime < 30) return; // ~33fps макс
    _lastSprayTime = now;

    const { color } = drawParams();
    const radius = S.brushSize * 2.5;
    const count  = 18;
    const pts    = [];

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r     = Math.random() * radius;
      const px    = x + Math.cos(angle) * r;
      const py    = y + Math.sin(angle) * r;
      drawDot(px, py, color, 2);
      pts.push({ x: px, y: py });
    }
    socket.emit('draw', { type: 'spray', points: pts, color, size: 2 });
  }

  /** Воспроизведение одного события рисования */
  function renderDrawEvent(d) {
    if (!S.ctx) return;
    switch (d.type) {
      case 'line':
        drawLine(d.x0, d.y0, d.x1, d.y1, d.color, d.size); break;
      case 'dot':
        drawDot(d.x, d.y, d.color, d.size); break;
      case 'straight':
        drawShape(S.ctx, 'line', d.x0, d.y0, d.x1, d.y1, d.color, d.size, false); break;
      case 'rect':
      case 'ellipse':
        drawShape(S.ctx, d.type, d.x0, d.y0, d.x1, d.y1, d.color, d.size, d.filled); break;
      case 'spray':
        (d.points || []).forEach(p => drawDot(p.x, p.y, d.color, d.size)); break;
    }
  }

  function replayHistory(history) {
    (history || []).forEach(d => renderDrawEvent(d));
  }

  function clearCanvas() {
    if (confirm('Очистить холст для всех?')) socket.emit('clear-canvas');
  }

  function saveCanvas() {
    const a = document.createElement('a');
    a.download = `drawing-${S.roomId}.png`;
    a.href = S.canvas.toDataURL('image/png');
    a.click();
    toast('Рисунок сохранён!', 'success');
  }

  // =============================================================
  //  ТАЙМЕР — FIX: считаем через Date.now() без дрейфа
  // =============================================================
  function startClientTimer(remaining, total) {
    stopClientTimer();
    S.timerTotal     = total;
    S.timerStartAt   = Date.now();
    S.timerStartLeft = remaining;

    document.getElementById('round-bar').classList.remove('hidden');
    updateTimerUI(remaining, total);

    S.timerInterval = setInterval(() => {
      const elapsed = (Date.now() - S.timerStartAt) / 1000;
      const left    = Math.max(0, S.timerStartLeft - elapsed);
      updateTimerUI(left, S.timerTotal);
      if (left <= 0) stopClientTimer();
    }, 400); // чаще для плавности
  }

  function stopClientTimer() {
    clearInterval(S.timerInterval);
    S.timerInterval = null;
    const bar = document.getElementById('round-bar');
    if (bar) bar.classList.remove('timer-urgent');
  }

  function updateTimerUI(left, total) {
    const arc  = document.getElementById('timer-arc');
    const text = document.getElementById('timer-text');
    const bar  = document.getElementById('round-bar');
    if (!arc || !text) return;

    const pct = total > 0 ? (left / total) : 0;
    arc.style.strokeDashoffset = (1 - pct) * 100;
    text.textContent = Math.ceil(left);

    if      (pct > .5) arc.style.stroke = '#22c55e';
    else if (pct > .2) arc.style.stroke = '#f59e0b';
    else               arc.style.stroke = '#ef4444';

    // Пульс при < 10 секунд
    if (bar) bar.classList.toggle('timer-urgent', left <= 10 && left > 0);
  }

  // =============================================================
  //  ОВЕРЛЕИ
  // =============================================================
  const ALL_OVERLAYS = [
    'overlay-word-input',
    'overlay-player-waiting',
    'overlay-grading-admin',
    'overlay-grading-player',
    'overlay-finished',
  ];

  function showOverlay(name) {
    ALL_OVERLAYS.forEach(id => document.getElementById(id).classList.add('hidden'));
    if (name) document.getElementById(name).classList.remove('hidden');
  }

  function setRoundInfo(current, total) {
    document.getElementById('ta-round').textContent = `Раунд ${current} / ${total}`;
    document.getElementById('tp-round').textContent = `Раунд ${current} / ${total}`;
  }

  function showWordBadge(word) {
    if (!word) return;
    const el   = document.getElementById('tp-word');
    const text = document.getElementById('tp-word-text');
    if (el && text) { text.textContent = word; el.classList.remove('hidden'); }
  }

  /** Показать оверлей оценки — ОТДЕЛЬНЫЙ для учителя и ученика */
  function showGradingOverlay(roundNum, total, word) {
    S.gameStatus = 'grading';
    stopClientTimer();
    document.getElementById('round-bar').classList.add('hidden');

    const badge  = `Раунд ${roundNum} / ${total}`;
    const isLast = roundNum >= total;

    if (S.role === 'admin') {
      document.getElementById('og-badge').textContent   = badge;
      document.getElementById('og-word').textContent    = word || '—';
      document.getElementById('btn-next-round').textContent =
        isLast ? '🏁 Завершить игру' : 'Следующий раунд →';
      document.querySelectorAll('.grade-btn').forEach(b => { b.style.opacity = '1'; });
      document.getElementById('grade-given-display').classList.add('hidden');
      showOverlay('overlay-grading-admin');
    } else {
      // Ученик: ТОЛЬКО ожидание — никаких кнопок оценки
      document.getElementById('ogp-badge').textContent = badge;
      document.getElementById('ogp-waiting').classList.remove('hidden');
      document.getElementById('ogp-result').classList.add('hidden');
      document.getElementById('ogp-word-reveal').classList.add('hidden');
      showOverlay('overlay-grading-player');
    }
  }

  // =============================================================
  //  КУРСОРЫ
  // =============================================================
  function updateCursor(id, name, color, x, y) {
    const overlay = document.getElementById('cursor-overlay');
    if (!overlay || !S.canvas) return;

    if (!cursors[id]) {
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = `<div class="cursor-pointer" style="background:${color}"></div>
                      <div class="cursor-label"   style="background:${color}">${name}</div>`;
      overlay.appendChild(el);
      cursors[id] = el;
    }

    const r = S.canvas.getBoundingClientRect();
    cursors[id].style.left = `${x * (r.width  / S.canvas.width)}px`;
    cursors[id].style.top  = `${y * (r.height / S.canvas.height)}px`;
  }

  function removeCursor(id) {
    if (cursors[id]) { cursors[id].remove(); delete cursors[id]; }
  }

  // =============================================================
  //  GRADES TABLE
  // =============================================================
  function renderGradesTable(grades) {
    const tbody = document.getElementById('grades-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    grades.forEach(g => {
      const tr    = document.createElement('tr');
      const stars = g.grade ? '⭐'.repeat(g.grade) : '—';
      tr.innerHTML = `<td>${g.round}</td><td>${g.word}</td><td>${g.grade ? g.grade + ' ' + stars : '—'}</td>`;
      tbody.appendChild(tr);
    });
  }

  // =============================================================
  //  SOCKET СОБЫТИЯ
  // =============================================================

  socket.on('player-joined', ({ id, name, color, playerCount }) => {
    document.getElementById('player-count').textContent = playerCount;
    document.getElementById('waiting-hint')?.classList.add('hidden');

    const li = document.createElement('li');
    li.id        = `pl-${id}`;
    li.innerHTML = `<span class="color-dot" style="background:${color}"></span>${name}`;
    document.getElementById('player-list').appendChild(li);

    const btn = document.getElementById('btn-start');
    if (btn) btn.disabled = false;

    const pc = document.getElementById('ta-pcount');
    if (pc) pc.textContent = `${playerCount} уч.`;
    toast(`${name} подключился! 🎉`, 'success');
  });

  socket.on('player-left', ({ id, playerCount }) => {
    document.getElementById(`pl-${id}`)?.remove();
    const cnt = document.getElementById('player-count');
    if (cnt) cnt.textContent = playerCount;
    const pc = document.getElementById('ta-pcount');
    if (pc) pc.textContent = `${playerCount} уч.`;
    removeCursor(id);
    if (playerCount === 0) document.getElementById('btn-start')?.setAttribute('disabled', true);
  });

  socket.on('game-started', ({ settings }) => {
    S.totalRounds = settings.totalRounds;
    initGameScreen(settings);

    if (S.role === 'admin') {
      document.getElementById('owi-badge').textContent = `Раунд 1 / ${settings.totalRounds}`;
      showOverlay('overlay-word-input');
      document.getElementById('word-input').focus();
    } else {
      document.getElementById('opw-badge').textContent = `Раунд 1 / ${settings.totalRounds}`;
      showOverlay('overlay-player-waiting');
    }
  });

  socket.on('round-started', ({ roundNum, totalRounds, duration, word, secretWord, canvasColor, allowEraser }) => {
    S.gameStatus   = 'drawing';
    S.currentRound = roundNum;
    S.totalRounds  = totalRounds;
    S.allowEraser  = allowEraser;

    fillBackground(canvasColor || '#ffffff');
    setRoundInfo(roundNum, totalRounds);
    showOverlay(null);
    startClientTimer(duration, duration);

    // Вспышка холста при старте
    const cc = document.getElementById('canvas-container');
    if (cc) { cc.classList.remove('round-flash'); void cc.offsetWidth; cc.classList.add('round-flash'); }

    if (S.role === 'admin') {
      document.getElementById('btn-stop-round').classList.remove('hidden');
      document.getElementById('ta-word').classList.remove('hidden');
      document.getElementById('ta-word-text').textContent = secretWord || '—';
      if (S.canvas) S.canvas.style.pointerEvents = 'none';
    } else {
      if (word) showWordBadge(word);
      else document.getElementById('tp-word').classList.add('hidden');
      if (S.canvas) S.canvas.style.pointerEvents = 'auto';
    }
  });

  socket.on('round-ended', ({ roundNum, totalRounds, word }) => {
    if (S.canvas) S.canvas.style.pointerEvents = 'none';
    if (S.role === 'admin') document.getElementById('btn-stop-round').classList.add('hidden');
    showGradingOverlay(roundNum, totalRounds, word);
  });

  socket.on('waiting-for-word', ({ currentRound, totalRounds }) => {
    S.gameStatus = 'waiting_word';
    document.getElementById('tp-word').classList.add('hidden');

    if (S.role === 'admin') {
      const next = currentRound + 1;
      document.getElementById('owi-badge').textContent = `Раунд ${next} / ${totalRounds}`;
      showOverlay('overlay-word-input');
      document.getElementById('word-input').focus();
    } else {
      const next = currentRound + 1;
      document.getElementById('opw-badge').textContent = `Раунд ${next} / ${totalRounds}`;
      showOverlay('overlay-player-waiting');
    }
  });

  // Оценка пришла — показываем ТОЛЬКО ученику
  socket.on('grade-received', ({ grade, roundNum, word }) => {
    // Раскрыть слово
    const wr = document.getElementById('ogp-word-reveal');
    const wt = document.getElementById('ogp-word');
    if (wr && wt && word) { wt.textContent = word; wr.classList.remove('hidden'); }

    // Скрыть "Ждём..." и показать результат
    document.getElementById('ogp-waiting').classList.add('hidden');
    document.getElementById('ogp-result').classList.remove('hidden');

    if (grade !== null) {
      document.getElementById('ogp-stars').textContent    = '⭐'.repeat(grade);
      document.getElementById('ogp-grade-num').textContent = grade;
      toast(`Оценка: ${grade} ${'⭐'.repeat(grade)} 🎉`, 'success');
    } else {
      document.getElementById('ogp-stars').textContent    = '—';
      document.getElementById('ogp-grade-num').textContent = '';
      toast('Раунд без оценки', 'info');
    }
  });

  socket.on('game-finished', ({ grades }) => {
    S.gameStatus = 'finished';
    stopClientTimer();
    document.getElementById('round-bar').classList.add('hidden');
    renderGradesTable(grades);
    showOverlay('overlay-finished');
  });

  // Штрих от другого игрока
  socket.on('draw', (data) => { renderDrawEvent(data); });

  socket.on('cursor-move', ({ id, name, color, x, y }) => {
    if (S.canvas) updateCursor(id, name, color, x, y);
  });

  socket.on('canvas-cleared', ({ canvasColor }) => {
    fillBackground(canvasColor || '#ffffff');
    toast('Холст очищен', 'info');
  });

  socket.on('admin-disconnected', () => {
    toast('Учитель покинул урок', 'error');
  });

  // =============================================================
  //  TOAST — с анимацией выхода
  // =============================================================
  let toastTimer = null;
  function toast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.classList.remove('toast-out');
    el.textContent = msg;
    el.className   = `toast toast-${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add('toast-out');
      setTimeout(() => el.classList.add('hidden'), 200);
    }, 3000);
  }

  // =============================================================
  //  ПУБЛИЧНЫЙ API
  // =============================================================
  return {
    showScreen, goAdminSetup, goJoin,
    pickPreset, createRoom, copyLink,
    syncSettings, adjustSetting,
    startGame, startRound, stopRound,
    giveGrade, nextRound,
    joinRoom,
    setTool, clearCanvas, saveCanvas,
  };

})();
