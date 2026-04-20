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
    myId:         null,        // socket.id игрока
    myName:       null,
    myColor:      null,
    myTeam:       null,        // 'A' или 'B' для team режима
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
      gameMode:    'classic', // classic | solo | team
    },

    // FIX: флаг против повторного навешивания слушателей
    _toolbarBound: false,
  };

  const cursors = {};

  // Инструменты в порядке добавления в тулбар
  const TOOLS = ['brush', 'eraser', 'line', 'rect', 'ellipse', 'spray', 'bezier', 'pan'];
  
  // Состояние масштабирования и панорамирования
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  
  // Кривые Безье
  let bezierPoints = [];
  let isDrawingBezier = false;
  
  // Мини-карта
  let minimapEnabled = false;

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
  //  ADMIN: выбор режима игры
  // =============================================================
  function pickMode(btn) {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.settings.gameMode = btn.dataset.mode;
  }

  // =============================================================
  //  ADMIN: создать комнату
  // =============================================================
  function createRoom() {
    socket.emit('create-room', {
      canvasWidth:  S.settings.canvasWidth,
      canvasHeight: S.settings.canvasHeight,
      gameMode:     S.settings.gameMode,
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
      S.myTeam      = res.team || null;
      S.brushColor  = res.color;
      S.grades      = res.grades || [];
      S.allowEraser = res.settings?.allowEraser ?? true;
      S.totalRounds = res.settings?.totalRounds ?? 3;
      S.settings.gameMode = res.settings?.gameMode || 'classic';

      if (res.status === 'drawing') {
        initGameScreen(res.settings);
        replayHistory(res.drawHistory);
        showOverlay(null);
        startClientTimer(res.remaining ?? res.settings.roundTime, res.settings.roundTime);
        setRoundInfo(res.currentRound, S.totalRounds);
        if (res.word) showWordBadge(res.word);
        updatePlayerBadge();
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
    let cursor = 'crosshair';
    if (tool === 'eraser') cursor = 'cell';
    else if (tool === 'pan') cursor = isPanning ? 'grabbing' : 'grab';
    else if (tool === 'bezier') cursor = 'crosshair';
    
    if (S.canvas) S.canvas.style.cursor = cursor;

    // Сбросить незавершённую фигуру при смене инструмента
    S.shapeStart = null;
    clearPreviewCanvas();
    
    // Сброс кривой Безье при смене инструмента
    if (tool !== 'bezier') {
      bezierPoints = [];
      isDrawingBezier = false;
      clearPreviewCanvas();
    }
  }

  // =============================================================
  //  CANVAS EVENTS — OPTIMIZED: throttle drawing events
  // =============================================================
  let lastDrawEmit = 0;
  let lastCursorEmit = 0;
  let lastCursorPos = { x: 0, y: 0 };
  const DRAW_THROTTLE_MS = 16;     // ~60fps
  const CURSOR_THROTTLE_MS = 50;   // 20fps для курсоров
  
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
      x: (cx - r.left - panX) * (S.canvas.width  / r.width) / zoom,
      y: (cy - r.top  - panY) * (S.canvas.height / r.height) / zoom,
    };
  }
  
  // Преобразование координат экрана в координаты канваса с учётом зума и пана
  function getScreenPos(cx, cy) {
    const r = S.canvas.getBoundingClientRect();
    return {
      x: (cx - r.left - panX) / zoom,
      y: (cy - r.top - panY) / zoom,
    };
  }
  
  function emitDraw(data) {
    const now = Date.now();
    if (now - lastDrawEmit < DRAW_THROTTLE_MS) {
      // Буферизация для отправки позже
      if (!S.drawBuffer) S.drawBuffer = [];
      S.drawBuffer.push(data);
      return;
    }
    lastDrawEmit = now;
    
    // Отправка буферизированных данных
    if (S.drawBuffer && S.drawBuffer.length > 0) {
      const batch = S.drawBuffer.splice(0, 10);
      batch.forEach(d => socket.emit('draw', d));
    }
    
    socket.emit('draw', data);
  }
  
  function emitCursorMove(x, y) {
    const now = Date.now();
    const dx = x - lastCursorPos.x;
    const dy = y - lastCursorPos.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    // Отправляем только если прошло 50мс ИЛИ курсор сместился значительно
    if (now - lastCursorEmit < CURSOR_THROTTLE_MS && dist < 5) return;
    
    lastCursorEmit = now;
    lastCursorPos = { x, y };
    socket.emit('cursor-move', { x, y });
  }

  function onDown(e) {
    if (S.gameStatus !== 'drawing') return;
    const { x, y } = getPos(e.clientX, e.clientY);
    S.lastClientX = e.clientX; S.lastClientY = e.clientY;
    
    // Обработка панорамирования
    if (S.tool === 'pan') {
      isPanning = true;
      panStart = { x: e.clientX - panX, y: e.clientY - panY };
      S.canvas.style.cursor = 'grabbing';
      return;
    }
    
    S.isDrawing = true;

    if (S.tool === 'brush' || S.tool === 'eraser') {
      S.lastX = x; S.lastY = y;
      const { color, size } = drawParams();
      drawDot(x, y, color, size);
      emitDraw({ type: 'dot', x, y, color, size });
    } else if (S.tool === 'spray') {
      doSpray(x, y);
    } else if (S.tool === 'bezier') {
      // Кривая Безье: добавляем контрольную точку
      bezierPoints.push({ x, y });
      isDrawingBezier = true;
      
      // Рисуем точку на превью
      const { color, size } = drawParams();
      drawDot(S.previewCtx, x, y, color, size);
      
      // Если уже 2 точки, рисуем кривую
      if (bezierPoints.length >= 2) {
        drawBezierPreview();
      }
    } else {
      // line / rect / ellipse — начало фигуры
      S.shapeStart = { x, y };
    }
  }

  function onMove(e) {
    const { x, y } = getPos(e.clientX, e.clientY);
    S.lastClientX = e.clientX; S.lastClientY = e.clientY;
    
    // Обработка панорамирования
    if (isPanning && S.tool === 'pan') {
      panX = e.clientX - panStart.x;
      panY = e.clientY - panStart.y;
      updateCanvasTransform();
      return;
    }
    
    emitCursorMove(x, y);
    if (!S.isDrawing || S.gameStatus !== 'drawing') return;

    if (S.tool === 'brush' || S.tool === 'eraser') {
      const { color, size } = drawParams();
      drawLine(S.lastX, S.lastY, x, y, color, size);
      emitDraw({ type: 'line', x0: S.lastX, y0: S.lastY, x1: x, y1: y, color, size });
      S.lastX = x; S.lastY = y;
    } else if (S.tool === 'spray') {
      doSpray(x, y);
    } else if (S.shapeStart) {
      // Превью фигуры на preview-canvas
      clearPreviewCanvas();
      const { color, size } = drawParams();
      drawShape(S.previewCtx, S.tool, S.shapeStart.x, S.shapeStart.y, x, y, color, size, S.filled);
    } else if (S.tool === 'bezier' && isDrawingBezier && bezierPoints.length >= 2) {
      // Обновляем превью кривой Безье при движении с зажатой кнопкой
      drawBezierPreview();
    }
  }

  function onUp(e) {
    // Завершение панорамирования
    if (isPanning && S.tool === 'pan') {
      isPanning = false;
      S.canvas.style.cursor = 'grab';
      return;
    }
    
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
      emitDraw({
        type: typeMap[S.tool],
        x0: S.shapeStart.x, y0: S.shapeStart.y, x1: x, y1: y,
        color, size, filled: S.filled,
      });
      S.shapeStart = null;
    } else if (S.tool === 'bezier' && bezierPoints.length >= 2) {
      // Завершение кривой Безье - отправляем все точки
      clearPreviewCanvas();
      const { color, size } = drawParams();
      drawBezierCurve(S.ctx, bezierPoints, color, size);
      
      emitDraw({
        type: 'bezier',
        points: bezierPoints,
        color,
        size,
      });
      
      bezierPoints = [];
      isDrawingBezier = false;
    }
  }

  function onLeave() {
    // Завершить фигуру по последней известной позиции
    if (S.isDrawing && S.shapeStart && S.lastClientX !== undefined) {
      onUp({ clientX: S.lastClientX, clientY: S.lastClientY });
    } else if (isPanning) {
      isPanning = false;
      S.canvas.style.cursor = 'grab';
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

  function drawDot(ctxOrX, y, color, size) {
    // Поддержка перегрузки: drawDot(ctx, x, y, color, size) и drawDot(x, y, color, size)
    let c, x;
    if (arguments.length === 5) {
      c = ctxOrX;
      x = y;
    } else {
      c = S.ctx;
      x = ctxOrX;
    }
    c.beginPath(); c.arc(x, y, size / 2, 0, Math.PI * 2);
    c.fillStyle = color; c.fill();
  }

  /** Отрисовка кривой Безье по массиву точек */
  function drawBezierCurve(ctx, points, color, size) {
    if (points.length < 2) return;
    
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    
    // Если только 2 точки - рисуем прямую
    if (points.length === 2) {
      ctx.moveTo(points[0].x, points[0].y);
      ctx.lineTo(points[1].x, points[1].y);
    } else {
      // Используем квадратичные кривые Безье для плавности
      ctx.moveTo(points[0].x, points[0].y);
      
      for (let i = 1; i < points.length - 1; i++) {
        const p0 = points[i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];
        
        // Средняя точка между p0 и p1
        const midX1 = (p0.x + p1.x) / 2;
        const midY1 = (p0.y + p1.y) / 2;
        
        // Средняя точка между p1 и p2
        const midX2 = (p1.x + p2.x) / 2;
        const midY2 = (p1.y + p2.y) / 2;
        
        // Квадратичная кривая от midX1 до midX2 с контрольной точкой p1
        ctx.quadraticCurveTo(p1.x, p1.y, midX2, midY2);
      }
      
      // Последняя прямая до конечной точки
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
    }
    
    ctx.stroke();
    ctx.restore();
  }

  /** Превью кривой Безье на preview-canvas */
  function drawBezierPreview() {
    if (!S.previewCtx || bezierPoints.length < 2) return;
    clearPreviewCanvas();
    const { color, size } = drawParams();
    drawBezierCurve(S.previewCtx, bezierPoints, color, size);
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
  
  // Обновление трансформации канваса (зум + панорамирование)
  function updateCanvasTransform() {
    const container = document.getElementById('canvas-container');
    if (!container) return;
    container.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    container.style.transformOrigin = '0 0';
  }
  
  // Функции масштабирования
  function zoomIn() {
    zoom = Math.min(3, zoom * 1.2);
    updateCanvasTransform();
    updateMinimap();
  }
  
  function zoomOut() {
    zoom = Math.max(0.5, zoom / 1.2);
    updateCanvasTransform();
    updateMinimap();
  }
  
  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    updateCanvasTransform();
    updateMinimap();
  }
  
  // Мини-карта
  function initMinimap() {
    const minimap = document.getElementById('minimap');
    if (!minimap) return;
    
    minimapEnabled = true;
    minimap.classList.remove('hidden');
    
    // Создаём мини-канвас
    const miniCanvas = document.createElement('canvas');
    miniCanvas.id = 'minimap-canvas';
    miniCanvas.width = 150;
    miniCanvas.height = 100;
    minimap.innerHTML = '';
    minimap.appendChild(miniCanvas);
    
    // Добавляем рамку вида
    const viewport = document.createElement('div');
    viewport.id = 'minimap-viewport';
    minimap.appendChild(viewport);
    
    updateMinimap();
  }
  
  function updateMinimap() {
    const minimap = document.getElementById('minimap');
    const miniCanvas = document.getElementById('minimap-canvas');
    const viewport = document.getElementById('minimap-viewport');
    
    if (!minimap || !miniCanvas || !S.canvas) return;
    
    const miniCtx = miniCanvas.getContext('2d');
    const mainRect = S.canvas.getBoundingClientRect();
    
    // Очистка и отрисовка фона
    miniCtx.fillStyle = '#f0f4ff';
    miniCtx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);
    
    // Масштабирование содержимого основного канваса
    const scaleX = miniCanvas.width / S.canvas.width;
    const scaleY = miniCanvas.height / S.canvas.height;
    const scale = Math.min(scaleX, scaleY);
    
    try {
      miniCtx.drawImage(S.canvas, 0, 0, 
        S.canvas.width * scale, 
        S.canvas.height * scale);
    } catch(e) {}
    
    // Рамка видимой области
    if (viewport && mainRect.width > 0) {
      const containerRect = document.getElementById('canvas-wrapper').getBoundingClientRect();
      const viewX = (-panX / mainRect.width) * miniCanvas.width;
      const viewY = (-panY / mainRect.height) * miniCanvas.height;
      const viewW = (containerRect.width / mainRect.width) * miniCanvas.width;
      const viewH = (containerRect.height / mainRect.height) * miniCanvas.height;
      
      viewport.style.left = `${Math.max(0, viewX)}px`;
      viewport.style.top = `${Math.max(0, viewY)}px`;
      viewport.style.width = `${Math.min(miniCanvas.width - viewX, viewW)}px`;
      viewport.style.height = `${Math.min(miniCanvas.height - viewY, viewH)}px`;
    }
  }
  
  function toggleMinimap() {
    if (minimapEnabled) {
      const minimap = document.getElementById('minimap');
      if (minimap) {
        minimap.classList.add('hidden');
        minimapEnabled = false;
      }
    } else {
      initMinimap();
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
    emitDraw({ type: 'spray', points: pts, color, size: 2 });
  }

  /** Воспроизведение одного события рисования */
  function renderDrawEvent(d, playerId) {
    if (!S.ctx) return;

    const gameMode = S.settings.gameMode || 'classic';
    if (gameMode !== 'classic' && playerId && playerId !== S.myId) {
      return;
    }

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
      case 'bezier':
        drawBezierCurve(S.ctx, d.points || [], d.color, d.size); break;
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

  function updatePlayerBadge() {
    const badge = document.getElementById('player-badge');
    if (!badge) return;
    
    let text = S.myName;
    if (S.settings.gameMode === 'team' && S.myTeam) {
      text += ` (${S.myTeam})`;
    } else if (S.settings.gameMode === 'solo') {
      text += ' 🎨';
    }
    
    badge.textContent = text;
    badge.style.backgroundColor = S.myColor;
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

  // Штрих от другого игрока — OPTIMIZED: batch processing
  socket.on('draw', (data) => { 
    // Для solo/team режимов — данные могут быть в формате { playerId, ...data }
    if (data.playerId) {
      renderDrawEvent(data, data.playerId);
    } else {
      renderDrawEvent(data);
    }
  });
  
  // Обработка пакетной отрисовки
  socket.on('draw-batch', (payload) => {
    if (!S.ctx) return;
    
    // Поддержка нового формата с playerId для solo/team
    let batch = payload;
    let playerId = null;
    
    if (payload && typeof payload === 'object' && Array.isArray(payload.batch)) {
      batch = payload.batch;
      playerId = payload.playerId;
    }
    
    if (!Array.isArray(batch)) return;
    batch.forEach(d => renderDrawEvent(d, playerId));
  });

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
    pickPreset, pickMode, createRoom, copyLink,
    syncSettings, adjustSetting,
    startGame, startRound, stopRound,
    giveGrade, nextRound,
    joinRoom,
    setTool, clearCanvas, saveCanvas,
    zoomIn, zoomOut, resetZoom, toggleMinimap,
  };

})();
