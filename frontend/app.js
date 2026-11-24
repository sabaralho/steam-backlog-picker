(() => {
  "use strict";

  const STORAGE_KEY = "steam_backlog_picker_statuses_v1";
  const VALID_STATUSES = new Set(["played", "favorite", "hidden"]);
  const MAX_HOURS_UNLIMITED = 101;
  const MAX_GB_UNLIMITED = 151;

  const FALLBACK_SVG =
    "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 215">
        <rect width="460" height="215" fill="#0d111a"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
              fill="#64748b" font-family="sans-serif" font-size="16" font-weight="600">
          Steam Backlog Picker
        </text>
      </svg>`
    );

  const CATEGORY_LABELS = {
    familia: "Família",
    gratuito: "Gratuito",
    excluido: "Excluído",
  };

  const STATUS_BADGE_LABELS = {
    favorite: "Quero jogar",
    played: "Já joguei",
    hidden: "Oculto",
  };

  const state = {
    games: [],
    filteredGames: [],
    totalInSource: 0,
    statuses: loadStatuses(),
    filters: createDefaultFilters(),
    rouletteTimer: null,
    lastPickedId: null,
    currentRouletteGame: null,
  };

  const dom = {
    statsPill: document.getElementById("stats-pill"),
    collectionBadge: document.getElementById("collection-badge"),
    searchInput: document.getElementById("search-input"),
    genreSelect: document.getElementById("genre-select"),
    sortSelect: document.getElementById("sort-select"),
    statusViewSelect: document.getElementById("status-view-select"),
    categoryCheckboxes: Array.from(document.querySelectorAll(".category-checkbox")),
    hideDoneCheckbox: document.getElementById("hide-done-checkbox"),
    chips: Array.from(document.querySelectorAll(".chip")),
    maxHoursRange: document.getElementById("max-hours-range"),
    maxHoursInput: document.getElementById("max-hours-input"),
    maxHoursDisplay: document.getElementById("max-hours-display"),
    maxGbRange: document.getElementById("max-gb-range"),
    maxGbInput: document.getElementById("max-gb-input"),
    maxGbDisplay: document.getElementById("max-gb-display"),
    minRatingRange: document.getElementById("min-rating-range"),
    minRatingInput: document.getElementById("min-rating-input"),
    minRatingDisplay: document.getElementById("min-rating-display"),
    minMetacriticRange: document.getElementById("min-metacritic-range"),
    minMetacriticInput: document.getElementById("min-metacritic-input"),
    minMetacriticDisplay: document.getElementById("min-metacritic-display"),
    clearFiltersBtn: document.getElementById("clear-filters-btn"),
    emptyClearBtn: document.getElementById("empty-clear-btn"),
    emptyState: document.getElementById("empty-state"),
    emptyStateMessage: document.getElementById("empty-state-message"),
    gamesGrid: document.getElementById("games-grid"),
    exportStatusBtn: document.getElementById("export-status-btn"),
    importStatusBtn: document.getElementById("import-status-btn"),
    importFileInput: document.getElementById("import-file-input"),
    rouletteBtn: document.getElementById("roulette-btn"),
    rouletteModal: document.getElementById("roulette-modal"),
    rouletteModalCard: document.querySelector("#roulette-modal .modal-card"),
    rouletteCloseBtn: document.getElementById("roulette-close-btn"),
    rouletteRerollBtn: document.getElementById("roulette-reroll-btn"),
    rouletteCover: document.getElementById("roulette-cover"),
    rouletteCategoryBadge: document.getElementById("roulette-category-badge"),
    rouletteGameName: document.getElementById("roulette-game-name"),
    rouletteGenres: document.getElementById("roulette-genres"),
    rouletteRating: document.getElementById("roulette-rating"),
    rouletteMetacritic: document.getElementById("roulette-metacritic"),
    rouletteHours: document.getElementById("roulette-hours"),
    rouletteSize: document.getElementById("roulette-size"),
    rouletteStoreLink: document.getElementById("roulette-store-link"),
    rouletteSteamLink: document.getElementById("roulette-steam-link"),
    rouletteStatusButtons: Array.from(document.querySelectorAll("[data-roulette-status]")),
    toastContainer: document.getElementById("toast-container"),
  };

  function createDefaultFilters() {
    return {
      search: "",
      genre: "",
      sort: "rating",
      statusView: "all",
      categories: new Set(["familia", "gratuito"]),
      hideDone: true,
      chips: {
        short: false,
        light: false,
        acclaimed: false,
        hiddenGem: false,
      },
      maxHours: null,
      maxGb: null,
      minRating: 0,
      minMetacritic: 0,
    };
  }

  function loadStatuses() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const cleaned = {};
      for (const [id, st] of Object.entries(parsed)) {
        if (VALID_STATUSES.has(st)) {
          cleaned[id] = st;
        }
      }
      return cleaned;
    } catch {
      return {};
    }
  }

  function saveStatuses() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.statuses));
    } catch {
      showToast("Não foi possível salvar no localStorage.");
    }
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatCompactNumber(num) {
    if (typeof num !== "number" || !Number.isFinite(num)) return "";
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(num);
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 3200);
  }

  function toggleStatus(gameId, nextStatus) {
    if (!gameId || !VALID_STATUSES.has(nextStatus)) return;
    if (state.statuses[gameId] === nextStatus) {
      delete state.statuses[gameId];
    } else {
      state.statuses[gameId] = nextStatus;
    }
    saveStatuses();
    applyFiltersAndRender();
    if (state.currentRouletteGame && state.currentRouletteGame.id === gameId) {
      syncRouletteStatusButtons(gameId);
    }
  }

  function syncControlsFromFilters() {
    dom.searchInput.value = state.filters.search;
    dom.genreSelect.value = state.filters.genre;
    dom.sortSelect.value = state.filters.sort;
    dom.statusViewSelect.value = state.filters.statusView;
    dom.hideDoneCheckbox.checked = state.filters.hideDone;

    for (const cb of dom.categoryCheckboxes) {
      cb.checked = state.filters.categories.has(cb.value);
    }

    for (const chip of dom.chips) {
      const key = chip.dataset.chip;
      const active = Boolean(state.filters.chips[key]);
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-pressed", String(active));
    }

    if (state.filters.maxHours === null) {
      dom.maxHoursRange.value = String(MAX_HOURS_UNLIMITED);
      dom.maxHoursInput.value = "";
      dom.maxHoursDisplay.textContent = "Sem limite";
    } else {
      dom.maxHoursRange.value = String(Math.min(state.filters.maxHours, 100));
      dom.maxHoursInput.value = String(state.filters.maxHours);
      dom.maxHoursDisplay.textContent = `Até ${state.filters.maxHours}h`;
    }

    if (state.filters.maxGb === null) {
      dom.maxGbRange.value = String(MAX_GB_UNLIMITED);
      dom.maxGbInput.value = "";
      dom.maxGbDisplay.textContent = "Sem limite";
    } else {
      dom.maxGbRange.value = String(Math.min(state.filters.maxGb, 150));
      dom.maxGbInput.value = String(state.filters.maxGb);
      dom.maxGbDisplay.textContent = `Até ${state.filters.maxGb} GB`;
    }

    dom.minRatingRange.value = String(state.filters.minRating);
    dom.minRatingInput.value = String(state.filters.minRating);
    dom.minRatingDisplay.textContent =
      state.filters.minRating <= 0 ? "0% (todas)" : `${state.filters.minRating}%+`;

    dom.minMetacriticRange.value = String(state.filters.minMetacritic);
    dom.minMetacriticInput.value = String(state.filters.minMetacritic);
    dom.minMetacriticDisplay.textContent =
      state.filters.minMetacritic <= 0 ? "0 (todas)" : `${state.filters.minMetacritic}+`;
  }

  function matchesFilters(game) {
    const f = state.filters;

    if (!f.categories.has(game.category)) {
      return false;
    }

    const gameStatus = state.statuses[game.id] || null;
    if (f.statusView === "all") {
      if (f.hideDone && (gameStatus === "played" || gameStatus === "hidden")) {
        return false;
      }
    } else if (gameStatus !== f.statusView) {
      return false;
    }

    if (f.search.trim()) {
      const q = normalizeText(f.search.trim());
      const haystack = `${normalizeText(game.name)} ${normalizeText(game.steam_name)}`;
      if (!haystack.includes(q)) return false;
    }

    if (f.genre) {
      const genres = Array.isArray(game.genres) ? game.genres : [];
      if (!genres.includes(f.genre)) return false;
    }

    const hours = typeof game.main_story_hours === "number" && game.main_story_hours > 0
      ? game.main_story_hours
      : null;
    const gb = typeof game.disk_size_gb === "number" && game.disk_size_gb > 0
      ? game.disk_size_gb
      : null;
    const rating = typeof game.steam_rating_pct === "number" ? game.steam_rating_pct : null;
    const reviews = typeof game.steam_review_total === "number" ? game.steam_review_total : null;
    const mc = typeof game.metacritic_score === "number" ? game.metacritic_score : null;

    if (f.chips.short && !(hours !== null && hours < 10)) return false;
    if (f.chips.light && !(gb !== null && gb < 15)) return false;
    if (f.chips.acclaimed && !(rating !== null && rating >= 90)) return false;
    if (
      f.chips.hiddenGem &&
      !(rating !== null && rating >= 90 && reviews !== null && reviews > 0 && reviews < 5000)
    ) {
      return false;
    }

    if (f.maxHours !== null && !(hours !== null && hours <= f.maxHours)) return false;
    if (f.maxGb !== null && !(gb !== null && gb <= f.maxGb)) return false;
    if (f.minRating > 0 && !(rating !== null && rating >= f.minRating)) return false;
    if (f.minMetacritic > 0 && !(mc !== null && mc >= f.minMetacritic)) return false;

    return true;
  }

  function sortGames(list) {
    const sortKey = state.filters.sort;
    const copy = [...list];

    copy.sort((a, b) => {
      if (sortKey === "rating") {
        const ra = typeof a.steam_rating_pct === "number" ? a.steam_rating_pct : -1;
        const rb = typeof b.steam_rating_pct === "number" ? b.steam_rating_pct : -1;
        if (rb !== ra) return rb - ra;
        const rca = typeof a.steam_review_total === "number" ? a.steam_review_total : -1;
        const rcb = typeof b.steam_review_total === "number" ? b.steam_review_total : -1;
        if (rcb !== rca) return rcb - rca;
      } else if (sortKey === "metacritic") {
        const ma = typeof a.metacritic_score === "number" ? a.metacritic_score : -1;
        const mb = typeof b.metacritic_score === "number" ? b.metacritic_score : -1;
        if (mb !== ma) return mb - ma;
        const ra = typeof a.steam_rating_pct === "number" ? a.steam_rating_pct : -1;
        const rb = typeof b.steam_rating_pct === "number" ? b.steam_rating_pct : -1;
        if (rb !== ra) return rb - ra;
      } else if (sortKey === "duration") {
        const ha = typeof a.main_story_hours === "number" && a.main_story_hours > 0 ? a.main_story_hours : Infinity;
        const hb = typeof b.main_story_hours === "number" && b.main_story_hours > 0 ? b.main_story_hours : Infinity;
        if (ha !== hb) return ha - hb;
      } else if (sortKey === "size") {
        const ga = typeof a.disk_size_gb === "number" && a.disk_size_gb > 0 ? a.disk_size_gb : Infinity;
        const gb = typeof b.disk_size_gb === "number" && b.disk_size_gb > 0 ? b.disk_size_gb : Infinity;
        if (ga !== gb) return ga - gb;
      }

      return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", {
        sensitivity: "base",
      });
    });

    return copy;
  }

  function applyFiltersAndRender() {
    const filtered = sortGames(state.games.filter(matchesFilters));
    state.filteredGames = filtered;

    dom.statsPill.textContent = `Exibindo ${filtered.length} de ${state.games.length} jogos`;
    if (state.totalInSource > state.games.length) {
      dom.collectionBadge.textContent = `${state.games.length}/${state.totalInSource} coletados`;
      dom.collectionBadge.classList.remove("hidden");
    } else {
      dom.collectionBadge.classList.add("hidden");
    }

    dom.rouletteBtn.disabled = filtered.length === 0;

    if (state.games.length === 0) {
      dom.emptyStateMessage.textContent =
        "Nenhum dado carregado em data/games.json ainda. Execute fetch_games.py para coletar os jogos.";
      dom.emptyState.classList.remove("hidden");
      dom.gamesGrid.innerHTML = "";
      return;
    }

    if (filtered.length === 0) {
      dom.emptyStateMessage.textContent =
        "Nenhum jogo corresponde aos filtros atuais. Ajuste ou limpe os filtros.";
      dom.emptyState.classList.remove("hidden");
      dom.gamesGrid.innerHTML = "";
      return;
    }

    dom.emptyState.classList.add("hidden");
    renderGamesGrid(filtered);
  }

  function ratingClass(pct) {
    if (typeof pct !== "number") return "";
    if (pct >= 90) return "rating-high";
    if (pct >= 75) return "rating-mid";
    return "rating-low";
  }

  function metacriticClass(score) {
    if (typeof score !== "number") return "";
    if (score >= 75) return "mc-high";
    if (score >= 50) return "mc-mid";
    return "mc-low";
  }

  function renderGamesGrid(games) {
    const html = games
      .map((game) => {
        const status = state.statuses[game.id] || "";
        const cardClasses = ["game-card", status ? `status-${status}` : ""].filter(Boolean).join(" ");
        const coverSrc = game.header_image || FALLBACK_SVG;
        const catLabel = CATEGORY_LABELS[game.category] || game.category;
        const copiesBadge =
          game.copies && game.copies > 1
            ? `<span class="badge badge-copies">${game.copies}x</span>`
            : "";
        const statusBadge = status
          ? `<span class="badge badge-status-${status}">${escapeHtml(STATUS_BADGE_LABELS[status])}</span>`
          : "";

        const ratingText =
          typeof game.steam_rating_pct === "number" ? `${game.steam_rating_pct}%` : "Sem nota";
        const reviewsText =
          typeof game.steam_review_total === "number" && game.steam_review_total > 0
            ? `${formatCompactNumber(game.steam_review_total)} rev.`
            : "—";

        const hoursText =
          typeof game.main_story_hours === "number" && game.main_story_hours > 0
            ? `${game.main_story_hours}h`
            : "— h";
        const extraHoursText =
          typeof game.main_extra_hours === "number" && game.main_extra_hours > 0
            ? `M+E ${game.main_extra_hours}h`
            : "Principal";

        const sizeText =
          typeof game.disk_size_gb === "number" && game.disk_size_gb > 0
            ? `${game.disk_size_gb} GB`
            : "— GB";

        const hasMc = typeof game.metacritic_score === "number";
        const mcValueHtml = hasMc
          ? (game.metacritic_url
              ? `<a class="metric-link" href="${escapeHtml(game.metacritic_url)}" target="_blank" rel="noopener noreferrer" title="Ver no Metacritic">${game.metacritic_score}</a>`
              : `${game.metacritic_score}`)
          : "—";

        const genres = Array.isArray(game.genres) ? game.genres.slice(0, 3) : [];
        const genresHtml = genres.length
          ? genres.map((g) => `<span class="genre-tag">${escapeHtml(g)}</span>`).join("")
          : `<span class="genre-tag">Sem gênero</span>`;

        const steamLinkHtml = game.steam_uri
          ? `<a class="link-btn" href="${escapeHtml(game.steam_uri)}" title="Abrir no cliente Steam">Steam</a>`
          : "";
        const storeLinkHtml = game.store_url
          ? `<a class="link-btn" href="${escapeHtml(game.store_url)}" target="_blank" rel="noopener noreferrer" title="Abrir página da loja">Loja</a>`
          : "";

        return `
          <article class="${cardClasses}" data-game-id="${escapeHtml(game.id)}">
            <div class="card-cover-wrap">
              <img class="card-cover" src="${escapeHtml(coverSrc)}" alt="${escapeHtml(game.name)}" loading="lazy" />
              <div class="card-badges-left">
                <span class="badge badge-${escapeHtml(game.category)}">${escapeHtml(catLabel)}</span>
                ${copiesBadge}
              </div>
              <div class="card-badges-right">${statusBadge}</div>
            </div>

            <div class="card-body">
              <h2 class="card-title">${escapeHtml(game.name)}</h2>

              <div class="card-metrics">
                <div class="metric">
                  <span class="metric-title">Steam</span>
                  <span class="metric-val ${ratingClass(game.steam_rating_pct)}">${escapeHtml(ratingText)}</span>
                  <span class="metric-sub">${escapeHtml(reviewsText)}</span>
                </div>
                <div class="metric">
                  <span class="metric-title">Meta</span>
                  <span class="metric-val ${metacriticClass(game.metacritic_score)}">${mcValueHtml}</span>
                  <span class="metric-sub">Crítica</span>
                </div>
                <div class="metric">
                  <span class="metric-title">Duração</span>
                  <span class="metric-val">${escapeHtml(hoursText)}</span>
                  <span class="metric-sub">${escapeHtml(extraHoursText)}</span>
                </div>
                <div class="metric">
                  <span class="metric-title">Disco</span>
                  <span class="metric-val">${escapeHtml(sizeText)}</span>
                  <span class="metric-sub">Estimado</span>
                </div>
              </div>

              <div class="card-genres">${genresHtml}</div>
            </div>

            <div class="card-footer">
              <div class="status-actions">
                <button type="button" class="status-btn ${status === "favorite" ? "active" : ""}" data-status="favorite">
                  Quero jogar
                </button>
                <button type="button" class="status-btn ${status === "played" ? "active" : ""}" data-status="played">
                  Já joguei
                </button>
                <button type="button" class="status-btn ${status === "hidden" ? "active" : ""}" data-status="hidden">
                  Ocultar
                </button>
              </div>
              <div class="card-links">
                ${steamLinkHtml}
                ${storeLinkHtml}
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    dom.gamesGrid.innerHTML = html;

    // Attach safe fallback for broken cover images
    for (const img of dom.gamesGrid.querySelectorAll("img.card-cover")) {
      img.addEventListener(
        "error",
        () => {
          if (img.src !== FALLBACK_SVG) img.src = FALLBACK_SVG;
        },
        { once: true }
      );
    }
  }

  function populateGenres(genres) {
    const prev = state.filters.genre;
    const options = [`<option value="">Todos os gêneros</option>`];
    for (const genre of genres) {
      options.push(`<option value="${escapeHtml(genre)}">${escapeHtml(genre)}</option>`);
    }
    dom.genreSelect.innerHTML = options.join("");
    if (genres.includes(prev)) {
      dom.genreSelect.value = prev;
    } else {
      state.filters.genre = "";
    }
  }

  function syncRouletteStatusButtons(gameId) {
    const activeStatus = state.statuses[gameId] || null;
    for (const btn of dom.rouletteStatusButtons) {
      btn.classList.toggle("active", btn.dataset.rouletteStatus === activeStatus);
    }
  }

  function renderRouletteGame(game) {
    state.currentRouletteGame = game;
    dom.rouletteCover.src = game.header_image || FALLBACK_SVG;
    dom.rouletteCover.alt = game.name;

    const catLabel = CATEGORY_LABELS[game.category] || game.category;
    dom.rouletteCategoryBadge.className = `badge badge-${game.category}`;
    dom.rouletteCategoryBadge.textContent =
      game.copies && game.copies > 1 ? `${catLabel} • ${game.copies}x` : catLabel;

    dom.rouletteGameName.textContent = game.name;
    dom.rouletteGenres.textContent =
      Array.isArray(game.genres) && game.genres.length ? game.genres.join(" • ") : "Sem gêneros listados";

    dom.rouletteRating.textContent =
      typeof game.steam_rating_pct === "number"
        ? `${game.steam_rating_pct}% (${formatCompactNumber(game.steam_review_total || 0)})`
        : "Sem nota";

    if (typeof game.metacritic_score === "number") {
      dom.rouletteMetacritic.textContent = `${game.metacritic_score} / 100`;
      dom.rouletteMetacritic.className = metacriticClass(game.metacritic_score);
    } else {
      dom.rouletteMetacritic.textContent = "Sem nota";
      dom.rouletteMetacritic.className = "";
    }

    if (typeof game.main_story_hours === "number" && game.main_story_hours > 0) {
      const extra =
        typeof game.main_extra_hours === "number" && game.main_extra_hours > 0
          ? ` / M+E ${game.main_extra_hours}h`
          : "";
      dom.rouletteHours.textContent = `${game.main_story_hours}h${extra}`;
    } else {
      dom.rouletteHours.textContent = "Não informado";
    }

    dom.rouletteSize.textContent =
      typeof game.disk_size_gb === "number" && game.disk_size_gb > 0
        ? `${game.disk_size_gb} GB`
        : "Não informado";

    if (game.store_url) {
      dom.rouletteStoreLink.href = game.store_url;
      dom.rouletteStoreLink.classList.remove("hidden");
    } else {
      dom.rouletteStoreLink.classList.add("hidden");
    }

    if (game.steam_uri) {
      dom.rouletteSteamLink.href = game.steam_uri;
      dom.rouletteSteamLink.classList.remove("hidden");
    } else {
      dom.rouletteSteamLink.classList.add("hidden");
    }

    syncRouletteStatusButtons(game.id);
  }

  function stopRouletteTimer() {
    if (state.rouletteTimer !== null) {
      window.clearTimeout(state.rouletteTimer);
      state.rouletteTimer = null;
    }
  }

  function spinRoulette() {
    const pool = state.filteredGames;
    if (!pool.length) {
      showToast("Nenhum jogo disponível nos filtros atuais para sortear.");
      return;
    }

    stopRouletteTimer();
    dom.rouletteModal.classList.remove("hidden");
    dom.rouletteModalCard.classList.remove("winner");
    dom.rouletteModalCard.classList.add("spinning");
    dom.rouletteRerollBtn.disabled = true;

    let candidates = pool;
    if (pool.length > 1 && state.lastPickedId) {
      candidates = pool.filter((g) => g.id !== state.lastPickedId);
    }
    const winner = candidates[Math.floor(Math.random() * candidates.length)];
    state.lastPickedId = winner.id;

    const totalSteps = pool.length > 1 ? 12 : 1;
    let step = 0;

    function tick() {
      if (step < totalSteps - 1) {
        const preview = pool[Math.floor(Math.random() * pool.length)];
        renderRouletteGame(preview);
        step += 1;
        const delayMs = 45 + step * 14;
        state.rouletteTimer = window.setTimeout(tick, delayMs);
      } else {
        renderRouletteGame(winner);
        dom.rouletteModalCard.classList.remove("spinning");
        dom.rouletteModalCard.classList.add("winner");
        dom.rouletteRerollBtn.disabled = false;
        state.rouletteTimer = null;
      }
    }

    tick();
  }

  function closeRouletteModal() {
    stopRouletteTimer();
    dom.rouletteModal.classList.add("hidden");
    dom.rouletteModalCard.classList.remove("spinning", "winner");
    dom.rouletteRerollBtn.disabled = false;
  }

  function exportStatuses() {
    const payload = {
      version: 1,
      exported_at: new Date().toISOString(),
      statuses: state.statuses,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "steam-backlog-status.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Status exportados em JSON.");
  }

  async function importStatusesFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const sourceMap =
        parsed && typeof parsed === "object" && parsed.statuses && typeof parsed.statuses === "object"
          ? parsed.statuses
          : parsed;

      if (!sourceMap || typeof sourceMap !== "object" || Array.isArray(sourceMap)) {
        showToast("Arquivo JSON inválido.");
        return;
      }

      const nextStatuses = { ...state.statuses };
      let importedCount = 0;
      for (const [id, st] of Object.entries(sourceMap)) {
        if (VALID_STATUSES.has(st)) {
          nextStatuses[id] = st;
          importedCount += 1;
        }
      }

      state.statuses = nextStatuses;
      saveStatuses();
      applyFiltersAndRender();
      showToast(`${importedCount} marcação(ões) importada(s).`);
    } catch {
      showToast("Erro ao ler o arquivo JSON.");
    } finally {
      dom.importFileInput.value = "";
    }
  }

  function debounce(fn, delayMs = 80) {
    let timerId = null;
    return (...args) => {
      if (timerId !== null) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        timerId = null;
        fn(...args);
      }, delayMs);
    };
  }

  function bindEvents() {
    const debouncedRender = debounce(applyFiltersAndRender, 80);

    dom.searchInput.addEventListener("input", () => {
      state.filters.search = dom.searchInput.value;
      debouncedRender();
    });

    dom.genreSelect.addEventListener("change", () => {
      state.filters.genre = dom.genreSelect.value;
      applyFiltersAndRender();
    });

    dom.sortSelect.addEventListener("change", () => {
      state.filters.sort = dom.sortSelect.value;
      applyFiltersAndRender();
    });

    dom.statusViewSelect.addEventListener("change", () => {
      state.filters.statusView = dom.statusViewSelect.value;
      applyFiltersAndRender();
    });

    for (const cb of dom.categoryCheckboxes) {
      cb.addEventListener("change", () => {
        if (cb.checked) {
          state.filters.categories.add(cb.value);
        } else {
          state.filters.categories.delete(cb.value);
        }
        applyFiltersAndRender();
      });
    }

    dom.hideDoneCheckbox.addEventListener("change", () => {
      state.filters.hideDone = dom.hideDoneCheckbox.checked;
      applyFiltersAndRender();
    });

    for (const chip of dom.chips) {
      chip.addEventListener("click", () => {
        const key = chip.dataset.chip;
        const next = !state.filters.chips[key];
        state.filters.chips[key] = next;
        chip.classList.toggle("active", next);
        chip.setAttribute("aria-pressed", String(next));
        applyFiltersAndRender();
      });
    }

    dom.maxHoursRange.addEventListener("input", () => {
      const val = Number(dom.maxHoursRange.value);
      state.filters.maxHours = val >= MAX_HOURS_UNLIMITED ? null : val;
      syncControlsFromFilters();
      debouncedRender();
    });

    dom.maxHoursInput.addEventListener("input", () => {
      const raw = dom.maxHoursInput.value.trim();
      if (!raw) {
        state.filters.maxHours = null;
      } else {
        const num = Math.max(1, Math.min(500, Math.round(Number(raw))));
        state.filters.maxHours = Number.isFinite(num) ? num : null;
      }
      if (state.filters.maxHours === null) {
        dom.maxHoursRange.value = String(MAX_HOURS_UNLIMITED);
        dom.maxHoursDisplay.textContent = "Sem limite";
      } else {
        dom.maxHoursRange.value = String(Math.min(state.filters.maxHours, 100));
        dom.maxHoursDisplay.textContent = `Até ${state.filters.maxHours}h`;
      }
      debouncedRender();
    });

    dom.maxGbRange.addEventListener("input", () => {
      const val = Number(dom.maxGbRange.value);
      state.filters.maxGb = val >= MAX_GB_UNLIMITED ? null : val;
      syncControlsFromFilters();
      debouncedRender();
    });

    dom.maxGbInput.addEventListener("input", () => {
      const raw = dom.maxGbInput.value.trim();
      if (!raw) {
        state.filters.maxGb = null;
      } else {
        const num = Math.max(1, Math.min(500, Math.round(Number(raw))));
        state.filters.maxGb = Number.isFinite(num) ? num : null;
      }
      if (state.filters.maxGb === null) {
        dom.maxGbRange.value = String(MAX_GB_UNLIMITED);
        dom.maxGbDisplay.textContent = "Sem limite";
      } else {
        dom.maxGbRange.value = String(Math.min(state.filters.maxGb, 150));
        dom.maxGbDisplay.textContent = `Até ${state.filters.maxGb} GB`;
      }
      debouncedRender();
    });

    dom.minRatingRange.addEventListener("input", () => {
      state.filters.minRating = Number(dom.minRatingRange.value) || 0;
      syncControlsFromFilters();
      debouncedRender();
    });

    dom.minRatingInput.addEventListener("input", () => {
      const num = Math.max(0, Math.min(100, Math.round(Number(dom.minRatingInput.value) || 0)));
      state.filters.minRating = num;
      dom.minRatingRange.value = String(num);
      dom.minRatingDisplay.textContent = num <= 0 ? "0% (todas)" : `${num}%+`;
      debouncedRender();
    });

    dom.minMetacriticRange.addEventListener("input", () => {
      state.filters.minMetacritic = Number(dom.minMetacriticRange.value) || 0;
      syncControlsFromFilters();
      debouncedRender();
    });

    dom.minMetacriticInput.addEventListener("input", () => {
      const num = Math.max(0, Math.min(100, Math.round(Number(dom.minMetacriticInput.value) || 0)));
      state.filters.minMetacritic = num;
      dom.minMetacriticRange.value = String(num);
      dom.minMetacriticDisplay.textContent = num <= 0 ? "0 (todas)" : `${num}+`;
      debouncedRender();
    });

    const resetAllFilters = () => {
      state.filters = createDefaultFilters();
      syncControlsFromFilters();
      applyFiltersAndRender();
    };
    dom.clearFiltersBtn.addEventListener("click", resetAllFilters);
    dom.emptyClearBtn.addEventListener("click", resetAllFilters);

    dom.gamesGrid.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-status]");
      if (!btn) return;
      const card = btn.closest(".game-card");
      if (!card) return;
      toggleStatus(card.dataset.gameId, btn.dataset.status);
    });

    dom.exportStatusBtn.addEventListener("click", exportStatuses);
    dom.importStatusBtn.addEventListener("click", () => dom.importFileInput.click());
    dom.importFileInput.addEventListener("change", () => {
      const file = dom.importFileInput.files && dom.importFileInput.files[0];
      importStatusesFile(file);
    });

    dom.rouletteBtn.addEventListener("click", spinRoulette);
    dom.rouletteRerollBtn.addEventListener("click", spinRoulette);
    dom.rouletteCloseBtn.addEventListener("click", closeRouletteModal);

    dom.rouletteModal.addEventListener("click", (event) => {
      if (event.target === dom.rouletteModal) {
        closeRouletteModal();
      }
    });

    dom.rouletteCover.addEventListener("error", () => {
      if (dom.rouletteCover.src !== FALLBACK_SVG) {
        dom.rouletteCover.src = FALLBACK_SVG;
      }
    });

    for (const btn of dom.rouletteStatusButtons) {
      btn.addEventListener("click", () => {
        if (!state.currentRouletteGame) return;
        toggleStatus(state.currentRouletteGame.id, btn.dataset.rouletteStatus);
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !dom.rouletteModal.classList.contains("hidden")) {
        closeRouletteModal();
      }
    });
  }

  function computeAvailableGenres(games) {
    const genres = new Set();
    for (const game of games) {
      if (!game || !Array.isArray(game.genres)) continue;
      for (const genre of game.genres) {
        if (typeof genre === "string" && genre.trim()) {
          genres.add(genre.trim());
        }
      }
    }
    return Array.from(genres).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
  }

  async function loadGamesPayload() {
    const isLocalHost =
      window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

    if (isLocalHost) {
      try {
        const apiResp = await fetch("./api/games", { cache: "no-store" });
        if (apiResp.ok) {
          return await apiResp.json();
        }
      } catch {
        // Fall back to static ./data/games.json below
      }
    }

    const staticResp = await fetch("./data/games.json", { cache: "no-store" });
    if (!staticResp.ok) {
      throw new Error(`HTTP ${staticResp.status}`);
    }
    return await staticResp.json();
  }

  async function init() {
    syncControlsFromFilters();
    bindEvents();
    try {
      const data = await loadGamesPayload();
      state.games = Array.isArray(data.games) ? data.games : [];
      state.totalInSource = Number(data.total_in_source) || state.games.length;
      const genres =
        Array.isArray(data.available_genres) && data.available_genres.length
          ? data.available_genres
          : computeAvailableGenres(state.games);
      populateGenres(genres);
      applyFiltersAndRender();
    } catch {
      dom.statsPill.textContent = "Erro ao carregar dados";
      dom.emptyStateMessage.textContent = "Falha ao carregar os dados dos jogos.";
      dom.emptyState.classList.remove("hidden");
    }
  }

  init();
})();
