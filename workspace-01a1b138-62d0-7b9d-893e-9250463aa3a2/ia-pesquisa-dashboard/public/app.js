(function () {
  'use strict';

  const SCHEMA = window.FORM_SCHEMA;
  const DEMO_DATA = window.DEMO_RESPONSES || [];
  const LOCAL_STORAGE_KEY = 'ia_pesquisa_real_responses_v1';

  const state = {
    realResponses: [],
    datasetMode: 'real', // 'real' | 'demo'
    activeView: 'dashboard', // 'dashboard' | 'table' | 'form'
    globalChartMode: 'bars', // 'bars' | 'donut' | 'byGrade'
    cardChartModes: {},
    filters: {
      q1: '',
      q2: '',
      q3: '',
      q4: '',
      q5: '',
      q6: '',
      q7: '',
      q8: '',
    },
    tableSearch: '',
    tableSort: 'newest',
    selectedDetailId: null,
    backendOnline: false,
  };

  // ==========================================
  // HELPERS & FORMATTERS
  // ==========================================
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtPct(value) {
    if (!Number.isFinite(value)) return '0,0%';
    return value.toLocaleString('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) + '%';
  }

  function fmtDateTime(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3400);
  }

  function getOptionMeta(qKey, optValue) {
    const q = SCHEMA.questions.find((item) => item.key === qKey);
    if (!q) return { color: '#64748B', tone: 'slate' };
    const found = q.options.find((o) => o.value === optValue);
    return found || { color: '#64748B', tone: 'slate' };
  }

  function getActiveDataset() {
    return state.datasetMode === 'demo' ? DEMO_DATA : state.realResponses;
  }

  function getFilteredResponses() {
    const base = getActiveDataset();
    return base.filter((resp) => {
      const ans = resp.answers || {};
      for (const q of SCHEMA.questions) {
        const fVal = state.filters[q.key];
        if (fVal) {
          const arr = Array.isArray(ans[q.key]) ? ans[q.key] : [];
          if (!arr.includes(fVal)) return false;
        }
      }
      return true;
    });
  }

  function hasAns(resp, qKey, values) {
    const arr = resp?.answers?.[qKey] || [];
    return values.some((v) => arr.includes(v));
  }

  // ==========================================
  // BACKEND SYNC + SSE + LOCAL FALLBACK
  // ==========================================
  function setLiveStatus(mode, label) {
    const badge = document.getElementById('liveStatusBadge');
    const text = document.getElementById('liveStatusText');
    if (!badge || !text) return;
    badge.classList.remove('is-connecting', 'is-local');
    if (mode === 'connecting') badge.classList.add('is-connecting');
    if (mode === 'local') badge.classList.add('is-local');
    text.textContent = label;
  }

  function saveLocalFallback(list) {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
    } catch (_) {
      // ignore storage quota errors
    }
  }

  function loadLocalFallback() {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  async function loadInitialResponses() {
    try {
      const res = await fetch('/api/responses', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.realResponses = Array.isArray(data.responses) ? data.responses : [];
      state.backendOnline = true;
      saveLocalFallback(state.realResponses);
      setLiveStatus('online', 'Tempo Real Ativo');
      connectSSE();
    } catch (_) {
      state.backendOnline = false;
      state.realResponses = loadLocalFallback();
      setLiveStatus('local', 'Modo Local');
    }
    renderAll();
  }

  function connectSSE() {
    if (typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource('/api/stream');
      es.addEventListener('connected', () => {
        setLiveStatus('online', 'Tempo Real Ativo');
      });
      es.addEventListener('responses_updated', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (Array.isArray(payload.responses)) {
            const prevLen = state.realResponses.length;
            state.realResponses = payload.responses;
            saveLocalFallback(state.realResponses);
            if (payload.responses.length > prevLen && state.datasetMode === 'demo') {
              // Keep user aware if a real answer arrived while viewing simulation
              showToast('Nova resposta real recebida!');
            }
            renderAll();
          }
        } catch (_) {
          // ignore malformed SSE message
        }
      });
      es.onerror = () => {
        setLiveStatus('connecting', 'Reconectando...');
      };
    } catch (_) {
      // ignore SSE errors
    }
  }

  // ==========================================
  // VIEW & NAVIGATION ROUTING
  // ==========================================
  function switchView(viewName, updateHash = true) {
    if (!['dashboard', 'table', 'form'].includes(viewName)) {
      viewName = 'dashboard';
    }
    state.activeView = viewName;

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const isMatch = btn.dataset.view === viewName;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    document.getElementById('viewDashboard').classList.toggle('hidden', viewName !== 'dashboard');
    document.getElementById('viewTable').classList.toggle('hidden', viewName !== 'table');
    document.getElementById('viewForm').classList.toggle('hidden', viewName !== 'form');

    if (updateHash) {
      const hashMap = { dashboard: '#dashboard', table: '#respostas', form: '#responder' };
      try {
        history.replaceState(null, '', hashMap[viewName]);
      } catch (_) {
        // sandboxed iframe may restrict history
      }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    renderAll();
  }

  function applyHashRoute() {
    const h = (window.location.hash || '').toLowerCase();
    if (h === '#responder' || h === '#form') {
      switchView('form', false);
    } else if (h === '#respostas' || h === '#tabela') {
      switchView('table', false);
    } else {
      switchView('dashboard', false);
    }
  }

  // ==========================================
  // FILTER CONTROLS
  // ==========================================
  function populateFilterSelects() {
    const selectIds = [
      { id: 'filterQ1', key: 'q1', placeholder: 'Todas as séries' },
      { id: 'filterQ2', key: 'q2', placeholder: 'Todos os perfis' },
      { id: 'filterQ3', key: 'q3', placeholder: 'Todas as finalidades' },
      { id: 'filterQ4', key: 'q4', placeholder: 'Todas as posturas' },
      { id: 'filterQ6', key: 'q6', placeholder: 'Todos os níveis' },
    ];

    for (const item of selectIds) {
      const sel = document.getElementById(item.id);
      const q = SCHEMA.questions.find((x) => x.key === item.key);
      if (!sel || !q) continue;
      sel.innerHTML =
        `<option value="">${escapeHtml(item.placeholder)}</option>` +
        q.options
          .map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.value)}</option>`)
          .join('');
      sel.addEventListener('change', () => {
        state.filters[item.key] = sel.value;
        renderAll();
      });
    }
  }

  function toggleChartFilter(qKey, optValue) {
    if (state.filters[qKey] === optValue) {
      state.filters[qKey] = '';
    } else {
      state.filters[qKey] = optValue;
    }
    syncSelectDropdowns();
    renderAll();
  }

  function clearAllFilters() {
    for (const k of Object.keys(state.filters)) {
      state.filters[k] = '';
    }
    syncSelectDropdowns();
    renderAll();
  }

  function syncSelectDropdowns() {
    document.querySelectorAll('select[data-filter-q]').forEach((sel) => {
      const k = sel.dataset.filterQ;
      sel.value = state.filters[k] || '';
    });
  }

  function renderActiveFilterChips() {
    const row = document.getElementById('activeFiltersRow');
    const chipsWrap = document.getElementById('activeFilterChips');
    const entries = Object.entries(state.filters).filter(([, val]) => Boolean(val));

    if (entries.length === 0) {
      row.classList.add('hidden');
      chipsWrap.innerHTML = '';
      return;
    }

    row.classList.remove('hidden');
    chipsWrap.innerHTML = entries
      .map(([qKey, val]) => {
        const q = SCHEMA.questions.find((x) => x.key === qKey);
        const label = q ? `P${q.number} (${q.shortLabel})` : qKey.toUpperCase();
        return `
          <span class="filter-chip">
            <span>${escapeHtml(label)}: <strong>${escapeHtml(val)}</strong></span>
            <button type="button" data-remove-filter="${escapeHtml(qKey)}" title="Remover filtro">✕</button>
          </span>
        `;
      })
      .join('');

    chipsWrap.querySelectorAll('button[data-remove-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.removeFilter;
        state.filters[k] = '';
        syncSelectDropdowns();
        renderAll();
      });
    });
  }

  // ==========================================
  // KPI CARDS RENDERING
  // ==========================================
  function renderKPIs(filtered, allDataset) {
    const total = filtered.length;
    const totalAll = allDataset.length;

    // Série breakdown
    const g1 = filtered.filter((r) => hasAns(r, 'q1', ['1 Ano'])).length;
    const g2 = filtered.filter((r) => hasAns(r, 'q1', ['2 Ano'])).length;
    const g3 = filtered.filter((r) => hasAns(r, 'q1', ['3 Ano'])).length;
    const gO = filtered.filter((r) => hasAns(r, 'q1', ['Outro'])).length;

    // Q2: Uso de IA na escola
    const aiUsers = filtered.filter((r) => hasAns(r, 'q2', ['Sim', 'Frequentemente', 'Depende'])).length;
    const aiFreq = filtered.filter((r) => hasAns(r, 'q2', ['Frequentemente'])).length;
    const aiUsersPct = total > 0 ? (aiUsers / total) * 100 : 0;

    // Q4: Postura ativa ("Penso antes") vs passiva ("Peço para a IA responder")
    const thinkFirst = filtered.filter((r) => hasAns(r, 'q4', ['Penso antes'])).length;
    const askDirect = filtered.filter((r) => hasAns(r, 'q4', ['Peço para a IA responder'])).length;
    const thinkFirstPct = total > 0 ? (thinkFirst / total) * 100 : 0;
    const askDirectPct = total > 0 ? (askDirect / total) * 100 : 0;

    // Q5 & Q7: Compreensão e explicação com próprias palavras
    const understandYes = filtered.filter((r) => hasAns(r, 'q5', ['Sim'])).length;
    const explainOwnYes = filtered.filter((r) => hasAns(r, 'q7', ['Sim'])).length;
    const understandPct = total > 0 ? (understandYes / total) * 100 : 0;
    const explainPct = total > 0 ? (explainOwnYes / total) * 100 : 0;

    // Q6 & Q8: Dificuldade sem IA (Hipótese central) e autonomia
    const diffWithoutAi = filtered.filter((r) => hasAns(r, 'q6', ['Sim', 'Às vezes'])).length;
    const diffStrictYes = filtered.filter((r) => hasAns(r, 'q6', ['Sim'])).length;
    const diffPct = total > 0 ? (diffWithoutAi / total) * 100 : 0;
    const improvedIndep = filtered.filter((r) => hasAns(r, 'q8', ['Sim'])).length;
    const improvedPct = total > 0 ? (improvedIndep / total) * 100 : 0;

    const kpiGrid = document.getElementById('kpiGrid');
    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Total de Participantes</span>
          <span class="kpi-tag tone-indigo">${state.datasetMode === 'demo' ? 'Simulação' : 'Real'}</span>
        </div>
        <div class="kpi-value-row">
          <span class="kpi-value">${total}</span>
          <span class="kpi-subcount">de ${totalAll}</span>
        </div>
        <div class="kpi-foot">
          1º: <strong>${g1}</strong> • 2º: <strong>${g2}</strong> • 3º: <strong>${g3}</strong>${gO ? ` • Outro: <strong>${gO}</strong>` : ''}
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Utilizam IA na Escola (P2)</span>
          <span class="kpi-tag tone-sky">${aiUsers}/${total}</span>
        </div>
        <div class="kpi-value-row">
          <span class="kpi-value">${fmtPct(aiUsersPct)}</span>
        </div>
        <div class="kpi-foot">
          Uso frequente: <strong>${aiFreq}</strong> (${fmtPct(total > 0 ? (aiFreq / total) * 100 : 0)})
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Pensam Antes da IA (P4)</span>
          <span class="kpi-tag tone-emerald">${thinkFirst}/${total}</span>
        </div>
        <div class="kpi-value-row">
          <span class="kpi-value">${fmtPct(thinkFirstPct)}</span>
        </div>
        <div class="kpi-foot">
          Pedem direto à IA: <strong>${fmtPct(askDirectPct)}</strong> (${askDirect})
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Explicam c/ Próprias Palavras (P7)</span>
          <span class="kpi-tag tone-emerald">${explainOwnYes}/${total}</span>
        </div>
        <div class="kpi-value-row">
          <span class="kpi-value">${fmtPct(explainPct)}</span>
        </div>
        <div class="kpi-foot">
          Procuram entender na P5 (Sim): <strong>${fmtPct(understandPct)}</strong>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Dificuldade Sem IA (P6)</span>
          <span class="kpi-tag tone-rose">${diffWithoutAi}/${total}</span>
        </div>
        <div class="kpi-value-row">
          <span class="kpi-value">${fmtPct(diffPct)}</span>
        </div>
        <div class="kpi-foot">
          Sim: <strong>${diffStrictYes}</strong> • Melhorou autonomia (P8): <strong>${fmtPct(improvedPct)}</strong>
        </div>
      </div>
    `;
  }

  // ==========================================
  // 8 INTERACTIVE QUESTION CHARTS
  // ==========================================
  function computeQuestionStats(q, filtered) {
    const totalResp = filtered.length;
    let answeredResp = 0;
    let totalMarks = 0;

    const counts = q.options.map((opt) => ({
      ...opt,
      count: 0,
      pctResp: 0,
      pctMarks: 0,
    }));

    for (const r of filtered) {
      const arr = r.answers?.[q.key] || [];
      if (arr.length > 0) answeredResp += 1;
      for (const item of counts) {
        if (arr.includes(item.value)) {
          item.count += 1;
          totalMarks += 1;
        }
      }
    }

    for (const item of counts) {
      item.pctResp = totalResp > 0 ? (item.count / totalResp) * 100 : 0;
      item.pctMarks = totalMarks > 0 ? (item.count / totalMarks) * 100 : 0;
    }

    let leader = null;
    for (const item of counts) {
      if (item.count > 0 && (!leader || item.count > leader.count)) {
        leader = item;
      }
    }

    return { totalResp, answeredResp, totalMarks, counts, leader };
  }

  function renderBarsChart(q, stats) {
    const selectedVal = state.filters[q.key];
    return `
      <div class="bar-list">
        ${stats.counts
          .map((item) => {
            const isSel = selectedVal === item.value;
            const widthPct = Math.min(100, Math.max(0, item.pctResp));
            return `
              <div class="bar-row ${isSel ? 'is-selected' : ''}" data-q="${escapeHtml(q.key)}" data-opt="${escapeHtml(item.value)}" title="Clique para filtrar por: ${escapeHtml(item.value)}">
                <div class="bar-row-header">
                  <span class="bar-label">
                    <span class="bar-dot" style="background:${item.color}"></span>
                    <span>${escapeHtml(item.value)}</span>
                  </span>
                  <span class="bar-stats">
                    <span class="bar-count">${item.count}</span>
                    <span class="bar-pct">${fmtPct(item.pctResp)}</span>
                  </span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill" style="width:${widthPct.toFixed(1)}%; background:${item.color}"></div>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  function renderDonutChart(q, stats) {
    const r = 52;
    const circumference = 2 * Math.PI * r;
    let offsetAcc = 0;
    const selectedVal = state.filters[q.key];

    let circlesSvg = '';
    if (stats.totalMarks === 0) {
      circlesSvg = `<circle cx="74" cy="74" r="${r}" fill="none" stroke="var(--bg-subtle)" stroke-width="20" />`;
    } else {
      circlesSvg =
        `<circle cx="74" cy="74" r="${r}" fill="none" stroke="var(--bg-subtle)" stroke-width="20" />` +
        `<g transform="rotate(-90 74 74)">` +
        stats.counts
          .filter((item) => item.count > 0)
          .map((item) => {
            const frac = item.count / stats.totalMarks;
            const segLen = frac * circumference;
            const dashArray = `${segLen} ${circumference}`;
            const dashOffset = -offsetAcc;
            offsetAcc += segLen;
            return `
              <circle
                class="donut-slice"
                cx="74"
                cy="74"
                r="${r}"
                fill="none"
                stroke="${item.color}"
                stroke-width="20"
                stroke-dasharray="${dashArray}"
                stroke-dashoffset="${dashOffset}"
                data-q="${escapeHtml(q.key)}"
                data-opt="${escapeHtml(item.value)}"
              >
                <title>${escapeHtml(item.value)}: ${item.count} (${fmtPct(item.pctResp)})</title>
              </circle>
            `;
          })
          .join('') +
        `</g>`;
    }

    const legendHtml = stats.counts
      .map((item) => {
        const isSel = selectedVal === item.value;
        return `
          <div class="donut-legend-item ${isSel ? 'is-selected' : ''}" data-q="${escapeHtml(q.key)}" data-opt="${escapeHtml(item.value)}">
            <span class="donut-legend-left">
              <span class="bar-dot" style="background:${item.color}"></span>
              <span>${escapeHtml(item.value)}</span>
            </span>
            <span class="donut-legend-right">${item.count} (${fmtPct(item.pctResp)})</span>
          </div>
        `;
      })
      .join('');

    return `
      <div class="donut-layout">
        <div class="donut-svg-wrap">
          <svg width="148" height="148" viewBox="0 0 148 148" aria-label="${escapeHtml(q.title)}">
            ${circlesSvg}
          </svg>
          <div class="donut-center-label">
            <span class="donut-center-num">${stats.answeredResp}</span>
            <span class="donut-center-sub">respostas</span>
          </div>
        </div>
        <div class="donut-legend">
          ${legendHtml}
        </div>
      </div>
    `;
  }

  function renderByGradeChart(q, filtered) {
    const grades = ['1 Ano', '2 Ano', '3 Ano', 'Outro'];
    const legendHtml = q.options
      .map(
        (opt) => `
          <span class="grade-legend-chip">
            <span class="bar-dot" style="background:${opt.color}"></span>
            <span>${escapeHtml(opt.value)}</span>
          </span>
        `
      )
      .join('');

    const rowsHtml = grades
      .map((grade) => {
        const gradeResps = filtered.filter((r) => (r.answers?.q1 || []).includes(grade));
        let totalMarksInGrade = 0;
        const optCounts = q.options.map((opt) => {
          const c = gradeResps.filter((r) => (r.answers?.[q.key] || []).includes(opt.value)).length;
          totalMarksInGrade += c;
          return { ...opt, count: c };
        });

        const segs =
          totalMarksInGrade === 0
            ? ''
            : optCounts
                .filter((o) => o.count > 0)
                .map((o) => {
                  const pct = (o.count / totalMarksInGrade) * 100;
                  return `<div class="grade-stack-seg" style="width:${pct.toFixed(1)}%; background:${o.color}" data-q="${escapeHtml(q.key)}" data-opt="${escapeHtml(o.value)}" title="${escapeHtml(grade)} — ${escapeHtml(o.value)}: ${o.count} (${fmtPct(pct)})"></div>`;
                })
                .join('');

        return `
          <div class="grade-row">
            <div class="grade-row-top">
              <span>${escapeHtml(grade)}</span>
              <span>${gradeResps.length} part.</span>
            </div>
            <div class="grade-stack-track">${segs}</div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="grade-compare-wrap">
        <div class="grade-legend-strip">${legendHtml}</div>
        ${rowsHtml}
      </div>
    `;
  }

  function renderQuestionsGrid(filtered) {
    const grid = document.getElementById('questionsGrid');
    const summaryPill = document.getElementById('filteredSummaryLabel');
    const activeTotal = getActiveDataset().length;
    summaryPill.textContent =
      filtered.length === activeTotal
        ? `Exibindo todas as ${filtered.length} respostas`
        : `Exibindo ${filtered.length} de ${activeTotal} respostas (filtrado)`;

    grid.innerHTML = SCHEMA.questions
      .map((q) => {
        const stats = computeQuestionStats(q, filtered);
        const mode = state.cardChartModes[q.key] || state.globalChartMode;

        let chartBody = '';
        if (mode === 'donut') {
          chartBody = renderDonutChart(q, stats);
        } else if (mode === 'byGrade') {
          chartBody = renderByGradeChart(q, filtered);
        } else {
          chartBody = renderBarsChart(q, stats);
        }

        const leaderSummary = stats.leader
          ? `Mais marcada: <strong>${escapeHtml(stats.leader.value)}</strong> (${stats.leader.count} • ${fmtPct(stats.leader.pctResp)})`
          : 'Sem marcações registradas neste recorte';

        return `
          <article class="q-card">
            <div>
              <div class="q-card-top">
                <div class="q-badges">
                  <span class="q-num-badge">Pergunta ${q.number}</span>
                  <span class="q-cat-badge">${escapeHtml(q.category)}</span>
                  ${
                    q.required
                      ? '<span class="q-req-badge">Obrigatória *</span>'
                      : '<span class="q-opt-badge">Opcional</span>'
                  }
                </div>
                <div class="q-mini-modes" role="group" aria-label="Modo de visualização da pergunta ${q.number}">
                  <button type="button" class="q-mini-btn ${mode === 'bars' ? 'active' : ''}" data-card-q="${q.key}" data-card-mode="bars">Barras</button>
                  <button type="button" class="q-mini-btn ${mode === 'donut' ? 'active' : ''}" data-card-q="${q.key}" data-card-mode="donut">Rosca</button>
                  <button type="button" class="q-mini-btn ${mode === 'byGrade' ? 'active' : ''}" data-card-q="${q.key}" data-card-mode="byGrade">Série</button>
                </div>
              </div>
              <h3 class="q-card-title">${escapeHtml(q.title)}</h3>
              ${chartBody}
            </div>
            <div class="q-card-footer">
              <span class="q-leader-text">${leaderSummary}</span>
              <span>${stats.answeredResp}/${stats.totalResp} resp.${stats.totalMarks > stats.answeredResp ? ` (${stats.totalMarks} marcações)` : ''}</span>
            </div>
          </article>
        `;
      })
      .join('');

    // Wire per-card mode buttons
    grid.querySelectorAll('button[data-card-q]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qKey = btn.dataset.cardQ;
        const m = btn.dataset.cardMode;
        state.cardChartModes[qKey] = m;
        renderQuestionsGrid(getFilteredResponses());
      });
    });

    // Wire interactive click-to-filter on bars, donut slices, legend items, stacked segments
    grid.querySelectorAll('[data-q][data-opt]').forEach((el) => {
      el.addEventListener('click', () => {
        toggleChartFilter(el.dataset.q, el.dataset.opt);
      });
    });
  }

  // ==========================================
  // HYPOTHESIS CROSS-TABULATION CARD
  // ==========================================
  function renderHypothesisCard(filtered) {
    const card = document.getElementById('hypothesisCard');

    // Group A: Active learners (think before asking OR use to study/summarize)
    const activeGroup = filtered.filter(
      (r) =>
        hasAns(r, 'q4', ['Penso antes']) ||
        hasAns(r, 'q3', ['Estudar e fazer resumos'])
    );
    const activeNoDiff = activeGroup.filter((r) => hasAns(r, 'q6', ['Não'])).length;
    const activeExplain = activeGroup.filter((r) => hasAns(r, 'q7', ['Sim'])).length;
    const activeNoDiffPct = activeGroup.length > 0 ? (activeNoDiff / activeGroup.length) * 100 : 0;
    const activeExplainPct = activeGroup.length > 0 ? (activeExplain / activeGroup.length) * 100 : 0;

    // Group B: Direct/passive users (ask AI straight away OR use to answer exams)
    const passiveGroup = filtered.filter(
      (r) =>
        hasAns(r, 'q4', ['Peço para a IA responder']) ||
        hasAns(r, 'q3', ['Responder provas'])
    );
    const passiveDiff = passiveGroup.filter((r) => hasAns(r, 'q6', ['Sim', 'Às vezes'])).length;
    const passiveLowExplain = passiveGroup.filter((r) => hasAns(r, 'q7', ['Não', 'Depende'])).length;
    const passiveDiffPct = passiveGroup.length > 0 ? (passiveDiff / passiveGroup.length) * 100 : 0;
    const passiveLowExplainPct = passiveGroup.length > 0 ? (passiveLowExplain / passiveGroup.length) * 100 : 0;

    let verdictBadge = '<span class="hyp-verdict-badge tone-slate">Aguardando respostas para cruzamento</span>';
    if (filtered.length >= 2 && (activeGroup.length > 0 || passiveGroup.length > 0)) {
      const activeDiffPct =
        activeGroup.length > 0
          ? (activeGroup.filter((r) => hasAns(r, 'q6', ['Sim', 'Às vezes'])).length / activeGroup.length) * 100
          : 0;
      if (passiveGroup.length > 0 && passiveDiffPct > activeDiffPct + 10) {
        verdictBadge = '<span class="hyp-verdict-badge tone-rose">Hipótese corroborada nos dados atuais</span>';
      } else if (filtered.length > 0) {
        verdictBadge = '<span class="hyp-verdict-badge tone-amber">Resultados mistos / Em observação</span>';
      }
    }

    card.innerHTML = `
      <div class="hyp-header">
        <div>
          <span class="meta-eyebrow">VERIFICAÇÃO DA HIPÓTESE DA PESQUISA (CRUZAMENTO P3/P4 × P6/P7)</span>
          <h3>Uso para Estudo vs. Uso Direto (Cópia): Impacto na Resolução Sem IA</h3>
          <p>Cruzamento automático entre a forma de uso da IA e a dificuldade relatada ao resolver atividades sozinho.</p>
        </div>
        ${verdictBadge}
      </div>

      <div class="hyp-grid">
        <div class="hyp-col">
          <div class="hyp-col-title">
            <span>Perfil Uso Ativo (“Penso antes” / “Estudar e resumos”)</span>
            <span class="ans-pill tone-emerald">${activeGroup.length} part.</span>
          </div>
          <div class="hyp-metrics">
            <div class="hyp-metric-box">
              <div class="hyp-metric-val" style="color:var(--emerald)">${fmtPct(activeNoDiffPct)}</div>
              <div class="hyp-metric-lbl">Sem dificuldade s/ IA (${activeNoDiff}/${activeGroup.length})</div>
            </div>
            <div class="hyp-metric-box">
              <div class="hyp-metric-val" style="color:var(--emerald)">${fmtPct(activeExplainPct)}</div>
              <div class="hyp-metric-lbl">Explicam c/ próprias palavras (${activeExplain}/${activeGroup.length})</div>
            </div>
          </div>
        </div>

        <div class="hyp-col">
          <div class="hyp-col-title">
            <span>Perfil Uso Direto (“Peço p/ IA responder” / “Provas”)</span>
            <span class="ans-pill tone-rose">${passiveGroup.length} part.</span>
          </div>
          <div class="hyp-metrics">
            <div class="hyp-metric-box">
              <div class="hyp-metric-val" style="color:var(--rose)">${fmtPct(passiveDiffPct)}</div>
              <div class="hyp-metric-lbl">Têm dificuldade s/ IA — Sim/Às vezes (${passiveDiff}/${passiveGroup.length})</div>
            </div>
            <div class="hyp-metric-box">
              <div class="hyp-metric-val" style="color:var(--rose)">${fmtPct(passiveLowExplainPct)}</div>
              <div class="hyp-metric-lbl">Não explicam ou dependem (${passiveLowExplain}/${passiveGroup.length})</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // RESPONSES TABLE RENDERING
  // ==========================================
  function renderAnswerPills(qKey, values) {
    const arr = Array.isArray(values) ? values : [];
    if (arr.length === 0) {
      return '<span style="color:var(--text-muted)">—</span>';
    }
    return `
      <div class="ans-badges">
        ${arr
          .map((v) => {
            const meta = getOptionMeta(qKey, v);
            return `<span class="ans-pill tone-${meta.tone}">${escapeHtml(v)}</span>`;
          })
          .join('')}
      </div>
    `;
  }

  function buildTableHtml(filtered, mountId) {
    const query = state.tableSearch.trim().toLowerCase();

    let rows = filtered.filter((r) => {
      if (!query) return true;
      const seqStr = `#${r.seq || ''}`.toLowerCase();
      if (seqStr.includes(query)) return true;
      for (const q of SCHEMA.questions) {
        const vals = r.answers?.[q.key] || [];
        if (vals.some((v) => v.toLowerCase().includes(query))) return true;
      }
      return false;
    });

    rows = rows.slice().sort((a, b) => {
      if (state.tableSort === 'oldest') {
        return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      }
      if (state.tableSort === 'grade') {
        const ga = (a.answers?.q1?.[0] || 'Z');
        const gb = (b.answers?.q1?.[0] || 'Z');
        return ga.localeCompare(gb, 'pt-BR');
      }
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    const rowsHtml =
      rows.length === 0
        ? `<tr><td colspan="10" class="table-empty-state">Nenhuma resposta encontrada para os filtros/busca selecionados.</td></tr>`
        : rows
            .map((r, idx) => {
              const displayNum = r.seq || idx + 1;
              return `
                <tr data-detail-id="${escapeHtml(r.id)}" title="Clique para abrir todos os detalhes desta resposta">
                  <td><strong>#${displayNum}</strong></td>
                  <td style="white-space:nowrap;color:var(--text-muted)">${escapeHtml(fmtDateTime(r.createdAt))}</td>
                  <td>${renderAnswerPills('q1', r.answers?.q1)}</td>
                  <td>${renderAnswerPills('q2', r.answers?.q2)}</td>
                  <td>${renderAnswerPills('q3', r.answers?.q3)}</td>
                  <td>${renderAnswerPills('q4', r.answers?.q4)}</td>
                  <td>${renderAnswerPills('q5', r.answers?.q5)}</td>
                  <td>${renderAnswerPills('q6', r.answers?.q6)}</td>
                  <td>${renderAnswerPills('q7', r.answers?.q7)}</td>
                  <td>${renderAnswerPills('q8', r.answers?.q8)}</td>
                </tr>
              `;
            })
            .join('');

    return `
      <div class="table-card">
        <div class="table-toolbar">
          <div class="table-search-wrap">
            <svg class="table-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" class="js-table-search" data-mount="${mountId}" value="${escapeHtml(state.tableSearch)}" placeholder="Buscar por série, resposta ou #ID..." />
          </div>
          <div class="table-toolbar-right">
            <span>Ordenar:</span>
            <select class="js-table-sort">
              <option value="newest" ${state.tableSort === 'newest' ? 'selected' : ''}>Mais recentes</option>
              <option value="oldest" ${state.tableSort === 'oldest' ? 'selected' : ''}>Mais antigas</option>
              <option value="grade" ${state.tableSort === 'grade' ? 'selected' : ''}>Por série (P1)</option>
            </select>
          </div>
        </div>
        <div class="table-scroll">
          <table class="resp-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Data / Hora</th>
                <th>1. Série</th>
                <th>2. Uso de IA</th>
                <th>3. Finalidade</th>
                <th>4. 1º Passo</th>
                <th>5. Entende?</th>
                <th>6. Dificuldade s/ IA</th>
                <th>7. Próprias Palavras</th>
                <th>8. Independência</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
        <div class="table-pagination">
          <span>Total listado: <strong>${rows.length}</strong> resposta(s) • Clique em uma linha para inspecionar</span>
          <span>Fonte: <strong>${state.datasetMode === 'demo' ? 'Simulação de Teste' : 'Respostas Reais'}</strong></span>
        </div>
      </div>
    `;
  }

  function mountTables(filtered) {
    const mounts = ['dashboardTableMount', 'dedicatedTableMount'];
    for (const mId of mounts) {
      const container = document.getElementById(mId);
      if (!container) continue;
      container.innerHTML = buildTableHtml(filtered, mId);

      const searchInput = container.querySelector('.js-table-search');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          state.tableSearch = e.target.value;
          const pos = e.target.selectionStart;
          mountTables(getFilteredResponses());
          const reopened = document.getElementById(mId)?.querySelector('.js-table-search');
          if (reopened) {
            reopened.focus();
            try {
              reopened.setSelectionRange(pos, pos);
            } catch (_) {}
          }
        });
      }

      const sortSel = container.querySelector('.js-table-sort');
      if (sortSel) {
        sortSel.addEventListener('change', (e) => {
          state.tableSort = e.target.value;
          mountTables(getFilteredResponses());
        });
      }

      container.querySelectorAll('tr[data-detail-id]').forEach((row) => {
        row.addEventListener('click', () => {
          openDetailModal(row.dataset.detailId);
        });
      });
    }
  }

  // ==========================================
  // RESPONSE DETAIL MODAL & DELETE
  // ==========================================
  function openDetailModal(respId) {
    const dataset = getActiveDataset();
    const item = dataset.find((r) => r.id === respId);
    if (!item) return;

    state.selectedDetailId = respId;
    document.getElementById('detailModalTitle').textContent = `Participação #${item.seq || '—'}`;

    const sourceLabel =
      item.source === 'demo'
        ? 'Simulação'
        : item.source === 'import'
        ? 'Importado (CSV/Planilha)'
        : 'Respondido no Site';

    const body = document.getElementById('detailModalBody');
    body.innerHTML = `
      <div class="detail-meta-strip">
        <span>Data/Hora: <strong>${escapeHtml(fmtDateTime(item.createdAt))}</strong></span>
        <span>Origem: <strong>${escapeHtml(sourceLabel)}</strong></span>
        ${item.googleFormsSynced ? '<span class="ans-pill tone-emerald">Sincronizado c/ Google Forms</span>' : ''}
      </div>
      <div class="detail-q-list">
        ${SCHEMA.questions
          .map(
            (q) => `
              <div class="detail-q-item">
                <div class="detail-q-label">${escapeHtml(q.title)}</div>
                ${renderAnswerPills(q.key, item.answers?.[q.key])}
              </div>
            `
          )
          .join('')}
      </div>
    `;

    const delBtn = document.getElementById('btnDeleteSingleResponse');
    delBtn.classList.toggle('hidden', state.datasetMode === 'demo');

    document.getElementById('detailModal').classList.remove('hidden');
  }

  async function deleteSelectedResponse() {
    const id = state.selectedDetailId;
    if (!id || state.datasetMode === 'demo') return;

    if (state.backendOnline) {
      try {
        const res = await fetch(`/api/responses/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          state.realResponses = data.responses;
          saveLocalFallback(state.realResponses);
        }
      } catch (_) {}
    } else {
      state.realResponses = state.realResponses
        .filter((r) => r.id !== id)
        .map((r, i) => ({ ...r, seq: i + 1 }));
      saveLocalFallback(state.realResponses);
    }

    document.getElementById('detailModal').classList.add('hidden');
    showToast('Resposta removida do painel.');
    renderAll();
  }

  // ==========================================
  // INTEGRATED 8-QUESTION SURVEY FORM
  // ==========================================
  function renderIntegratedForm() {
    const mount = document.getElementById('surveyQuestionsMount');
    if (!mount) return;

    mount.innerHTML = SCHEMA.questions
      .map((q) => {
        return `
          <div class="survey-q-card" id="surveyCard_${q.key}" data-q-key="${q.key}">
            <h3 class="survey-q-title">
              <span>${escapeHtml(q.title)}</span>
              ${q.required ? '<span class="survey-q-req" title="Obrigatória">*</span>' : ''}
            </h3>
            <p class="survey-q-hint">
              ${q.required ? 'Pergunta obrigatória' : 'Pergunta opcional'} • Marque uma ou mais opções
            </p>
            <div class="survey-options-grid">
              ${q.options
                .map((opt, idx) => {
                  const inputId = `chk_${q.key}_${idx}`;
                  return `
                    <label class="survey-opt-label" for="${inputId}">
                      <input type="checkbox" id="${inputId}" name="${q.key}" value="${escapeHtml(opt.value)}" />
                      <span>${escapeHtml(opt.value)}</span>
                    </label>
                  `;
                })
                .join('')}
            </div>
          </div>
        `;
      })
      .join('');

    mount.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const lbl = chk.closest('.survey-opt-label');
        if (lbl) lbl.classList.toggle('is-checked', chk.checked);
        const qCard = chk.closest('.survey-q-card');
        if (qCard && chk.checked) qCard.classList.remove('has-error');
        updateSurveyProgress();
      });
    });

    updateSurveyProgress();
  }

  function collectFormAnswers() {
    const form = document.getElementById('integratedSurveyForm');
    const answers = {};
    for (const q of SCHEMA.questions) {
      const checked = Array.from(form.querySelectorAll(`input[name="${q.key}"]:checked`)).map(
        (el) => el.value
      );
      answers[q.key] = checked;
    }
    return answers;
  }

  function updateSurveyProgress() {
    const answers = collectFormAnswers();
    const reqQuestions = SCHEMA.questions.filter((q) => q.required);
    const filledReq = reqQuestions.filter((q) => (answers[q.key] || []).length > 0).length;
    const pill = document.getElementById('formProgressText');
    if (pill) {
      pill.textContent = `${filledReq} de ${reqQuestions.length} obrigatórias respondidas`;
    }
  }

  function resetSurveyFormUI() {
    const form = document.getElementById('integratedSurveyForm');
    form.reset();
    form.querySelectorAll('.survey-opt-label').forEach((l) => l.classList.remove('is-checked'));
    form.querySelectorAll('.survey-q-card').forEach((c) => c.classList.remove('has-error'));
    document.getElementById('formErrorAlert').classList.add('hidden');
    updateSurveyProgress();
  }

  async function handleSurveySubmit(e) {
    e.preventDefault();
    const answers = collectFormAnswers();
    const errBox = document.getElementById('formErrorAlert');
    errBox.classList.add('hidden');

    // Validate required questions (Q1, Q3, Q5, Q6, Q7, Q8)
    let firstMissingEl = null;
    const missingNums = [];
    for (const q of SCHEMA.questions) {
      const card = document.getElementById(`surveyCard_${q.key}`);
      if (q.required && (!answers[q.key] || answers[q.key].length === 0)) {
        missingNums.push(q.number);
        if (card) {
          card.classList.add('has-error');
          if (!firstMissingEl) firstMissingEl = card;
        }
      } else if (card) {
        card.classList.remove('has-error');
      }
    }

    if (missingNums.length > 0) {
      errBox.textContent = `Por favor, responda as perguntas obrigatórias pendentes: Pergunta(s) ${missingNums.join(', ')}.`;
      errBox.classList.remove('hidden');
      if (firstMissingEl) {
        firstMissingEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    const syncGoogle = document.getElementById('chkSyncGoogleForms').checked;
    const submitBtn = document.getElementById('btnSubmitSurvey');
    submitBtn.disabled = true;

    try {
      let savedEntry = null;
      if (state.backendOnline) {
        const res = await fetch('/api/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers, syncGoogleForms: syncGoogle }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Falha ao salvar resposta.');
        }
        savedEntry = data.response;
        // Ensure state has it immediately even before SSE arrives
        if (!state.realResponses.some((r) => r.id === savedEntry.id)) {
          state.realResponses.push(savedEntry);
          saveLocalFallback(state.realResponses);
        }
      } else {
        savedEntry = {
          id: 'local-' + Date.now(),
          seq: state.realResponses.length + 1,
          createdAt: new Date().toISOString(),
          source: 'site',
          googleFormsSynced: false,
          answers,
        };
        state.realResponses.push(savedEntry);
        saveLocalFallback(state.realResponses);
      }

      // Switch dataset automatically to Real Data so user sees their response immediately
      state.datasetMode = 'real';
      resetSurveyFormUI();

      document.getElementById('integratedSurveyForm').classList.add('hidden');
      const successCard = document.getElementById('surveySuccessCard');
      const detailText = document.getElementById('surveySuccessDetail');
      detailText.textContent = savedEntry.googleFormsSynced
        ? `Participação #${savedEntry.seq} salva em tempo real neste dashboard e sincronizada com o Google Forms original!`
        : `Participação #${savedEntry.seq} contabilizada instantaneamente nos gráficos e na tabela deste dashboard!`;
      successCard.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });

      renderAll();
    } catch (err) {
      errBox.textContent = err.message || 'Erro ao registrar resposta.';
      errBox.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
    }
  }

  // ==========================================
  // CSV PARSER, GOOGLE SHEETS SYNC & EXPORT
  // ==========================================
  function parseCSVText(text) {
    // Auto-detect delimiter (comma vs semicolon) from header line
    const clean = text.replace(/^\uFEFF/, '');
    const firstLineEnd = clean.indexOf('\n');
    const firstLine = firstLineEnd >= 0 ? clean.slice(0, firstLineEnd) : clean;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const semiCount = (firstLine.match(/;/g) || []).length;
    const delim = semiCount > commaCount ? ';' : ',';

    const rows = [];
    let curRow = [];
    let curVal = '';
    let inQuotes = false;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      const next = clean[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          curVal += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          curVal += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delim) {
          curRow.push(curVal.trim());
          curVal = '';
        } else if (ch === '\r' && next === '\n') {
          curRow.push(curVal.trim());
          rows.push(curRow);
          curRow = [];
          curVal = '';
          i++;
        } else if (ch === '\n') {
          curRow.push(curVal.trim());
          rows.push(curRow);
          curRow = [];
          curVal = '';
        } else {
          curVal += ch;
        }
      }
    }
    if (curVal.length > 0 || curRow.length > 0) {
      curRow.push(curVal.trim());
      rows.push(curRow);
    }

    return rows.filter((r) => r.some((cell) => cell !== ''));
  }

  function normalizeTextForMatch(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchCellOptions(q, rawCell) {
    if (!rawCell) return [];
    const parts = String(rawCell)
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean);

    const matched = [];
    for (const part of parts) {
      const normPart = normalizeTextForMatch(part);
      const exact = q.options.find((o) => normalizeTextForMatch(o.value) === normPart);
      if (exact && !matched.includes(exact.value)) {
        matched.push(exact.value);
      }
    }
    return matched;
  }

  function mapCSVRowsToEntries(rows) {
    if (rows.length < 2) return [];
    const headers = rows[0];

    // Map each question to its CSV column index
    const colMap = {};
    let timestampCol = -1;

    headers.forEach((h, idx) => {
      const nh = normalizeTextForMatch(h);
      if (nh.includes('carimbo') || nh.includes('timestamp') || nh.includes('data')) {
        if (timestampCol === -1) timestampCol = idx;
      }
      for (const q of SCHEMA.questions) {
        if (colMap[q.key] !== undefined) continue;
        const numPrefix = `${q.number}.`;
        const normTitle = normalizeTextForMatch(q.rawTitle);
        if (nh.startsWith(numPrefix) || nh.includes(normTitle.slice(3, 28))) {
          colMap[q.key] = idx;
        }
      }
    });

    // Fallback positional mapping if headers are standard 9-column Google Forms CSV
    if (Object.keys(colMap).length < 4 && headers.length >= 9) {
      timestampCol = 0;
      SCHEMA.questions.forEach((q, idx) => {
        colMap[q.key] = idx + 1;
      });
    }

    const entries = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const answers = {};
      let anySelected = false;

      for (const q of SCHEMA.questions) {
        const cIdx = colMap[q.key];
        const cell = cIdx !== undefined ? row[cIdx] : '';
        const opts = matchCellOptions(q, cell);
        answers[q.key] = opts;
        if (opts.length > 0) anySelected = true;
      }

      if (!anySelected) continue;

      let createdAt = new Date().toISOString();
      if (timestampCol >= 0 && row[timestampCol]) {
        const parsedDate = new Date(row[timestampCol]);
        if (!Number.isNaN(parsedDate.getTime())) {
          createdAt = parsedDate.toISOString();
        }
      }

      entries.push({ createdAt, source: 'import', answers });
    }

    return entries;
  }

  async function importEntriesToStore(entries, mode) {
    if (entries.length === 0) {
      throw new Error(
        'Nenhuma linha válida foi encontrada para as 8 perguntas deste formulário.'
      );
    }

    if (state.backendOnline) {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, mode }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Erro ao importar dados.');
      }
      state.realResponses = data.responses;
      saveLocalFallback(state.realResponses);
    } else {
      const base = mode === 'replace' ? [] : state.realResponses.slice();
      entries.forEach((e) => {
        base.push({
          id: 'imp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          seq: base.length + 1,
          createdAt: e.createdAt,
          source: 'import',
          answers: e.answers,
        });
      });
      state.realResponses = base;
      saveLocalFallback(state.realResponses);
    }

    state.datasetMode = 'real';
    renderAll();
  }

  function exportFilteredToCSV() {
    const filtered = getFilteredResponses();
    const headers = ['Carimbo de data/hora', ...SCHEMA.questions.map((q) => q.title)];

    const escapeCsvCell = (val) => {
      const s = String(val ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const lines = [headers.map(escapeCsvCell).join(',')];
    for (const r of filtered) {
      const cells = [
        fmtDateTime(r.createdAt),
        ...SCHEMA.questions.map((q) => (r.answers?.[q.key] || []).join(', ')),
      ];
      lines.push(cells.map(escapeCsvCell).join(','));
    }

    const csvContent = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `respostas-ia-aprendizado-ou-copia-${state.datasetMode}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`CSV exportado com ${filtered.length} resposta(s)!`);
  }

  // ==========================================
  // MASTER RENDER
  // ==========================================
  function renderAll() {
    const realLen = state.realResponses.length;
    const activeDataset = getActiveDataset();
    const filtered = getFilteredResponses();

    // Update top counters & pills
    document.getElementById('realCountPill').textContent = String(realLen);
    document.getElementById('navCountBadge').textContent = String(activeDataset.length);

    document.getElementById('btnRealData').classList.toggle('active', state.datasetMode === 'real');
    document.getElementById('btnDemoData').classList.toggle('active', state.datasetMode === 'demo');
    document.getElementById('demoBanner').classList.toggle('hidden', state.datasetMode !== 'demo');

    // Empty real data callout
    const showEmptyCallout = state.datasetMode === 'real' && realLen === 0;
    document.getElementById('emptyRealCallout').classList.toggle('hidden', !showEmptyCallout);

    renderActiveFilterChips();
    renderKPIs(filtered, activeDataset);
    renderQuestionsGrid(filtered);
    renderHypothesisCard(filtered);
    mountTables(filtered);
  }

  // ==========================================
  // EVENT BINDINGS & INIT
  // ==========================================
  function bindEvents() {
    // Top view tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.view === 'form') {
          document.getElementById('surveySuccessCard').classList.add('hidden');
          document.getElementById('integratedSurveyForm').classList.remove('hidden');
        }
        switchView(btn.dataset.view);
      });
    });

    // Any [data-goto-view] button
    document.querySelectorAll('[data-goto-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.gotoView;
        if (v === 'form') {
          document.getElementById('surveySuccessCard').classList.add('hidden');
          document.getElementById('integratedSurveyForm').classList.remove('hidden');
        }
        switchView(v);
      });
    });

    // Dataset switcher (Real vs Demo)
    document.getElementById('btnRealData').addEventListener('click', () => {
      state.datasetMode = 'real';
      renderAll();
    });
    document.getElementById('btnDemoData').addEventListener('click', () => {
      state.datasetMode = 'demo';
      renderAll();
    });
    document.getElementById('btnEmptyDemo').addEventListener('click', () => {
      state.datasetMode = 'demo';
      renderAll();
    });
    document.getElementById('btnExitDemo').addEventListener('click', () => {
      state.datasetMode = 'real';
      renderAll();
    });
    document.getElementById('btnExitDemoToForm').addEventListener('click', () => {
      state.datasetMode = 'real';
      document.getElementById('surveySuccessCard').classList.add('hidden');
      document.getElementById('integratedSurveyForm').classList.remove('hidden');
      switchView('form');
    });

    // Theme toggle
    document.getElementById('btnThemeToggle').addEventListener('click', () => {
      const root = document.documentElement;
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      document.getElementById('iconMoon').classList.toggle('hidden', next === 'dark');
      document.getElementById('iconSun').classList.toggle('hidden', next !== 'dark');
    });

    // Toggle form metadata description
    document.getElementById('btnToggleMeta').addEventListener('click', () => {
      const body = document.getElementById('formMetaBody');
      const isHidden = body.classList.toggle('hidden');
      document.getElementById('chevronMeta').style.transform = isHidden ? 'rotate(180deg)' : '';
    });

    // Copy form direct link
    document.getElementById('btnCopyFormLink').addEventListener('click', async () => {
      const url = window.location.origin + window.location.pathname + '#responder';
      try {
        await navigator.clipboard.writeText(url);
        showToast('Link direto para responder copiado!');
      } catch (_) {
        showToast('Link: ' + url);
      }
    });

    // Global chart mode switcher
    document.querySelectorAll('.chart-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.globalChartMode = btn.dataset.chartMode;
        state.cardChartModes = {}; // reset individual overrides
        document.querySelectorAll('.chart-mode-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        renderQuestionsGrid(getFilteredResponses());
      });
    });

    // Clear all filters
    document.getElementById('btnClearFilters').addEventListener('click', clearAllFilters);

    // Survey submission & post-submit actions
    document.getElementById('integratedSurveyForm').addEventListener('submit', handleSurveySubmit);
    document.getElementById('btnClearSurveyForm').addEventListener('click', resetSurveyFormUI);
    document.getElementById('btnGoDashboardAfterSubmit').addEventListener('click', () => {
      switchView('dashboard');
    });
    document.getElementById('btnSubmitAnother').addEventListener('click', () => {
      document.getElementById('surveySuccessCard').classList.add('hidden');
      document.getElementById('integratedSurveyForm').classList.remove('hidden');
      resetSurveyFormUI();
    });

    // CSV Export buttons
    document.getElementById('btnExportCsvDash').addEventListener('click', exportFilteredToCSV);
    document.getElementById('btnExportCsvTable').addEventListener('click', exportFilteredToCSV);

    // Clear all real responses
    document.getElementById('btnClearAllResponses').addEventListener('click', async () => {
      if (state.realResponses.length === 0) {
        showToast('Não há respostas reais para limpar.');
        return;
      }
      if (!window.confirm('Tem certeza que deseja apagar todas as respostas reais salvas neste painel?')) {
        return;
      }
      if (state.backendOnline) {
        await fetch('/api/responses', { method: 'DELETE' });
      }
      state.realResponses = [];
      saveLocalFallback([]);
      state.datasetMode = 'real';
      showToast('Todas as respostas reais foram removidas.');
      renderAll();
    });

    // Modals open/close
    const openImportModal = () => {
      document.getElementById('importStatusMsg').classList.add('hidden');
      document.getElementById('importModal').classList.remove('hidden');
    };
    document.getElementById('btnOpenImport').addEventListener('click', openImportModal);
    document.getElementById('btnEmptyImport').addEventListener('click', openImportModal);
    document.getElementById('btnOpenImportFromTable').addEventListener('click', openImportModal);

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.closeModal)?.classList.add('hidden');
      });
    });

    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });

    document.getElementById('btnDeleteSingleResponse').addEventListener('click', deleteSelectedResponse);

    // CSV File upload inside Import Modal
    document.getElementById('inputCsvFile').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      document.getElementById('csvFileName').textContent = file.name;
      const statusEl = document.getElementById('importStatusMsg');
      const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'append';

      try {
        const text = await file.text();
        const rows = parseCSVText(text);
        const entries = mapCSVRowsToEntries(rows);
        await importEntriesToStore(entries, mode);
        statusEl.className = 'import-status ok';
        statusEl.textContent = `${entries.length} resposta(s) importada(s) com sucesso!`;
        statusEl.classList.remove('hidden');
        showToast(`${entries.length} resposta(s) importada(s)!`);
        setTimeout(() => {
          document.getElementById('importModal').classList.add('hidden');
        }, 1100);
      } catch (err) {
        statusEl.className = 'import-status err';
        statusEl.textContent = err.message;
        statusEl.classList.remove('hidden');
      } finally {
        e.target.value = '';
      }
    });

    // Google Sheets URL sync inside Import Modal
    document.getElementById('btnSyncSheet').addEventListener('click', async () => {
      const urlInput = document.getElementById('inputSheetUrl');
      const statusEl = document.getElementById('importStatusMsg');
      const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'append';
      const url = urlInput.value.trim();

      if (!url) {
        statusEl.className = 'import-status err';
        statusEl.textContent = 'Cole o link da Planilha Google antes de sincronizar.';
        statusEl.classList.remove('hidden');
        return;
      }

      try {
        statusEl.className = 'import-status ok';
        statusEl.textContent = 'Conectando à Planilha Google...';
        statusEl.classList.remove('hidden');

        const res = await fetch('/api/fetch-sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Falha ao buscar planilha.');
        }

        const rows = parseCSVText(data.csv);
        const entries = mapCSVRowsToEntries(rows);
        await importEntriesToStore(entries, mode);

        statusEl.className = 'import-status ok';
        statusEl.textContent = `${entries.length} resposta(s) sincronizada(s) da Planilha Google!`;
        showToast(`${entries.length} resposta(s) sincronizada(s)!`);
        setTimeout(() => {
          document.getElementById('importModal').classList.add('hidden');
        }, 1100);
      } catch (err) {
        statusEl.className = 'import-status err';
        statusEl.textContent = err.message;
        statusEl.classList.remove('hidden');
      }
    });

    window.addEventListener('hashchange', applyHashRoute);
  }

  // Boot application
  populateFilterSelects();
  renderIntegratedForm();
  bindEvents();
  applyHashRoute();
  loadInitialResponses();
})();
