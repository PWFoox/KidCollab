// =============================================================
//  script.js — DrawTogether v2
//  Машина состояний: lobby → waiting_word → drawing → grading → ... → finished
// =============================================================

const App = (() => {

  const socket = io();

  // =============================================================
  //  СОСТОЯНИЕ
  // =============================================================
  const S = {
    role:         null,      // 'admin' | 'player'
    roomId:       null,
    myName:       null,
    myColor:      null,
    gameStatus:   null,      // 'lobby'|'waiting_word'|'drawing'|'grading'|'finished'
    currentRound: 0,
    totalRounds:  3,
    word:         null,      // только учитель знает
    hint:         null,
    allowEraser:  true,
    grades:       [],

    // Canvas
    canvas:       null,
    ctx:          null,
    isDrawing:    false,
    lastX:        0,
    lastY:        0,
    tool:         'brush',
    brushColor:   '#1a1a1a',
    brushSize:    6,

    // Timer (client-side countdown)
    timerTotal:   60,
    timerLeft:    60,
    timerInterval:null,

    // Settings (admin local state for lobby)
    settings: {
      totalRounds: 3,
      roundTime:   60,
      autoClean:   true,
      showHint:    false,
      allowEraser: true,
      canvasColor: '#ffffff',
      canvasWidth: 900,
      canvasHeight:600,
    },
  };

  // Курсоры других игроков { socketId: HTMLElement }
  const cursors = {};

  // =============================================================
  //  НАВИГАЦИЯ
  // =============================================================
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function goAdminSetup() { showScreen('screen-admin-setup'); }
  function goJoin()       { showScreen('screen-join'); }

  // ── Если ?room=XXX в URL → сразу открыть форму входа
  (() => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get('room');
    if (r) { document.getElementById('join-room-id').value = r.toUpperCase(); showScreen('screen-join'); }
  })();

  // =============================================================
  //  ADMIN: выбор пресета холста
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
      // Sync color swatch
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
  //  ADMIN: чтение настроек из UI и отправка на сервер
  // =============================================================
  function syncSettings() {
    const s = S.settings;
    s.roundTime   = +document.getElementById('s-roundTime').value;
    s.autoClean   = document.getElementById('s-autoClean').checked;
    s.showHint    = document.getElementById('s-showHint').checked;
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

  /** Изменить числовое поле настроек (раунды) */
  function adjustSetting(key, delta) {
    const limits = { totalRounds: [1, 10] };
    const [mn, mx] = limits[key] || [1, 999];
    S.settings[key] = Math.min(mx, Math.max(mn, S.settings[key] + delta));
    const el = document.getElementById(`s-${key}`);
    if (el) el.textContent = S.settings[key];
    socket.emit('update-settings', { [key]: S.settings[key] });
  }

  // =============================================================
  //  ADMIN: старт игры (переход к вводу слова)
  // =============================================================
  function startGame() {
    syncSettings();
    socket.emit('start-game');
  }

  // =============================================================
  //  ADMIN: начать раунд (отправить слово)
  // =============================================================
  function startRound() {
    const word = document.getElementById('word-input').value.trim();
    if (!word) { toast('Введи слово для раунда!', 'error'); return; }
    document.getElementById('word-input').value = '';
    socket.emit('start-round', { word });
  }

  /** Досрочная остановка раунда */
  function stopRound() {
    socket.emit('stop-round');
  }

  // =============================================================
  //  ADMIN: поставить оценку
  // =============================================================
  function giveGrade(grade) {
    socket.emit('give-grade', { grade });

    const text = grade === null ? 'без оценки' : `${grade} ${'⭐'.repeat(grade)}`;
    document.getElementById('grade-given-text').textContent = text;
    document.getElementById('grade-given-display').classList.remove('hidden');

    // Обновить кнопки
    document.querySelectorAll('.grade-btn').forEach(b => b.style.opacity = '.4');
  }

  /** Следующий раунд или конец */
  function nextRound() {
    socket.emit('next-round');
  }

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
        // Опоздал — игра уже идёт
        initGameScreen(res.settings);
        replayHistory(res.drawHistory);
        showOverlay(null);
        startClientTimer(res.remaining ?? res.settings.roundTime, res.settings.roundTime);
        setRoundInfo(res.currentRound, S.totalRounds);
        if (res.hint) showHint(res.hint);
      } else if (res.status === 'grading') {
        initGameScreen(res.settings);
        showGradingOverlay(res.currentRound, S.totalRounds, null);
      } else {
        // Лобби или waiting_word
        document.getElementById('lobby-greeting').textContent = `Привет, ${name}! 👋`;
        showScreen('screen-player-lobby');
      }
    });
  }

  // =============================================================
  //  ИНИЦИАЛИЗАЦИЯ ЭКРАНА ИГРЫ
  //  Вызывается один раз при переходе admin/player на game screen
  // =============================================================
  function initGameScreen(settings) {
    showScreen('screen-game');

    S.canvas      = document.getElementById('main-canvas');
    S.ctx         = S.canvas.getContext('2d');
    S.canvas.width  = settings.canvasWidth;
    S.canvas.height = settings.canvasHeight;
    S.totalRounds   = settings.totalRounds;
    S.allowEraser   = settings.allowEraser;

    // Залить фон
    fillBackground(settings.canvasColor || '#ffffff');

    if (S.role === 'admin') {
      document.getElementById('toolbar-admin').classList.remove('hidden');
      document.getElementById('ta-round').textContent = `Раунд — / ${settings.totalRounds}`;
    } else {
      document.getElementById('toolbar-player').classList.remove('hidden');
      // Цвет и имя игрока
      document.getElementById('brush-color').value = S.myColor;
      S.brushColor = S.myColor;
      const badge = document.getElementById('player-badge');
      badge.textContent           = S.myName;
      badge.style.backgroundColor = S.myColor;

      // Ластик: если запрещён — скрыть кнопку
      if (!S.allowEraser) {
        document.getElementById('btn-eraser').style.display = 'none';
      }

      attachCanvasEvents();
      initToolbarControls();
    }
  }

  // =============================================================
  //  TOOLBAR: слушатели изменений инструментов (ученик)
  // =============================================================
  function initToolbarControls() {
    document.getElementById('brush-color').addEventListener('input', e => {
      S.brushColor = e.target.value;
    });
    document.getElementById('brush-size').addEventListener('input', e => {
      S.brushSize = +e.target.value;
      document.getElementById('size-val').textContent = S.brushSize;
    });
  }

  function setTool(tool) {
    S.tool = tool;
    document.getElementById('btn-brush').classList.toggle('active-tool',  tool === 'brush');
    document.getElementById('btn-eraser').classList.toggle('active-tool', tool === 'eraser');
    S.canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
  }

  // =============================================================
  //  CANVAS EVENTS
  // =============================================================
  function attachCanvasEvents() {
    S.canvas.addEventListener('mousedown',  onDown);
    S.canvas.addEventListener('mousemove',  onMove);
    S.canvas.addEventListener('mouseup',    onUp);
    S.canvas.addEventListener('mouseleave', onUp);
    S.canvas.addEventListener('touchstart', onTouchDown, { passive: false });
    S.canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
    S.canvas.addEventListener('touchend',   onUp);
  }

  function getPos(cx, cy) {
    const r = S.canvas.getBoundingClientRect();
    return {
      x: (cx - r.left) * (S.canvas.width  / r.width),
      y: (cy - r.top)  * (S.canvas.height / r.height),
    };
  }

  function onDown(e) {
    // Блокировать рисование если не идёт раунд
    if (S.gameStatus !== 'drawing') return;
    const { x, y } = getPos(e.clientX, e.clientY);
    S.isDrawing = true; S.lastX = x; S.lastY = y;
    const { color, size } = drawParams();
    drawDot(x, y, color, size);
    socket.emit('draw', { type: 'dot', x, y, color, size });
  }

  function onMove(e) {
    const { x, y } = getPos(e.clientX, e.clientY);
    socket.emit('cursor-move', { x, y });
    if (!S.isDrawing || S.gameStatus !== 'drawing') return;
    const { color, size } = drawParams();
    drawLine(S.lastX, S.lastY, x, y, color, size);
    socket.emit('draw', { type: 'line', x0: S.lastX, y0: S.lastY, x1: x, y1: y, color, size });
    S.lastX = x; S.lastY = y;
  }

  function onUp()        { S.isDrawing = false; }
  function onTouchDown(e){ e.preventDefault(); const t = e.touches[0]; onDown({ clientX: t.clientX, clientY: t.clientY }); }
  function onTouchMove(e){ e.preventDefault(); const t = e.touches[0]; onMove({ clientX: t.clientX, clientY: t.clientY }); }

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

  function fillBackground(color) {
    if (!S.ctx) return;
    S.ctx.fillStyle = color;
    S.ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
    if (S.canvas) S.canvas.dataset.bgColor = color;
  }

  function replayHistory(history) {
    (history || []).forEach(d => {
      if (d.type === 'line') drawLine(d.x0, d.y0, d.x1, d.y1, d.color, d.size);
      else if (d.type === 'dot') drawDot(d.x, d.y, d.color, d.size);
    });
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
  //  ТАЙМЕР (клиентский countdown)
  // =============================================================
  function startClientTimer(remaining, total) {
    stopClientTimer();
    S.timerTotal = total;
    S.timerLeft  = remaining;
    document.getElementById('round-bar').classList.remove('hidden');
    updateTimerUI(remaining, total);

    S.timerInterval = setInterval(() => {
      S.timerLeft = Math.max(0, S.timerLeft - 1);
      updateTimerUI(S.timerLeft, S.timerTotal);
      if (S.timerLeft <= 0) stopClientTimer();
    }, 1000);
  }

  function stopClientTimer() {
    clearInterval(S.timerInterval);
    S.timerInterval = null;
  }

  function updateTimerUI(left, total) {
    const arc  = document.getElementById('timer-arc');
    const text = document.getElementById('timer-text');
    if (!arc || !text) return;

    const pct = total > 0 ? (left / total) : 0;
    arc.style.strokeDashoffset = (1 - pct) * 100;
    text.textContent = Math.ceil(left);

    // Цвет: зелёный → жёлтый → красный
    if (pct > .5)      arc.style.stroke = '#22c55e';
    else if (pct > .2) arc.style.stroke = '#f59e0b';
    else               arc.style.stroke = '#ef4444';
  }

  // =============================================================
  //  ОВЕРЛЕИ
  // =============================================================

  /** Показать нужный оверлей (null — скрыть все) */
  function showOverlay(name) {
    const ids = ['overlay-word-input', 'overlay-player-waiting', 'overlay-grading', 'overlay-finished'];
    ids.forEach(id => document.getElementById(id).classList.add('hidden'));
    if (name) document.getElementById(name).classList.remove('hidden');
  }

  function setRoundInfo(current, total) {
    // Тулбар
    document.getElementById('ta-round').textContent = `Раунд ${current} / ${total}`;
    document.getElementById('tp-round').textContent = `Раунд ${current} / ${total}`;
  }

  function showHint(hint) {
    if (!hint) return;
    const el   = document.getElementById('tp-hint');
    const text = document.getElementById('tp-hint-text');
    if (el && text) { text.textContent = hint; el.classList.remove('hidden'); }
  }

  /** Показать оверлей оценки */
  function showGradingOverlay(roundNum, total, word) {
    S.gameStatus = 'grading';
    stopClientTimer();
    document.getElementById('round-bar').classList.add('hidden');

    // Сбросить кнопки оценки
    document.querySelectorAll('.grade-btn').forEach(b => b.style.opacity = '1');
    document.getElementById('grade-given-display').classList.add('hidden');

    // Следующий раунд или финиш
    const isLast = roundNum >= total;
    const nextBtn = document.getElementById('btn-next-round');
    nextBtn.textContent = isLast ? '🏁 Завершить игру' : 'Следующий раунд →';

    // Установить бейдж раунда
    const badge = `Раунд ${roundNum} / ${total}`;
    document.getElementById('og-badge').textContent  = badge;
    document.getElementById('ogp-badge').textContent = badge;

    if (word) {
      document.getElementById('og-word').textContent = word;
    }

    showOverlay('overlay-grading');

    if (S.role === 'admin') {
      document.getElementById('grading-admin').classList.remove('hidden');
      document.getElementById('grading-player').classList.add('hidden');
    } else {
      document.getElementById('grading-admin').classList.add('hidden');
      document.getElementById('grading-player').classList.remove('hidden');
      // Сбросить состояние ученика
      document.getElementById('ogp-waiting').classList.remove('hidden');
      document.getElementById('ogp-grade-display').classList.add('hidden');
      document.getElementById('ogp-word-reveal').classList.add('hidden');
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
  //  GRADES TABLE (финальный экран)
  // =============================================================
  function renderGradesTable(grades) {
    const tbody = document.getElementById('grades-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    grades.forEach(g => {
      const tr = document.createElement('tr');
      const stars = g.grade ? '⭐'.repeat(g.grade) : '—';
      tr.innerHTML = `<td>${g.round}</td><td>${g.word}</td><td>${g.grade ? g.grade + ' ' + stars : '—'}</td>`;
      tbody.appendChild(tr);
    });
  }

  // =============================================================
  //  SOCKET СОБЫТИЯ
  // =============================================================

  // Новый ученик (только учителю)
  socket.on('player-joined', ({ id, name, color, playerCount }) => {
    document.getElementById('player-count').textContent = playerCount;
    document.getElementById('waiting-hint')?.classList.add('hidden');

    const li = document.createElement('li');
    li.id        = `pl-${id}`;
    li.innerHTML = `<span class="color-dot" style="background:${color}"></span>${name}`;
    document.getElementById('player-list').appendChild(li);

    const btn = document.getElementById('btn-start');
    if (btn) btn.disabled = false;

    // Обновить счётчик в тулбаре
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

  // Игра стартовала — все переходят на экран игры
  socket.on('game-started', ({ settings }) => {
    S.totalRounds = settings.totalRounds;
    initGameScreen(settings);

    if (S.role === 'admin') {
      // Показать оверлей ввода слова для раунда 1
      document.getElementById('owi-badge').textContent = `Раунд 1 / ${settings.totalRounds}`;
      showOverlay('overlay-word-input');
      document.getElementById('word-input').focus();
    } else {
      // Ученик ждёт
      document.getElementById('opw-badge').textContent = `Раунд 1 / ${settings.totalRounds}`;
      showOverlay('overlay-player-waiting');
    }
  });

  // Раунд начался
  socket.on('round-started', ({ roundNum, totalRounds, duration, word, hint, canvasColor, allowEraser }) => {
    S.gameStatus  = 'drawing';
    S.currentRound= roundNum;
    S.totalRounds = totalRounds;
    S.word        = word || null;
    S.hint        = hint || null;
    S.allowEraser = allowEraser;

    // Автоочистка уже сделана на сервере (drawHistory=[]), но холст тоже чистим
    // (Сервер сообщит через настройку, клиент просто чистит при старте раунда если autoClean)
    // Здесь мы доверяем, что если сервер прислал round-started без истории — значит нужно чистить
    fillBackground(canvasColor || '#ffffff');

    setRoundInfo(roundNum, totalRounds);
    showOverlay(null);

    // Таймер
    startClientTimer(duration, duration);

    // Кнопка Стоп — только учителю
    if (S.role === 'admin') {
      document.getElementById('btn-stop-round').classList.remove('hidden');
      document.getElementById('ta-word').classList.remove('hidden');
      document.getElementById('ta-word-text').textContent = word || '—';
    } else {
      if (hint) showHint(hint);
    }

    // Разблокировать холст
    if (S.canvas) S.canvas.style.pointerEvents = S.role === 'player' ? 'auto' : 'none';
  });

  // Раунд завершён
  socket.on('round-ended', ({ roundNum, totalRounds, word }) => {
    // Заблокировать рисование
    if (S.canvas) S.canvas.style.pointerEvents = 'none';
    if (S.role === 'admin') document.getElementById('btn-stop-round').classList.add('hidden');

    showGradingOverlay(roundNum, totalRounds, word);
  });

  // Учитель объявляет следующий раунд (ученики ждут слово)
  socket.on('waiting-for-word', ({ currentRound, totalRounds }) => {
    S.gameStatus = 'waiting_word';
    document.getElementById('tp-hint').classList.add('hidden');

    if (S.role === 'admin') {
      const nextRound = currentRound + 1;
      document.getElementById('owi-badge').textContent = `Раунд ${nextRound} / ${totalRounds}`;
      showOverlay('overlay-word-input');
      document.getElementById('word-input').focus();
    } else {
      const nextRound = currentRound + 1;
      document.getElementById('opw-badge').textContent = `Раунд ${nextRound} / ${totalRounds}`;
      showOverlay('overlay-player-waiting');
    }
  });

  // Оценка пришла (ученики)
  socket.on('grade-received', ({ grade, roundNum, word }) => {
    // Показать слово
    const wr = document.getElementById('ogp-word-reveal');
    const wt = document.getElementById('ogp-word');
    if (wr && wt) { wt.textContent = word; wr.classList.remove('hidden'); }

    // Показать оценку
    document.getElementById('ogp-waiting').classList.add('hidden');
    const gd = document.getElementById('ogp-grade-display');
    gd.classList.remove('hidden');

    if (grade !== null) {
      document.getElementById('ogp-stars').textContent    = '⭐'.repeat(grade);
      document.getElementById('ogp-grade-num').textContent = grade;
      toast(`Оценка: ${grade} ${'⭐'.repeat(grade)}`, 'success');
    } else {
      document.getElementById('ogp-stars').textContent    = '—';
      document.getElementById('ogp-grade-num').textContent = '';
      toast('Раунд без оценки', 'info');
    }
  });

  // Игра завершена
  socket.on('game-finished', ({ grades }) => {
    S.gameStatus = 'finished';
    stopClientTimer();
    document.getElementById('round-bar').classList.add('hidden');
    renderGradesTable(grades);
    showOverlay('overlay-finished');
  });

  // Штрих от другого игрока
  socket.on('draw', (data) => {
    if (!S.ctx) return;
    if (data.type === 'line') drawLine(data.x0, data.y0, data.x1, data.y1, data.color, data.size);
    else if (data.type === 'dot') drawDot(data.x, data.y, data.color, data.size);
  });

  // Курсор другого игрока
  socket.on('cursor-move', ({ id, name, color, x, y }) => {
    if (S.canvas) updateCursor(id, name, color, x, y);
  });

  // Холст очищен
  socket.on('canvas-cleared', ({ canvasColor }) => {
    fillBackground(canvasColor || '#ffffff');
    toast('Холст очищен', 'info');
  });

  // Учитель отключился
  socket.on('admin-disconnected', () => {
    toast('Учитель покинул урок', 'error');
  });

  // =============================================================
  //  TOAST
  // =============================================================
  let toastTimer = null;
  function toast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className   = `toast toast-${type}`;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
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
