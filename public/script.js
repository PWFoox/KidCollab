// =============================================================
//  script.js — DrawTogether v2  (чистый переписанный файл)
// =============================================================

const App = (() => {

  const socket = io();

  // =============================================================
  //  СОСТОЯНИЕ
  // =============================================================
  const S = {
    role:         null,    // 'admin' | 'player'
    roomId:       null,
    myName:       null,
    myColor:      null,
    gameStatus:   null,    // 'lobby'|'waiting_word'|'drawing'|'grading'|'finished'
    currentRound: 0,
    totalRounds:  3,
    allowEraser:  true,
    grades:       [],

    // Canvas
    canvas:        null,
    ctx:           null,
    previewCanvas: null,
    previewCtx:    null,

    // Состояние рисования
    isDrawing:   false,
    lastX: 0,    lastY: 0,
    lastCX: 0,   lastCY: 0,   // последние clientX/clientY
    shapeStart:  null,         // { x, y } начало фигуры

    // Инструменты
    tool:       'brush',
    brushColor: '#1a1a1a',
    brushSize:  6,
    filled:     false,

    // Таймер — точный, через Date.now()
    timerTotal:     60,
    timerStartAt:   null,
    timerStartLeft: 60,
    timerInterval:  null,

    // Настройки (Admin)
    settings: {
      totalRounds:  3,
      roundTime:    60,
      autoClean:    true,
      showWord:     false,
      allowEraser:  true,
      canvasColor:  '#ffffff',
      canvasWidth:  900,
      canvasHeight: 600,
    },

    // Флаги инициализации
    _eventsAttached: false,
  };

  // =============================================================
  //  ZOOM / PAN
  //  Архитектура: CSS transform на #canvas-container
  //  getPos() использует getBoundingClientRect() — автоматически
  //  учитывает все трансформации, поэтому координаты всегда верны.
  // =============================================================
  let zoom   = 1;
  let panX   = 0;
  let panY   = 0;
  let isPanning   = false;
  let panStartX   = 0;  // clientX - panX при начале пана
  let panStartY   = 0;  // clientY - panY при начале пана
  let spaceHeld   = false;

  function applyTransform() {
    const c = document.getElementById('canvas-container');
    if (!c) return;
    c.style.transform       = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    c.style.transformOrigin = '0 0';
    const lbl = document.getElementById('zoom-label');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
  }

  function zoomBy(factor, pivotClientX, pivotClientY) {
    const newZoom = Math.max(0.25, Math.min(5, zoom * factor));
    if (newZoom === zoom) return;

    // Точка, вокруг которой зуммируем (по умолчанию — центр wrapper)
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;
    const wr = wrapper.getBoundingClientRect();
    const px = pivotClientX ?? wr.left + wr.width  / 2;
    const py = pivotClientY ?? wr.top  + wr.height / 2;

    // Вычисляем, какая точка canvas-пространства находится под курсором
    const canvasPointX = (px - wr.left - panX) / zoom;
    const canvasPointY = (py - wr.top  - panY) / zoom;

    zoom = newZoom;

    // Подбираем новый pan так, чтобы та же точка осталась под курсором
    panX = (px - wr.left) - canvasPointX * zoom;
    panY = (py - wr.top)  - canvasPointY * zoom;

    applyTransform();
  }

  function resetZoom() {
    zoom = 1; panX = 0; panY = 0;
    applyTransform();
  }

  // ── Клавиши Space (пан) ──────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.target.matches('input,textarea,select')) {
      e.preventDefault();
      spaceHeld = true;
      const cc = document.getElementById('canvas-container');
      if (cc && S.role === 'player') cc.classList.add('panning');
    }
    // Горячие клавиши инструментов (только во время рисования)
    if (S.gameStatus !== 'drawing' || S.role !== 'player') return;
    if (e.target.matches('input,textarea,select')) return;
    const keyMap = {
      'b': 'brush', 'е': 'brush',
      'e': 'eraser','у': 'eraser',
      'f': 'fill',  'а': 'fill',
      'l': 'line',  'д': 'line',
      'r': 'rect',  'к': 'rect',
      'o': 'ellipse','щ': 'ellipse',
      's': 'spray', 'ы': 'spray',
    };
    const tool = keyMap[e.key.toLowerCase()];
    if (tool) setTool(tool);
  });

  document.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      spaceHeld = false;
      isPanning = false;
      const cc = document.getElementById('canvas-container');
      if (cc) { cc.classList.remove('panning'); cc.classList.remove('panning-active'); }
    }
  });

  // ── Zoom колёсиком ───────────────────────────────────────
  function attachWheelZoom() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;
    wrapper.addEventListener('wheel', e => {
      if (S.role !== 'player') return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      zoomBy(factor, e.clientX, e.clientY);
    }, { passive: false });
  }

  // =============================================================
  //  НАВИГАЦИЯ
  // =============================================================
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
  }

  function goAdminSetup() { showScreen('screen-admin-setup'); }
  function goJoin()       { showScreen('screen-join'); }

  // Авто-заполнение кода комнаты из URL
  (() => {
    const r = new URLSearchParams(window.location.search).get('room');
    if (r) {
      const el = document.getElementById('join-room-id');
      if (el) el.value = r.toUpperCase();
      showScreen('screen-join');
    }
  })();

  // =============================================================
  //  ADMIN: настройки холста
  // =============================================================
  function pickPreset(btn) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.settings.canvasWidth  = +btn.dataset.w;
    S.settings.canvasHeight = +btn.dataset.h;
  }

  function createRoom() {
    socket.emit('create-room', {
      canvasWidth:  S.settings.canvasWidth,
      canvasHeight: S.settings.canvasHeight,
    }, res => {
      if (res.error) { toast(res.error, 'error'); return; }
      S.roomId = res.roomId;
      S.role   = 'admin';
      document.getElementById('display-room-id').textContent = res.roomId;
      updateColorSwatch(S.settings.canvasColor);
      showScreen('screen-admin-lobby');
    });
  }

  function copyLink() {
    navigator.clipboard.writeText(`${location.origin}?room=${S.roomId}`)
      .then(()  => toast('Ссылка скопирована! 📋', 'success'))
      .catch(()  => toast(`Код: ${S.roomId}`, 'info'));
  }

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
    const sw = document.getElementById('canvas-color-preview');
    const hx = document.getElementById('canvas-color-hex');
    if (sw) sw.style.background = hex;
    if (hx) hx.textContent = hex;
  }

  function adjustSetting(key, delta) {
    const limits = { totalRounds: [1, 10] };
    const [mn, mx] = limits[key] || [1, 999];
    S.settings[key] = Math.min(mx, Math.max(mn, (S.settings[key] || 0) + delta));
    const el = document.getElementById(`s-${key}`);
    if (el) el.textContent = S.settings[key];
    socket.emit('update-settings', { [key]: S.settings[key] });
  }

  // =============================================================
  //  ADMIN: игровой процесс
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
    document.querySelectorAll('.grade-btn').forEach(b => (b.style.opacity = '.3'));
  }

  function nextRound() { socket.emit('next-round'); }

  // =============================================================
  //  PLAYER: вход в комнату
  // =============================================================
  function joinRoom() {
    const roomId = document.getElementById('join-room-id').value.trim().toUpperCase();
    const name   = document.getElementById('join-name').value.trim();
    if (roomId.length !== 6) { toast('Введи 6-символьный код', 'error'); return; }
    if (!name)               { toast('Введи своё имя', 'error'); return; }

    S.myName = name;
    socket.emit('join-room', { roomId, playerName: name }, res => {
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
  //  ИНИЦИАЛИЗАЦИЯ ЭКРАНА ИГРЫ
  // =============================================================
  function initGameScreen(settings) {
    showScreen('screen-game');

    S.canvas       = document.getElementById('main-canvas');
    S.ctx          = S.canvas.getContext('2d');
    S.previewCanvas = document.getElementById('preview-canvas');
    S.previewCtx   = S.previewCanvas.getContext('2d');

    const w = settings.canvasWidth;
    const h = settings.canvasHeight;
    S.canvas.width  = w;  S.canvas.height  = h;
    S.previewCanvas.width = w; S.previewCanvas.height = h;

    S.totalRounds = settings.totalRounds;
    S.allowEraser = settings.allowEraser;

    fillBackground(settings.canvasColor || '#ffffff');

    // Центрируем холст в окне по умолчанию
    centerCanvas();

    if (S.role === 'admin') {
      document.getElementById('toolbar-admin').classList.remove('hidden');
      document.getElementById('ta-round').textContent = `Раунд — / ${settings.totalRounds}`;
    } else {
      document.getElementById('toolbar-player').classList.remove('hidden');

      // Устанавливаем цвет игрока
      const colorInput = document.getElementById('brush-color');
      if (colorInput) colorInput.value = S.myColor;
      S.brushColor = S.myColor;
      addRecentColor(S.myColor);

      const badge = document.getElementById('player-badge');
      if (badge) { badge.textContent = S.myName; badge.style.backgroundColor = S.myColor; }

      if (!S.allowEraser) {
        const eb = document.getElementById('btn-eraser');
        if (eb) eb.style.display = 'none';
      }

      // Навешиваем события только один раз
      if (!S._eventsAttached) {
        S._eventsAttached = true;
        attachCanvasEvents();
        attachToolbarEvents();
        attachWheelZoom();
      }
    }
  }

  // Центрирует и подгоняет холст под размер окна
  function centerCanvas() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper || !S.canvas) return;

    const wr = wrapper.getBoundingClientRect();
    const margin = 40;
    const scaleX = (wr.width  - margin * 2) / S.canvas.width;
    const scaleY = (wr.height - margin * 2) / S.canvas.height;
    const scale  = Math.min(scaleX, scaleY, 1); // не увеличиваем больше 100%

    zoom = scale;
    // Центрируем
    panX = Math.round((wr.width  - S.canvas.width  * zoom) / 2);
    panY = Math.round((wr.height - S.canvas.height * zoom) / 2);

    applyTransform();
  }

  // =============================================================
  //  TOOLBAR EVENTS
  // =============================================================
  function attachToolbarEvents() {
    // Цвет
    document.getElementById('brush-color')?.addEventListener('input', e => {
      S.brushColor = e.target.value;
      addRecentColor(S.brushColor);
    });

    // Размер
    document.getElementById('brush-size')?.addEventListener('input', e => {
      S.brushSize = +e.target.value;
      const sv = document.getElementById('size-val');
      if (sv) sv.textContent = S.brushSize;
    });

    // Заливка для фигур
    document.getElementById('shape-filled')?.addEventListener('change', e => {
      S.filled = e.target.checked;
    });
  }

  // Последние 5 использованных цветов
  const _recentColors = [];
  function addRecentColor(hex) {
    const idx = _recentColors.indexOf(hex);
    if (idx !== -1) _recentColors.splice(idx, 1);
    _recentColors.unshift(hex);
    if (_recentColors.length > 5) _recentColors.pop();

    const container = document.getElementById('color-recent');
    if (!container) return;
    container.innerHTML = '';
    _recentColors.forEach(c => {
      const dot = document.createElement('div');
      dot.className = 'color-recent-dot';
      dot.style.background = c;
      dot.title = c;
      dot.onclick = () => {
        S.brushColor = c;
        const ci = document.getElementById('brush-color');
        if (ci) ci.value = c;
      };
      container.appendChild(dot);
    });
  }

  // =============================================================
  //  ИНСТРУМЕНТ
  // =============================================================
  const ALL_TOOLS = ['brush','eraser','fill','line','rect','ellipse','spray'];

  function setTool(tool) {
    S.tool = tool;

    ALL_TOOLS.forEach(t => {
      document.getElementById(`btn-${t}`)?.classList.toggle('active-tool', t === tool);
    });

    // Опция заливки — только для rect/ellipse
    const shapeOpts = document.getElementById('shape-options');
    if (shapeOpts) shapeOpts.classList.toggle('hidden', tool !== 'rect' && tool !== 'ellipse');

    // Сбросить незаконченную фигуру
    S.shapeStart = null;
    clearPreview();
  }

  // =============================================================
  //  CANVAS EVENTS
  // =============================================================
  function attachCanvasEvents() {
    const c = S.canvas;
    c.addEventListener('mousedown',  onDown);
    c.addEventListener('mousemove',  onMove);
    c.addEventListener('mouseup',    onUp);
    c.addEventListener('mouseleave', onLeave);
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    c.addEventListener('touchmove',  onTouchMove,  { passive: false });
    c.addEventListener('touchend',   onTouchEnd,   { passive: false });
  }

  // Конвертация client coords → canvas coords.
  // getBoundingClientRect() автоматически учитывает CSS transform,
  // поэтому никаких ручных поправок на zoom/pan НЕ нужно.
  function getPos(clientX, clientY) {
    const r = S.canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) / r.width  * S.canvas.width,
      y: (clientY - r.top)  / r.height * S.canvas.height,
    };
  }

  function onDown(e) {
    S.lastCX = e.clientX; S.lastCY = e.clientY;

    // Pan: Пробел + мышь
    if (spaceHeld) {
      isPanning  = true;
      panStartX  = e.clientX - panX;
      panStartY  = e.clientY - panY;
      const cc = document.getElementById('canvas-container');
      cc?.classList.add('panning-active');
      return;
    }

    if (S.gameStatus !== 'drawing') return;

    const { x, y } = getPos(e.clientX, e.clientY);
    S.isDrawing = true;

    if (S.tool === 'brush' || S.tool === 'eraser') {
      S.lastX = x; S.lastY = y;
      const { color, size } = drawParams();
      dot(S.ctx, x, y, color, size);
      socket.emit('draw', { type: 'dot', x, y, color, size });
    } else if (S.tool === 'spray') {
      doSpray(x, y);
    } else if (S.tool === 'fill') {
      floodFill(x, y, S.brushColor);
      socket.emit('draw', { type: 'fill', x: Math.round(x), y: Math.round(y), color: S.brushColor });
    } else {
      // line / rect / ellipse
      S.shapeStart = { x, y };
    }
  }

  function onMove(e) {
    S.lastCX = e.clientX; S.lastCY = e.clientY;

    // Пан
    if (isPanning) {
      panX = e.clientX - panStartX;
      panY = e.clientY - panStartY;
      applyTransform();
      return;
    }

    const { x, y } = getPos(e.clientX, e.clientY);

    // Отправить курсор (throttle 40ms на сервере, дополнительно не нужен)
    socket.emit('cursor-move', { x, y });

    if (!S.isDrawing || S.gameStatus !== 'drawing') return;

    if (S.tool === 'brush' || S.tool === 'eraser') {
      const { color, size } = drawParams();
      line(S.ctx, S.lastX, S.lastY, x, y, color, size);
      socket.emit('draw', { type: 'line', x0: S.lastX, y0: S.lastY, x1: x, y1: y, color, size });
      S.lastX = x; S.lastY = y;
    } else if (S.tool === 'spray') {
      doSpray(x, y);
    } else if (S.shapeStart) {
      clearPreview();
      const { color, size } = drawParams();
      drawShape(S.previewCtx, S.tool, S.shapeStart.x, S.shapeStart.y, x, y, color, size, S.filled);
    }
  }

  function onUp(e) {
    const cc = document.getElementById('canvas-container');

    if (isPanning) {
      isPanning = false;
      cc?.classList.remove('panning-active');
      return;
    }

    if (!S.isDrawing) return;
    S.isDrawing = false;

    if (S.shapeStart) {
      const { x, y } = e ? getPos(e.clientX, e.clientY) : getPos(S.lastCX, S.lastCY);
      clearPreview();
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
    if (isPanning) {
      isPanning = false;
      document.getElementById('canvas-container')?.classList.remove('panning-active');
      return;
    }
    if (S.isDrawing && S.shapeStart) {
      onUp(null);
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
    S.lastCX = t.clientX; S.lastCY = t.clientY;
    onMove({ clientX: t.clientX, clientY: t.clientY });
  }
  function onTouchEnd(e) {
    e.preventDefault();
    onUp(null);
  }

  function drawParams() {
    return {
      color: S.tool === 'eraser'
        ? (S.canvas.dataset.bgColor || '#ffffff')
        : S.brushColor,
      size: S.tool === 'eraser' ? S.brushSize * 3 : S.brushSize,
    };
  }

  // =============================================================
  //  ПРИМИТИВЫ РИСОВАНИЯ
  //  Все принимают ctx явно — нет глобального состояния
  // =============================================================

  function line(ctx, x0, y0, x1, y1, color, size) {
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.strokeStyle = color; ctx.lineWidth = size;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function dot(ctx, x, y, color, size) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(size / 2, 0.5), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawShape(ctx, tool, x0, y0, x1, y1, color, size, filled) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = size;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();

    if (tool === 'line' || tool === 'straight') {
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (tool === 'rect') {
      const [rx, ry] = [Math.min(x0, x1), Math.min(y0, y1)];
      const [rw, rh] = [Math.abs(x1 - x0), Math.abs(y1 - y0)];
      ctx.rect(rx, ry, rw, rh);
      if (filled) { ctx.fillStyle = color; ctx.fill(); }
      ctx.stroke();
    } else if (tool === 'ellipse') {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
      if (filled) { ctx.fillStyle = color; ctx.fill(); }
      ctx.stroke();
    }

    ctx.restore();
  }

  function fillBackground(color) {
    if (!S.ctx || !S.canvas) return;
    S.ctx.fillStyle = color;
    S.ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
    S.canvas.dataset.bgColor = color;
  }

  function clearPreview() {
    if (S.previewCtx && S.previewCanvas)
      S.previewCtx.clearRect(0, 0, S.previewCanvas.width, S.previewCanvas.height);
  }

  // ── Аэрограф ────────────────────────────────────────────
  let _sprayLast = 0;
  function doSpray(x, y) {
    const now = Date.now();
    if (now - _sprayLast < 25) return;
    _sprayLast = now;

    const { color } = drawParams();
    const radius = S.brushSize * 3;
    const count  = 20;
    const pts    = [];

    for (let i = 0; i < count; i++) {
      const a  = Math.random() * Math.PI * 2;
      const r  = Math.sqrt(Math.random()) * radius; // равномерное распределение
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      dot(S.ctx, px, py, color, 1.5);
      pts.push({ x: px, y: py });
    }
    socket.emit('draw', { type: 'spray', points: pts, color });
  }

  // ── Flood fill (заливка ведром) ─────────────────────────
  // Отправляем { type:'fill', x, y, color } — каждый клиент
  // воспроизводит fill локально, чтобы не гонять массив пикселей.
  function floodFill(startX, startY, fillColorHex) {
    if (!S.ctx || !S.canvas) return;
    const sx = Math.round(clamp(startX, 0, S.canvas.width  - 1));
    const sy = Math.round(clamp(startY, 0, S.canvas.height - 1));

    const imageData = S.ctx.getImageData(0, 0, S.canvas.width, S.canvas.height);
    const { data, width, height } = imageData;

    // Целевой цвет под курсором
    const ti = (sy * width + sx) * 4;
    const tr = data[ti], tg = data[ti+1], tb = data[ti+2], ta = data[ti+3];

    // Новый цвет
    const fr = parseInt(fillColorHex.slice(1, 3), 16);
    const fg = parseInt(fillColorHex.slice(3, 5), 16);
    const fb = parseInt(fillColorHex.slice(5, 7), 16);

    // Если тот же цвет — ничего не делаем
    if (tr === fr && tg === fg && tb === fb && ta === 255) return;

    // Допустимое расхождение цвета (для сглаженных краёв)
    const TOLERANCE = 32;
    function matches(idx) {
      return Math.abs(data[idx]   - tr) <= TOLERANCE
          && Math.abs(data[idx+1] - tg) <= TOLERANCE
          && Math.abs(data[idx+2] - tb) <= TOLERANCE
          && Math.abs(data[idx+3] - ta) <= TOLERANCE;
    }

    // BFS fill по строкам (scanline)
    const visited = new Uint8Array(width * height);
    const queue   = [sx + sy * width];
    visited[sx + sy * width] = 1;

    while (queue.length) {
      const pos = queue.pop();
      const px  = pos % width;
      const py  = (pos - px) / width;
      const idx = pos * 4;

      data[idx]   = fr;
      data[idx+1] = fg;
      data[idx+2] = fb;
      data[idx+3] = 255;

      const neighbors = [pos - 1, pos + 1, pos - width, pos + width];
      for (const np of neighbors) {
        if (np < 0 || np >= width * height) continue;
        if (visited[np]) continue;
        const nx = np % width;
        const ny = (np - nx) / width;
        // Не пересекать горизонтальные границы неправильно
        if (Math.abs(nx - px) > 1 || ny < 0 || ny >= height) continue;
        if (matches(np * 4)) {
          visited[np] = 1;
          queue.push(np);
        }
      }
    }

    S.ctx.putImageData(imageData, 0, 0);
  }

  // ── Воспроизведение события рисования ───────────────────
  function renderEvent(d) {
    if (!S.ctx) return;
    switch (d.type) {
      case 'line':
        line(S.ctx, d.x0, d.y0, d.x1, d.y1, d.color, d.size); break;
      case 'dot':
        dot(S.ctx, d.x, d.y, d.color, d.size); break;
      case 'straight':
      case 'rect':
      case 'ellipse':
        drawShape(S.ctx, d.type, d.x0, d.y0, d.x1, d.y1, d.color, d.size, d.filled); break;
      case 'spray':
        (d.points || []).forEach(p => dot(S.ctx, p.x, p.y, d.color, 1.5)); break;
      case 'fill':
        floodFill(d.x, d.y, d.color); break;
    }
  }

  function replayHistory(history) {
    (history || []).forEach(d => renderEvent(d));
  }

  function clearCanvas() {
    if (confirm('Очистить холст для всех?'))
      socket.emit('clear-canvas');
  }

  function saveCanvas() {
    if (!S.canvas) return;
    const a = document.createElement('a');
    a.download = `drawing-${S.roomId || 'dt'}.png`;
    a.href     = S.canvas.toDataURL('image/png');
    a.click();
    toast('Рисунок сохранён! 💾', 'success');
  }

  // =============================================================
  //  ТАЙМЕР — Date.now() based, без дрейфа
  // =============================================================
  function startClientTimer(remaining, total) {
    stopClientTimer();
    S.timerTotal     = total;
    S.timerStartAt   = Date.now();
    S.timerStartLeft = remaining;

    document.getElementById('round-bar')?.classList.remove('hidden');
    _updateTimerUI(remaining, total);

    S.timerInterval = setInterval(() => {
      const left = Math.max(0, S.timerStartLeft - (Date.now() - S.timerStartAt) / 1000);
      _updateTimerUI(left, S.timerTotal);
      if (left <= 0) stopClientTimer();
    }, 250);
  }

  function stopClientTimer() {
    clearInterval(S.timerInterval);
    S.timerInterval = null;
    document.getElementById('round-bar')?.classList.remove('timer-urgent');
  }

  function _updateTimerUI(left, total) {
    const arc  = document.getElementById('timer-arc');
    const text = document.getElementById('timer-text');
    const bar  = document.getElementById('round-bar');
    if (!arc || !text) return;

    const pct = total > 0 ? left / total : 0;
    arc.style.strokeDashoffset = (1 - pct) * 100;
    text.textContent = Math.ceil(left);

    arc.style.stroke = pct > .5 ? '#22c55e' : pct > .2 ? '#f59e0b' : '#ef4444';
    bar?.classList.toggle('timer-urgent', left <= 10 && left > 0);
  }

  // =============================================================
  //  ОВЕРЛЕИ
  // =============================================================
  const OVERLAYS = [
    'overlay-word-input',
    'overlay-player-waiting',
    'overlay-grading-admin',
    'overlay-grading-player',
    'overlay-finished',
  ];

  function showOverlay(name) {
    OVERLAYS.forEach(id => document.getElementById(id)?.classList.add('hidden'));
    if (name) document.getElementById(name)?.classList.remove('hidden');
  }

  function setRoundInfo(current, total) {
    const txt = `Раунд ${current} / ${total}`;
    const ta = document.getElementById('ta-round');
    const tp = document.getElementById('tp-round');
    if (ta) ta.textContent = txt;
    if (tp) tp.textContent = txt;
  }

  function showWordBadge(word) {
    const el = document.getElementById('tp-word');
    const tx = document.getElementById('tp-word-text');
    if (el && tx) { tx.textContent = word; el.classList.remove('hidden'); }
  }

  function showGradingOverlay(roundNum, total, word) {
    S.gameStatus = 'grading';
    stopClientTimer();
    document.getElementById('round-bar')?.classList.add('hidden');

    const badge  = `Раунд ${roundNum} / ${total}`;
    const isLast = roundNum >= total;

    if (S.role === 'admin') {
      document.getElementById('og-badge').textContent   = badge;
      document.getElementById('og-word').textContent    = word || '—';
      const nb = document.getElementById('btn-next-round');
      if (nb) nb.textContent = isLast ? '🏁 Завершить игру' : 'Следующий раунд →';
      document.querySelectorAll('.grade-btn').forEach(b => (b.style.opacity = '1'));
      document.getElementById('grade-given-display')?.classList.add('hidden');
      showOverlay('overlay-grading-admin');
    } else {
      document.getElementById('ogp-badge').textContent = badge;
      document.getElementById('ogp-waiting')?.classList.remove('hidden');
      document.getElementById('ogp-result')?.classList.add('hidden');
      document.getElementById('ogp-word-reveal')?.classList.add('hidden');
      showOverlay('overlay-grading-player');
    }
  }

  // =============================================================
  //  КУРСОРЫ
  // =============================================================
  const cursors = {};

  function updateCursor(id, name, color, x, y) {
    const overlay = document.getElementById('cursor-overlay');
    if (!overlay || !S.canvas) return;

    if (!cursors[id]) {
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML =
        `<div class="cursor-pointer" style="background:${color}"></div>` +
        `<div class="cursor-label"   style="background:${color}">${name}</div>`;
      overlay.appendChild(el);
      cursors[id] = el;
    }

    // getBoundingClientRect учитывает зум — масштабируем координаты правильно
    const r = S.canvas.getBoundingClientRect();
    cursors[id].style.left = `${x / S.canvas.width  * r.width}px`;
    cursors[id].style.top  = `${y / S.canvas.height * r.height}px`;
  }

  function removeCursor(id) {
    cursors[id]?.remove();
    delete cursors[id];
  }

  // =============================================================
  //  GRADES TABLE
  // =============================================================
  function renderGradesTable(grades) {
    const tbody = document.getElementById('grades-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    grades.forEach(g => {
      const tr   = document.createElement('tr');
      const stars = g.grade ? '⭐'.repeat(g.grade) : '—';
      tr.innerHTML =
        `<td>${g.round}</td><td>${g.word}</td>` +
        `<td>${g.grade ? `${g.grade} ${stars}` : '—'}</td>`;
      tbody.appendChild(tr);
    });
  }

  // =============================================================
  //  SOCKET СОБЫТИЯ
  // =============================================================

  socket.on('player-joined', ({ id, name, color, playerCount }) => {
    document.getElementById('player-count').textContent = playerCount;
    document.getElementById('waiting-hint')?.classList.add('hidden');

    const li    = document.createElement('li');
    li.id       = `pl-${id}`;
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
    if (playerCount === 0)
      document.getElementById('btn-start')?.setAttribute('disabled', true);
  });

  socket.on('game-started', ({ settings }) => {
    S.totalRounds = settings.totalRounds;
    initGameScreen(settings);

    if (S.role === 'admin') {
      document.getElementById('owi-badge').textContent = `Раунд 1 / ${settings.totalRounds}`;
      showOverlay('overlay-word-input');
      document.getElementById('word-input')?.focus();
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

    // Анимация вспышки
    const cc = document.getElementById('canvas-container');
    if (cc) {
      cc.classList.remove('round-flash');
      void cc.offsetWidth;   // reflow — сбрасывает анимацию
      cc.classList.add('round-flash');
    }

    if (S.role === 'admin') {
      document.getElementById('btn-stop-round')?.classList.remove('hidden');
      const tw = document.getElementById('ta-word');
      const tt = document.getElementById('ta-word-text');
      if (tw) tw.classList.remove('hidden');
      if (tt) tt.textContent = secretWord || '—';
      if (S.canvas) S.canvas.style.pointerEvents = 'none';
    } else {
      if (word) showWordBadge(word);
      else document.getElementById('tp-word')?.classList.add('hidden');
      if (S.canvas) S.canvas.style.pointerEvents = 'auto';
    }
  });

  socket.on('round-ended', ({ roundNum, totalRounds, word }) => {
    if (S.canvas) S.canvas.style.pointerEvents = 'none';
    document.getElementById('btn-stop-round')?.classList.add('hidden');
    showGradingOverlay(roundNum, totalRounds, word);
  });

  socket.on('waiting-for-word', ({ currentRound, totalRounds }) => {
    S.gameStatus = 'waiting_word';
    document.getElementById('tp-word')?.classList.add('hidden');

    const next = currentRound + 1;
    if (S.role === 'admin') {
      document.getElementById('owi-badge').textContent = `Раунд ${next} / ${totalRounds}`;
      showOverlay('overlay-word-input');
      document.getElementById('word-input')?.focus();
    } else {
      document.getElementById('opw-badge').textContent = `Раунд ${next} / ${totalRounds}`;
      showOverlay('overlay-player-waiting');
    }
  });

  socket.on('grade-received', ({ grade, word }) => {
    // Показываем слово
    const wr = document.getElementById('ogp-word-reveal');
    const wt = document.getElementById('ogp-word');
    if (wr && wt && word) { wt.textContent = word; wr.classList.remove('hidden'); }

    // Скрываем лоадер, показываем оценку
    document.getElementById('ogp-waiting')?.classList.add('hidden');
    document.getElementById('ogp-result')?.classList.remove('hidden');

    const stars = document.getElementById('ogp-stars');
    const num   = document.getElementById('ogp-grade-num');

    if (grade !== null) {
      if (stars) stars.textContent = '⭐'.repeat(grade);
      if (num)   num.textContent   = grade;
      toast(`Оценка: ${grade} ${'⭐'.repeat(grade)} 🎉`, 'success');
    } else {
      if (stars) stars.textContent = '—';
      if (num)   num.textContent   = '';
      toast('Раунд без оценки', 'info');
    }
  });

  socket.on('game-finished', ({ grades }) => {
    S.gameStatus = 'finished';
    stopClientTimer();
    document.getElementById('round-bar')?.classList.add('hidden');
    renderGradesTable(grades);
    showOverlay('overlay-finished');
  });

  socket.on('draw', d => renderEvent(d));

  socket.on('cursor-move', ({ id, name, color, x, y }) => {
    if (S.canvas) updateCursor(id, name, color, x, y);
  });

  socket.on('canvas-cleared', ({ canvasColor }) => {
    fillBackground(canvasColor || '#ffffff');
    toast('Холст очищен 🧹', 'info');
  });

  socket.on('admin-disconnected', () => {
    toast('Учитель покинул урок', 'error');
  });

  // =============================================================
  //  TOAST
  // =============================================================
  let _toastTimer = null;
  function toast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    clearTimeout(_toastTimer);
    el.classList.remove('toast-out', 'hidden');
    el.textContent = msg;
    el.className   = `toast toast-${type}`;
    _toastTimer = setTimeout(() => {
      el.classList.add('toast-out');
      setTimeout(() => el.classList.add('hidden'), 220);
    }, 3000);
  }

  // =============================================================
  //  УТИЛИТЫ
  // =============================================================
  function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }

  // =============================================================
  //  PUBLIC API
  // =============================================================
  return {
    showScreen, goAdminSetup, goJoin,
    pickPreset, createRoom, copyLink,
    syncSettings, adjustSetting,
    startGame, startRound, stopRound,
    giveGrade, nextRound,
    joinRoom,
    setTool, clearCanvas, saveCanvas,
    zoomBy, resetZoom,
  };

})();
