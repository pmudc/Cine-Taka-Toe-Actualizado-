// =========================
// 0) CONFIG
// =========================

// 👉 Poner la TMDB API KEY v3. NO SUBIR a GitHub.
const API_KEY = "1e41d5f770aa0d7656e3e3f19f62ce1d";

// =========================
// 0.x) SANITIZADOR DE RESULTADOS (PATCH)
// =========================

// 🚫 Películas “problemáticas”
const BLOCKED_MOVIE_IDS = [
  13610, // Final Cut: Ladies & Gentlemen (2012) - mashup
  // Si vemos otro ID en consola, lo añadimos aquí
];

// Bloqueo por título/original_title (cubre variantes y traducciones)
const BLOCKED_TITLE_REGEX = /final\s*cut.*ladies|hölgyeim|final\s*cut:\s*ladies/i;

function isBlockedMovieLike(m) {
  const id = Number(m?.id);
  const t1 = (m?.title || "");
  const t2 = (m?.original_title || "");
  return BLOCKED_MOVIE_IDS.includes(id) || BLOCKED_TITLE_REGEX.test(`${t1} ${t2}`);
}

// Filtra arrays de películas de TMDB para excluir IDs o títulos bloqueados
function sanitizeResults(results = []) {
  return (results || []).filter(m => !isBlockedMovieLike(m));
}

// =========================
// 0.1) TURNOS / FIN DE PARTIDA
// =========================
let currentPlayer = "blue"; // "blue" | "red"
let gameOver = false;
let winnerPlayer = null;    // "blue" | "red" | null

// =========================
// 0.2) MARCADOR (PARTIDAS GANADAS)
// =========================
let scoreBlue = 0;
let scoreRed = 0;

try {
  const saved = JSON.parse(localStorage.getItem("cineTakaToeScore") || "{}");
  if (typeof saved.blue === "number") scoreBlue = saved.blue;
  if (typeof saved.red === "number") scoreRed = saved.red;
} catch {}

// Estado del tablero
let selectedCell = null; // { r, c }
let placed = Array.from({ length: 3 }, () => Array(3).fill(null));

// Reglas actuales (se generan por partida)
let rowRules = [];
let colRules = [];

// Cache para no machacar TMDB con discover
const discoverCache = new Map();

// =========================
// 0.3) TEMPORIZADOR POR TURNO
// =========================
let turnSeconds = 0;      // 0 = sin tiempo
let timeLeft = 0;         // segundos restantes
let timerId = null;       // setInterval id

// =========================
// 1) LLAMADAS A TMDB
// =========================

async function searchMovie(query) {
  const url =
    "https://api.themoviedb.org/3/search/movie" +
    `?api_key=${API_KEY}` +
    `&query=${encodeURIComponent(query)}` +
    "&include_adult=false" +
    "&language=es-ES" +
    "&page=1";

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`search/movie ${res.status} -> ${txt}`);
  }
  return res.json();
}

// Trae detalles + créditos en una sola llamada
async function getMovieFull(movieId) {
  const url =
    `https://api.themoviedb.org/3/movie/${movieId}` +
    `?api_key=${API_KEY}` +
    "&language=es-ES" +
    "&append_to_response=credits";

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`movie/full ${res.status} -> ${txt}`);
  }
  return res.json();
}

// Buscar persona por nombre (para construir pools por nombres si queréis)
async function searchPerson(name) {
  const url =
    "https://api.themoviedb.org/3/search/person" +
    `?api_key=${API_KEY}` +
    `&query=${encodeURIComponent(name)}` +
    "&language=es-ES" +
    "&page=1";

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`search/person ${res.status} -> ${txt}`);
  }
  return res.json();
}

// Discover: solo necesitamos saber cuántas pelis existen para esa intersección
async function discoverCount(params) {
  const base = {
    api_key: API_KEY,
    language: "es-ES",
    include_adult: "false",
    sort_by: "popularity.desc",
    page: "1",
    ...params,
  };

  const key = JSON.stringify(base);
  if (discoverCache.has(key)) return discoverCache.get(key);

  const qs = new URLSearchParams(base).toString();
  const url = `https://api.themoviedb.org/3/discover/movie?${qs}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`discover ${res.status} -> ${txt}`);
  }

  const data = await res.json();
  const count = data.total_results || 0;

  discoverCache.set(key, count);
  return count;
}

// Discover: lista de películas (para completar casillas)
async function discoverList(params) {
  const base = {
    api_key: API_KEY,
    language: "es-ES",
    include_adult: "false",
    sort_by: "popularity.desc",
    page: "1",
    ...params,
  };

  const qs = new URLSearchParams(base).toString();
  const url = `https://api.themoviedb.org/3/discover/movie?${qs}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`discoverList ${res.status} -> ${txt}`);
  }

  // PATCH: saneamos aquí
  const data = await res.json();
  data.results = sanitizeResults(data.results || []);
  return data;
}

// =========================
// 2) UI HELPERS
// =========================

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function updateTurnInfo() {
  const el = document.getElementById("turnInfo");
  if (!el) return;

  el.classList.remove("turnBlue", "turnRed");

  if (winnerPlayer) {
    const who = winnerPlayer === "blue" ? "Azul 🔵" : "Rojo 🔴";
    el.textContent = `Ganador: ${who}`;
    el.classList.add(winnerPlayer === "blue" ? "turnBlue" : "turnRed");
    return;
  }

  if (gameOver) {
    el.textContent = "Partida terminada";
    return;
  }

  if (currentPlayer === "blue") {
    el.textContent = "Turno: Azul 🔵";
    el.classList.add("turnBlue");
  } else {
    el.textContent = "Turno: Rojo 🔴";
    el.classList.add("turnRed");
  }
}

function applyTheme() {
  document.body.classList.remove("theme-blue", "theme-red", "theme-neutral");

  // si no hay partida o está bloqueada sin ganador
  if (!rowRules.length || !colRules.length) {
    document.body.classList.add("theme-neutral");
    return;
  }

  // si hay ganador, dejamos el color del ganador (queda guapo)
  if (winnerPlayer) {
    document.body.classList.add(winnerPlayer === "blue" ? "theme-blue" : "theme-red");
    return;
  }

  // si está en gameOver sin ganador (empate), neutro
  if (gameOver) {
    document.body.classList.add("theme-neutral");
    return;
  }

  // turno normal
  document.body.classList.add(currentPlayer === "blue" ? "theme-blue" : "theme-red");
}

function updateScoreInfo() {
  const el = document.getElementById("scoreInfo");
  if (!el) return;
  el.textContent = `Marcador: Azul ${scoreBlue} - ${scoreRed} Rojo`;
  try {
  localStorage.setItem("cineTakaToeScore", JSON.stringify({ blue: scoreBlue, red: scoreRed }));
} catch {}
}

function updateTimerInfo() {
  const el = document.getElementById("timerInfo");
  if (!el) return;

  // si no hay tiempo, infinito
  if (turnSeconds === 0) {
    el.textContent = "⏱️ Tiempo: ∞";
    el.classList.remove("timerWarn");
    return;
  }

  el.textContent = `⏱️ Tiempo: ${timeLeft}s`;

  // aviso visual cuando quedan 5s o menos
  if (timeLeft <= 5) el.classList.add("timerWarn");
  else el.classList.remove("timerWarn");
}

function stopTurnTimer() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

// Arranca el temporizador del turno actual (currentPlayer)
function startTurnTimer() {
  stopTurnTimer();

  // no hacemos nada si no hay tiempo o si la partida está bloqueada
  if (turnSeconds === 0 || gameOver) {
    updateTimerInfo();
    return;
  }

  timeLeft = turnSeconds;
  updateTimerInfo();

  timerId = setInterval(() => {
    // si en mitad del intervalo acaba la partida, paramos
    if (gameOver) {
      stopTurnTimer();
      return;
    }

    timeLeft--;
    updateTimerInfo();

    if (timeLeft <= 0) {
      stopTurnTimer();
      onTimeOut(); // timeout -> pierde turno
    }
  }, 1000);
}

// Qué pasa cuando se agota el tiempo
function onTimeOut() {
  // limpia selección para que no quede “enganchada”
  selectedCell = null;
  renderBoard();

  setStatus(`⏰ Tiempo agotado. ${currentPlayer === "blue" ? "Azul pierde turno" : "Rojo pierde turno"}.`);

  // cambia turno SIEMPRE
  switchTurn();      // (si tu switchTurn arranca timer, ya está)
  // si tu switchTurn NO arranca timer, entonces descomenta:
  // startTurnTimer();
}


function switchTurn() {
  currentPlayer = currentPlayer === "blue" ? "red" : "blue";
  updateTurnInfo();
  applyTheme();
  startTurnTimer?.(); // si tenéis timer, o ignóralo si no
}


function getOwner(r, c) {
  return placed[r][c]?.player || null;
}

function boardFull() {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (!placed[r][c]) return false;
    }
  }
  return true;
}

function checkWinner() {
  const lines = [
    [[0,0],[0,1],[0,2]],
    [[1,0],[1,1],[1,2]],
    [[2,0],[2,1],[2,2]],
    [[0,0],[1,0],[2,0]],
    [[0,1],[1,1],[2,1]],
    [[0,2],[1,2],[2,2]],
    [[0,0],[1,1],[2,2]],
    [[0,2],[1,1],[2,0]],
  ];

  for (const line of lines) {
    const [a,b,c] = line;
    const p1 = getOwner(a[0], a[1]);
    if (!p1) continue;
    const p2 = getOwner(b[0], b[1]);
    const p3 = getOwner(c[0], c[1]);
    if (p1 === p2 && p2 === p3) return p1;
  }
  return null;
}

function showEndModal(title, text) {
  const modal = document.getElementById("endModal");
  const h2 = document.getElementById("endTitle");
  const p = document.getElementById("endText");
  if (!modal || !h2 || !p) return;

  h2.textContent = title;
  p.textContent = text;
  modal.classList.remove("hidden");
}

function hideEndModal() {
  const modal = document.getElementById("endModal");
  if (modal) modal.classList.add("hidden");
}

function showStartModal() {
  const m = document.getElementById("startModal");
  if (m) m.classList.remove("hidden");
}

function hideStartModal() {
  const m = document.getElementById("startModal");
  if (m) m.classList.add("hidden");
}

// =========================
// 3) PINTAR RESULTADOS DE PELÍCULAS
// =========================

function renderMovieResults(data) {
  const resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = "";

  const items = (data.results || []).slice(0, 12);

  for (const m of items) {
    const posterUrl = m.poster_path
      ? `https://image.tmdb.org/t/p/w342${m.poster_path}`
      : "";

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      ${posterUrl ? `<img src="${posterUrl}" alt="${(m.title || "").replaceAll('"', "")}">` : `<div style="height:260px"></div>`}
      <h3>${m.title || "Sin título"}</h3>
      <p>${(m.release_date || "").slice(0, 4) || "¿?"}</p>
      <button class="useBtn">Usar esta peli</button>
    `;

    el.querySelector(".useBtn").addEventListener("click", () => {
      onPickMovie(m.id, m.title, posterUrl);
    });

    resultsDiv.appendChild(el);
  }
}

// =========================
// 4) TABLERO 3×3
// =========================

function renderBoard() {
  const board = document.getElementById("board");
  board.innerHTML = "";

  // Nos aseguramos de que el contenedor tiene la clase nueva
  board.className = "boardWithHeaders";

  // Icono según tipo de regla (opcional, solo visual)
  const iconForRule = (rule) => {
    switch (rule?.type) {
      case "castIncludes": return "👤";   // actor/actriz
      case "directedBy":   return "🎬";   // director/a
      case "genre":        return "🏷️";   // género
      case "decade":       return "📅";   // década
      default:             return "❓";
    }
  };

  // Grid 4x4: r = -1..2, c = -1..2
  // r=-1 -> cabecera columnas
  // c=-1 -> cabecera filas
  for (let r = -1; r < 3; r++) {
    for (let c = -1; c < 3; c++) {

      // --- ESQUINA (arriba-izquierda) ---
      if (r === -1 && c === -1) {
        const corner = document.createElement("div");
        corner.className = "corner";
        const logoSrc = new URL("assets/logo.png", document.baseURI).href;
        corner.innerHTML = `<img class="cornerLogo" src="${logoSrc}?v=1" alt="Cine Taka Toe">`;
        board.appendChild(corner);
        continue;
      }

      // --- CABECERA DE COLUMNA (arriba) ---
      if (r === -1 && c >= 0) {
        const rule = colRules[c];
        const hdr = document.createElement("div");
        hdr.className = "hdr";
        hdr.innerHTML = `
          <div class="hdrTitle">${iconForRule(rule)} ${rule?.label ?? "—"}</div>
          <div class="hdrSub">Columna ${c + 1}</div>
        `;
        board.appendChild(hdr);
        continue;
      }

      // --- CABECERA DE FILA (izquierda) ---
      if (c === -1 && r >= 0) {
        const rule = rowRules[r];
        const hdr = document.createElement("div");
        hdr.className = "hdr";
        hdr.innerHTML = `
          <div class="hdrTitle">${iconForRule(rule)} ${rule?.label ?? "—"}</div>
          <div class="hdrSub">Fila ${r + 1}</div>
        `;
        board.appendChild(hdr);
        continue;
      }

      // --- CELDAS JUGABLES 3x3 ---
      const cell = document.createElement("div");
      cell.className = "cell";

      const movie = placed[r][c];
      if (movie?.player) cell.classList.add(movie.player);

      if (selectedCell && selectedCell.r === r && selectedCell.c === c) {
        cell.classList.add("selected");
      }

      if (movie) {
        cell.innerHTML = `
          ${movie.poster ? `<img src="${movie.poster}" alt="${movie.title.replaceAll('"', "")}">` : ""}
          <strong>${movie.title}</strong>
        `;
      } else {
        // celda vacía: solo muestra "elige" para que quede clean
        cell.innerHTML = `<strong>+</strong><small>Elegir</small>`;
      }

      cell.addEventListener("click", () => {
        if (!rowRules.length || !colRules.length) {
          setStatus("Primero pulsa “Nueva partida” para generar categorías.");
          return;
        }

        if (placed[r][c]) return;

        if (gameOver) {
          setStatus("La partida terminó. Usa el modal: Nueva partida / Seguir jugando / Completar.");
          return;
        }

        selectedCell = { r, c };
        setStatus(`Casilla seleccionada: ${r + 1}-${c + 1}. Turno ${currentPlayer === "blue" ? "Azul 🔵" : "Rojo 🔴"}. Busca peli y pulsa “Usar esta peli”.`);
        renderBoard();
      });

      board.appendChild(cell);
    }
  }
}

// =========================
// 5) VALIDACIÓN (PELÍCULA CUMPLE FILA + COLUMNA)
// =========================

function checkRule(movie, rule) {
  const castIds = new Set((movie.credits?.cast || []).map(p => p.id));
  const crew = movie.credits?.crew || [];

  switch (rule.type) {
    case "castIncludes":
      return castIds.has(rule.personId);

    case "directedBy":
      return crew.some(p => p.id === rule.personId && p.job === "Director");

    case "genre":
      return (movie.genres || []).some(g => g.id === rule.genreId);

    case "decade": {
      const year = parseInt((movie.release_date || "").slice(0, 4), 10);
      if (Number.isNaN(year)) return false;
      return year >= rule.from && year <= rule.to;
    }

    default:
      return false;
  }
}

// Encuentra automáticamente una peli válida para una casilla (fila+col)
async function findValidMovieForCell(rr, cc, maxCandidates = 25) {
  const params = mergeDiscoverParams(ruleToDiscoverParams(rr), ruleToDiscoverParams(cc));
  const data = await discoverList(params);

  // PATCH: filtrar Final Cut ANTES de usar candidatos
  data.results = sanitizeResults(data.results || []);

  const candidates = (data.results || []).slice(0, maxCandidates);

  for (const cand of candidates) {
    // PATCH: por si viniera algo raro, re-bloqueo por ID/título
    if (isBlockedMovieLike(cand)) continue;

    const full = await getMovieFull(cand.id);

    // PATCH: y bloqueo también tras expandir (por si el título original del full coincide)
    if (isBlockedMovieLike(full)) continue;

    if (checkRule(full, rr) && checkRule(full, cc)) {
      const poster = cand.poster_path ? `https://image.tmdb.org/t/p/w342${cand.poster_path}` : "";
      return { id: cand.id, title: cand.title || full.title, poster };
    }
  }

  return null;
}

async function completeBoard() {
  if (!rowRules.length || !colRules.length) {
    setStatus("Primero genera una partida con “Nueva partida”.");
    return;
  }

  setStatus("Completando tablero automáticamente... (puede tardar)");
  try {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (placed[r][c]) continue;

        const found = await findValidMovieForCell(rowRules[r], colRules[c], 25);
        if (found) {
          // neutro (no suma a ningún jugador)
          placed[r][c] = { ...found, player: null };
        }
        renderBoard();
      }
    }
    setStatus("✅ Tablero completado (lo que se pudo encontrar).");
  } catch (e) {
    console.error(e);
    setStatus("ERROR ❌ " + e.message);
  }
}

async function onPickMovie(movieId, title, poster) {
  if (!rowRules.length || !colRules.length) {
    setStatus("Primero pulsa “Nueva partida” para generar categorías.");
    return;
  }

  if (!selectedCell) {
    setStatus("Primero selecciona una casilla del tablero.");
    return;
  }

  // PATCH: bloqueo duro por ID (por si el ID llega a mano)
  if (BLOCKED_MOVIE_IDS.includes(movieId)) {
    setStatus("❌ Esa película no es válida para el juego.");
    // castiga el turno igualmente, como si fuese inválida
    selectedCell = null;
    renderBoard();
    switchTurn();
    return;
  }

  const { r, c } = selectedCell;

  if (placed[r][c]) {
    setStatus("Esa casilla ya está ocupada.");
    return;
  }

  setStatus("Validando película...");
  stopTurnTimer();

  try {
    const full = await getMovieFull(movieId);

    // PATCH: bloqueo por título/original_title tras expandir
  if (isBlockedMovieLike(full)) {
    setStatus("❌ Esa película no es válida para el juego.");
    selectedCell = null;
    renderBoard();
    switchTurn();
    return;
  }

    const okRow = checkRule(full, rowRules[r]);
    const okCol = checkRule(full, colRules[c]);

    if (okRow && okCol) {
  const playedBy = currentPlayer;

  placed[r][c] = { id: movieId, title: title || full.title, poster, player: playedBy };
  selectedCell = null;
  renderBoard();
  const w = checkWinner();
  if (!w) switchTurn();

  if (w) {
    winnerPlayer = w;
    // sumar 1 partida al ganador (solo la primera vez)
    if (w === "blue") scoreBlue++;
    else scoreRed++;
    updateScoreInfo();

    gameOver = true;
    updateTurnInfo();
    applyTheme();

    const who = w === "blue" ? "Azul 🔵" : "Rojo 🔴";
    setStatus(`🏆 Gana ${who}.`);
    showEndModal(`🏆 Victoria ${who}`, "Opciones: Nueva partida / Seguir jugando / Completar.");
    return;
  }

  // Empate si tablero lleno y nadie ganó
  if (boardFull()) {
    gameOver = true;
    winnerPlayer = null;
    updateTurnInfo();
    applyTheme();

    setStatus("🤝 Empate.");
    showEndModal("🤝 Empate", "Opciones: Nueva partida / Seguir jugando / Completar.");
    return;
  }

  setStatus(`✅ Válida. Colocada. ${currentPlayer === "blue" ? "Turno Azul 🔵" : "Turno Rojo 🔴"}.`);
} else {
  // ❌ FALLA -> TURNO CAMBIA IGUAL
  selectedCell = null;
  renderBoard();

  let msg = "❌ No válida. Falló: ";
  if (!okRow && !okCol) msg += "fila y columna";
  else if (!okRow) msg += "fila";
  else msg += "columna";

  // TURNO CAMBIA SIEMPRE
  switchTurn();

  setStatus(`${msg}. ${currentPlayer === "blue" ? "Turno Azul 🔵" : "Turno Rojo 🔴"}.`);
}

  } catch (e) {
    console.error(e);
    setStatus("ERROR ❌ " + e.message);
  }
}

// =========================
// 6) GENERACIÓN ALEATORIA DE PARTIDA (CATEGORÍAS)
// =========================

// Pools de categorías (MVP).
// Puedes meter aquí muchos nombres. Si no quieres IDs a mano, usamos nombres y los convertimos a IDs.
const ACTOR_NAMES = [
  "Al Pacino", "Robert De Niro", "Brad Pitt", "Tom Hanks", "Leonardo DiCaprio",
  "Scarlett Johansson", "Natalie Portman", "Morgan Freeman", "Johnny Depp", "Meryl Streep",
  "Tom Cruise", "Marlon Brando", "Harrison Ford", "Matt Damon", "Clint Eastwood", "Charlie Chaplin"
];

const DIRECTOR_NAMES = [
  "Christopher Nolan", "Steven Spielberg", "Martin Scorsese", "Quentin Tarantino",
  "Ridley Scott", "David Fincher", "James Cameron", "Pedro Almodóvar", "Francis Ford Coppola",
  "Clint Eastwood", "Stanley Kubrick", "Alfred Hitchcock"
];

// Géneros TMDB (IDs estándar)
const GENRES = [
  { id: 28, name: "Acción" },
  { id: 12, name: "Aventura" },
  { id: 35, name: "Comedia" },
  { id: 18, name: "Drama" },
  { id: 80, name: "Crimen" },
  { id: 27, name: "Terror" },
  { id: 53, name: "Thriller" },
  { id: 10749, name: "Romance" },
  { id: 878, name: "Ciencia ficción" },
  { id: 9648, name: "Misterio" },
  { id: 36, name: "Histórica" },
  { id: 37, name: "Oeste" }

];

const DECADES = [
  { from: 1950, to: 1959, label: "Años 50" },
  { from: 1960, to: 1969, label: "Años 60" },
  { from: 1970, to: 1979, label: "Años 70" },
  { from: 1980, to: 1989, label: "Años 80" },
  { from: 1990, to: 1999, label: "Años 90" },
  { from: 2000, to: 2009, label: "Años 2000" },
  { from: 2010, to: 2019, label: "Años 2010" },
];

// Convertir nombres a IDs (una vez) para tener pools fiables
let ACTORS = [];    // {type, personId, label}
let DIRECTORS = []; // {type, personId, label}
let poolsReady = false;

async function buildPersonPools() {
  if (poolsReady) return;

  setStatus("Preparando categorías (actores/directores)...");

  // Actores
  ACTORS = [];
  for (const name of ACTOR_NAMES) {
    const data = await searchPerson(name);
    if (data.results?.length) {
      const best = data.results[0];
      ACTORS.push({ type: "castIncludes", personId: best.id, label: `Sale ${best.name}` });
    }
  }

  // Directores (también son personas en TMDB)
  DIRECTORS = [];
  for (const name of DIRECTOR_NAMES) {
    const data = await searchPerson(name);
    if (data.results?.length) {
      const best = data.results[0];
      DIRECTORS.push({ type: "directedBy", personId: best.id, label: `Dirigida por ${best.name}` });
    }
  }

  poolsReady = true;
}

// Una regla -> parámetros discover
function ruleToDiscoverParams(rule) {
  switch (rule.type) {
    case "castIncludes":
      return { with_cast: String(rule.personId) };
    case "directedBy":
      return { with_crew: String(rule.personId) };
    case "genre":
      return { with_genres: String(rule.genreId) };
    case "decade":
      return {
        "primary_release_date.gte": `${rule.from}-01-01`,
        "primary_release_date.lte": `${rule.to}-12-31`,
      };
    default:
      return {};
  }
}

// Mezcla params (con comas cuando procede)
function mergeDiscoverParams(a, b) {
  const out = { ...a };

  for (const [k, v] of Object.entries(b)) {
    if (!out[k]) out[k] = v;
    else {
      if (k === "with_cast" || k === "with_genres" || k === "with_crew") {
        const set = new Set((out[k] + "," + v).split(",").filter(Boolean));
        out[k] = [...set].join(",");
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

// Incompatibilidades rápidas (evitar intentos absurdos)
function areRulesIncompatible(r1, r2) {
  // Dos directores distintos a la vez casi siempre imposible
  if (r1.type === "directedBy" && r2.type === "directedBy") {
    return r1.personId !== r2.personId;
  }

  // Décadas sin solape
  if (r1.type === "decade" && r2.type === "decade") {
    return r1.to < r2.from || r2.to < r1.from;
  }

  return false;
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

// Crea una "clave única" para saber si dos reglas son EXACTAMENTE la misma
function ruleKey(rule) {
  switch (rule.type) {
    case "castIncludes":
      return `cast:${rule.personId}`;
    case "directedBy":
      return `dir:${rule.personId}`;
    case "genre":
      return `genre:${rule.genreId}`;
    case "decade":
      return `decade:${rule.from}-${rule.to}`;
    default:
      return JSON.stringify(rule);
  }
}

// Elige N reglas aleatorias SIN REPETIR, y evitando claves prohibidas
function pickNUniqueRules(n, forbiddenKeys = new Set(), maxTries = 500) {
  const picked = [];
  const used = new Set(forbiddenKeys);

  let tries = 0;
  while (picked.length < n && tries < maxTries) {
    tries++;

    const r = pickRandomRule();
    const k = ruleKey(r);

    if (used.has(k)) continue; // no repetir exactos
    used.add(k);
    picked.push(r);
  }

  if (picked.length < n) return null; // no se pudo con las pools actuales
  return picked;
}

function pickRandomRule() {
  // Ajusta pesos aquí si quieres: más actores que directores, etc.
  const roll = Math.random();

  if (roll < 0.45 && ACTORS.length) {
    return ACTORS[randInt(ACTORS.length)];
  }
  if (roll < 0.60 && DIRECTORS.length) {
    return DIRECTORS[randInt(DIRECTORS.length)];
  }
  if (roll < 0.85) {
    const g = GENRES[randInt(GENRES.length)];
    return { type: "genre", genreId: g.id, label: `Género ${g.name}` };
  }
  const d = DECADES[randInt(DECADES.length)];
  return { type: "decade", from: d.from, to: d.to, label: d.label };
}

function pick3Rules(forbiddenKeys = new Set()) {
  // Permitimos repetir tipos y hasta repetir reglas.
  // Evitamos repetidos exactos (mismas condiciones)
  return pickNUniqueRules(3, forbiddenKeys);
}

async function generateNewGame(minPerCell = 5, maxAttempts = 40) {

  async function actorDirectedPairExists(actorId, directorId) {
  const url =
    `https://api.themoviedb.org/3/discover/movie?` +
    `api_key=${API_KEY}` +
    `&with_cast=${actorId}` +
    `&with_crew=${directorId}` +
    `&with_job=Director` + 
    `&language=es-ES&page=1`;

  const res = await fetch(url);
  const data = await res.json();
  return (data.total_results || 0) > 0;
}

  await buildPersonPools();

  setStatus("Generando nueva partida (buscando categorías jugables)...");
  discoverCache.clear();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rows = pick3Rules();
    if (!rows) continue;

    // Prohibimos en columnas cualquier regla ya usada en filas
    const usedKeys = new Set(rows.map(ruleKey));

    const cols = pick3Rules(usedKeys);
    if (!cols) continue;

    // Regla MVP: evitar directores en ambos ejes (reduce tableros imposibles)
    const rowsHasDirector = rows.some(r => r.type === "directedBy");
    const colsHasDirector = cols.some(r => r.type === "directedBy");
    if (rowsHasDirector && colsHasDirector) continue;

    // Comprobar las 9 casillas con discover
    let ok = true;

    for (const rr of rows) {
      for (const cc of cols) {
        async function actorDirectedPairExists(actorId, directorId) {
        const url =
        `https://api.themoviedb.org/3/discover/movie` +
        `?api_key=${API_KEY}` +
        `&with_cast=${actorId}` +
        `&with_crew=${directorId}` +
        `&with_job=Director` +
        `&language=es-ES&page=1`;

        const res = await fetch(url);
        const data = await res.json();
        return (data.total_results || 0) > 0;
      }
        if (areRulesIncompatible(rr, cc)) { ok = false; break; }

        // PATCH: evitar actor + director imposibles en la vida real
        if (rr.type === "castIncludes" && cc.type === "directedBy") {
          const exists = await actorDirectedPairExists(rr.personId, cc.personId);
          if (!exists) { ok = false; break; }
        }

        if (rr.type === "directedBy" && cc.type === "castIncludes") {
          const exists = await actorDirectedPairExists(cc.personId, rr.personId);
          if (!exists) { ok = false; break; }
}

        const p = mergeDiscoverParams(ruleToDiscoverParams(rr), ruleToDiscoverParams(cc));
        const count = await discoverCount(p);
        if (count < minPerCell) { ok = false; break; }
      }
      if (!ok) break;
    }

    if (ok) {
      rowRules = rows;
      colRules = cols;

      // reset tablero
      selectedCell = null;
      placed = Array.from({ length: 3 }, () => Array(3).fill(null));

      // reset turnos / fin / modal
      currentPlayer = "blue";
      gameOver = false;
      winnerPlayer = null;
      hideEndModal();
      updateTurnInfo();

      stopTurnTimer();
      updateTimerInfo();

      renderBoard();
      setStatus(`✅ Nueva partida lista (intento ${attempt}/${maxAttempts}). Selecciona una casilla y juega.`);

      applyTheme();
      return;
    }
  }

  setStatus("❌ No encontré un tablero válido. Prueba a bajar la dificultad a “Fácil”.");
}

// =========================
// 7) EVENTOS UI
// =========================

// Buscar películas
document.getElementById("btnBuscar").addEventListener("click", async () => {
  const q = document.getElementById("query").value.trim();
  if (!q) return;

  setStatus("Buscando películas...");
  try {
    const data = await searchMovie(q);
    
    // PATCH: filtrar “Final Cut” y similares
    data.results = sanitizeResults(data.results || []);

    renderMovieResults(data);
    setStatus("OK ✅ Elige una casilla y pulsa “Usar esta peli”.");
  } catch (e) {
    console.error(e);
    setStatus("ERROR ❌ " + e.message);
  }
});

// Nueva partida
document.getElementById("btnNewGame").addEventListener("click", async () => {
  const minPerCell = parseInt(document.getElementById("difficulty").value, 10);

  // leer modo de tiempo (0, 15, 30, 60)
  const sel = document.getElementById("timeMode");
  turnSeconds = sel ? parseInt(sel.value, 10) : 0;

  await generateNewGame(minPerCell);

  // arranca timer para el primer turno (Azul)
  startTurnTimer();
});

// Saltar turno (pasa el turno aunque no se juegue)
document.getElementById("btnSkipTurn")?.addEventListener("click", () => {
  if (!rowRules.length || !colRules.length) {
    setStatus("Primero pulsa “Nueva partida” para generar categorías.");
    return;
  }

  if (gameOver) {
    setStatus("La partida terminó. Pulsa “Seguir jugando” o “Nueva partida” en el modal.");
    return;
  }

  selectedCell = null; // quita selección si había
  switchTurn();
  renderBoard();
  setStatus(`Turno saltado. ${currentPlayer === "blue" ? "Turno Azul 🔵" : "Turno Rojo 🔴"}.`);
});

// Completar: rellenar automáticamente casillas vacías con pelis válidas
document.getElementById("btnComplete")?.addEventListener("click", completeBoard);
document.getElementById("btnCompleteNow")?.addEventListener("click", completeBoard);

// =========================
// 7.1) EVENTOS MODAL FIN PARTIDA
// =========================

// Seguir jugando: desbloquea para completar manualmente
document.getElementById("btnContinue")?.addEventListener("click", () => {
  gameOver = false;
  winnerPlayer = null;   // 🔥 IMPORTANTE: vuelve a turnos normales
  hideEndModal();
  updateTurnInfo();
  setStatus("Modo seguir: completad las casillas vacías. El turno sigue alternando aunque ya hubiera ganador.");
  startTurnTimer();
});

// Nueva partida desde el modal
document.getElementById("btnNewFromModal")?.addEventListener("click", async () => {
  hideEndModal();
  const minPerCell = parseInt(document.getElementById("difficulty").value, 10);
  await generateNewGame(minPerCell);
});

// (Opcional) click fuera del modal para cerrar
document.getElementById("endModal")?.addEventListener("click", (e) => {
  if (e.target.id === "endModal") hideEndModal();
});

// =========================
// 7.2) INICIO: ELEGIR MODO AL ENTRAR
// =========================
document.addEventListener("DOMContentLoaded", () => {
  // (Opcional) cargar el último modo guardado
  try {
    const savedMode = localStorage.getItem("cineTakaToeTimeMode");
    if (savedMode) {
      const startSel = document.getElementById("startTimeMode");
      if (startSel) startSel.value = savedMode;
    }
  } catch {}

  document.getElementById("btnStartGame")?.addEventListener("click", async () => {
    const startSel = document.getElementById("startTimeMode");
    const chosen = startSel ? parseInt(startSel.value, 10) : 0;

    // aplicar modo
    turnSeconds = chosen;

    // reflejarlo también en el selector del tablero (si existe)
    const topSel = document.getElementById("timeMode");
    if (topSel) topSel.value = String(chosen);

    // guardar preferencia
    try { localStorage.setItem("cineTakaToeTimeMode", String(chosen)); } catch {}

    hideStartModal();

    // generar partida y arrancar timer
    const minPerCell = parseInt(document.getElementById("difficulty").value, 10);
    await generateNewGame(minPerCell);
    startTurnTimer();
  });
});

// Pintar tablero vacío al inicio
renderBoard();

updateTurnInfo();
updateScoreInfo();
applyTheme();