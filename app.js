/**
 * ServLynx Explorer — Windows 11 File Explorer + QNAP Manager
 * Frontend Controller
 */
(() => {
  'use strict';

  const API_URL = 'api.php';

  // ==================== ESTADO GLOBAL ====================
  const state = {
    token: localStorage.getItem('servlynx_token') || '',
    user: null,
    bridgeOnline: false,
    tabs: [{ id: 1, path: '/', history: ['/'], historyIdx: 0, title: 'Este QNAP' }],
    activeTabId: 1,
    nextTabId: 2,
    currentSection: 'explorer', // 'explorer' | 'qnap-monitor' | 'qnap-shares' | 'qnap-users'
    items: [],
    selectedPaths: new Set(),
    lastSelectedIdx: -1,
    clipboard: { mode: null, items: [] }, // mode: 'copy' | 'cut'
    viewMode: localStorage.getItem('servlynx_view') || 'details',
    sortKey: 'name',
    sortAsc: true,
    showHidden: false,
    detailsOpen: false,
    searchActive: false,
    searchQuery: '',
    sharesCache: [],
    currentDirAccessMode: 'rw',
    qnapStatus: null,
    deferredInstallPrompt: null,
    audio: { playlist: [], index: -1 },
    lightbox: { list: [], index: -1, zoomed: false }
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
  });

  // ==================== HELPERS ====================
  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || bytes === '') return '';
    const n = Number(bytes);
    if (Number.isNaN(n)) return '';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const val = n / Math.pow(1024, i);
    return (i === 0 ? val : val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)) + ' ' + units[i];
  }

  function formatDate(ts) {
    if (!ts) return '—';
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function getFileMeta(item) {
    if (item.is_dir) {
      if (item.is_share) return { ico: '🗄️', type: 'Pasta Compartilhada QNAP' };
      return { ico: '📁', type: 'Pasta de arquivos' };
    }
    const ext = (item.ext || '').toLowerCase();
    const map = {
      pdf: ['📕', 'Documento PDF'],
      doc: ['📘', 'Documento Word'], docx: ['📘', 'Documento Word'],
      xls: ['📗', 'Planilha Excel'], xlsx: ['📗', 'Planilha Excel'], csv: ['📗', 'Planilha CSV'],
      ppt: ['📙', 'Apresentação PowerPoint'], pptx: ['📙', 'Apresentação PowerPoint'],
      png: ['🖼️', 'Imagem PNG'], jpg: ['🖼️', 'Imagem JPEG'], jpeg: ['🖼️', 'Imagem JPEG'],
      gif: ['🖼️', 'Imagem GIF'], webp: ['🖼️', 'Imagem WebP'], svg: ['🖼️', 'Imagem SVG'],
      mp4: ['🎬', 'Vídeo MP4'], mkv: ['🎬', 'Vídeo MKV'], avi: ['🎬', 'Vídeo AVI'], mov: ['🎬', 'Vídeo MOV'],
      mp3: ['🎵', 'Áudio MP3'], wav: ['🎵', 'Áudio WAV'], flac: ['🎵', 'Áudio FLAC'],
      zip: ['📦', 'Arquivo Compactado ZIP'], rar: ['📦', 'Arquivo RAR'], '7z': ['📦', 'Arquivo 7-Zip'], tar: ['📦', 'Arquivo TAR'], gz: ['📦', 'Arquivo GZ'],
      txt: ['📝', 'Documento de Texto'], log: ['📝', 'Arquivo de Log'], md: ['📝', 'Markdown'],
      json: ['⚙️', 'JSON'], xml: ['⚙️', 'XML'], yml: ['⚙️', 'YAML'], yaml: ['⚙️', 'YAML'], ini: ['⚙️', 'Configuração'], conf: ['⚙️', 'Configuração'],
      js: ['💻', 'Código JavaScript'], ts: ['💻', 'Código TypeScript'], py: ['🐍', 'Script Python'], php: ['🐘', 'Script PHP'],
      html: ['🌐', 'Página HTML'], css: ['🎨', 'Folha de Estilo CSS'], sql: ['🗃️', 'Script SQL'],
      sh: ['⚡', 'Shell Script'], bat: ['⚡', 'Batch Script'], exe: ['⚙️', 'Executável Windows'],
      dwg: ['📐', 'Desenho CAD (DWG)'], dxf: ['📐', 'Desenho CAD (DXF)'], sldprt: ['📐', 'SolidWorks Part'], sldasm: ['📐', 'SolidWorks Assembly']
    };
    if (map[ext]) return { ico: map[ext][0], type: map[ext][1] };
    return { ico: '📄', type: ext ? `Arquivo ${ext.toUpperCase()}` : 'Arquivo' };
  }

  function isTextExt(ext) {
    return ['txt', 'log', 'md', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'js', 'ts', 'py', 'php', 'html', 'htm', 'css', 'sql', 'sh', 'bat', 'csv', 'env', 'htaccess'].includes((ext || '').toLowerCase());
  }

  function isImageExt(ext) {
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'avif'].includes((ext || '').toLowerCase());
  }

  function isAudioExt(ext) {
    return ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma'].includes((ext || '').toLowerCase());
  }

  function isVideoExt(ext) {
    return ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', '3gp'].includes((ext || '').toLowerCase());
  }

  function mediaUrl(path, inline = true) {
    return `${API_URL}?route=download&${inline ? 'inline=1&' : ''}path=${encodeURIComponent(path)}&token=${encodeURIComponent(state.token)}`;
  }

  function isTouchCompactMode() {
    return window.innerWidth <= 860 || window.matchMedia('(pointer: coarse)').matches;
  }

  function copyTextToClipboard(text, label = 'Copiado!') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(label, 'ok')).catch(() => fallbackCopy(text, label));
    } else {
      fallbackCopy(text, label);
    }
  }

  function fallbackCopy(text, label) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(label, 'ok'); } catch { toast('Copie manualmente: ' + text, 'info'); }
    ta.remove();
  }

  function toast(msg, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''}`;
    el.textContent = msg;
    $('toastContainer').appendChild(el);
    setTimeout(() => { el.remove(); }, 3800);
  }

  async function apiFetch(route, opts = {}) {
    const url = `${API_URL}?route=${encodeURIComponent(route)}${opts.query ? '&' + opts.query : ''}`;
    const headers = opts.headers || {};
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    const res = await fetch(url, {
      method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Resposta inesperada do servidor (${res.status}).`);
    }
    if (res.status === 401 && route !== 'login') {
      handleForceLogout();
      throw new Error(data.error || 'Sessão expirada.');
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Erro HTTP ${res.status}`);
    }
    return data;
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0];
  }

  function currentPath() {
    return activeTab().path;
  }

  function hasPerm(perm) {
    if (!state.user) return false;
    if (state.user.role === 'admin') return true;
    return Boolean(state.user.permissions && state.user.permissions[perm]);
  }

  function hasAnyWriteAccess() {
    if (!state.user) return false;
    if (state.user.role === 'admin') return true;
    if (hasPerm('write') && Array.isArray(state.user.allowed_shares) && state.user.allowed_shares.length > 0) return true;
    const pa = state.user.path_access || {};
    return Object.values(pa).some((m) => m === 'rw');
  }

  function canWriteCurrentDir() {
    if (!state.user) return false;
    if (state.user.role === 'admin') return true;
    if (currentPath() === '/') return hasAnyWriteAccess();
    return state.currentDirAccessMode === 'rw';
  }

  function canAdminShareDirs() {
    return hasPerm('manage_shares') || hasPerm('manage_users');
  }

  // ==================== LOGIN & SESSÃO ====================
  async function checkHealthForLogin() {
    try {
      const data = await apiFetch('health');
      const pill = $('loginBridgeStatus');
      state.bridgeOnline = !!data.bridge_online;
      if (data.bridge_online) {
        pill.className = 'status-pill online';
        pill.innerHTML = '<span class="dot"></span> QNAP NAS Conectado Online';
      } else {
        pill.className = 'status-pill offline';
        pill.innerHTML = '<span class="dot"></span> Aguardando conector do QNAP...';
      }
    } catch {
      // ignora silenciosamente na tela de login
    }
  }

  function handleForceLogout() {
    state.token = '';
    state.user = null;
    localStorage.removeItem('servlynx_token');
    $('appShell').classList.add('hidden');
    $('loginScreen').classList.remove('hidden');
  }

  async function initSession() {
    if (!state.token) {
      $('loginScreen').classList.remove('hidden');
      $('appShell').classList.add('hidden');
      checkHealthForLogin();
      return;
    }
    try {
      const me = await apiFetch('me');
      enterApp(me.user, me.bridge_online);
    } catch {
      handleForceLogout();
      checkHealthForLogin();
    }
  }

  function enterApp(user, bridgeOnline) {
    state.user = user;
    state.bridgeOnline = !!bridgeOnline;
    $('loginScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');

    $('topUserName').textContent = user.name || user.email;
    $('topUserRole').textContent = user.role === 'admin' ? 'Administrador Total' : 'Usuário';
    $('userAvatar').textContent = (user.name || user.email || 'U')[0].toUpperCase();

    const hasAdminAccess =
      user.role === 'admin' ||
      hasPerm('manage_qnap') ||
      hasPerm('manage_shares') ||
      hasPerm('manage_users');
    document.querySelectorAll('.admin-only').forEach((el) => {
      el.classList.toggle('hidden', !hasAdminAccess);
    });
    if ($('adminSidebarSection')) {
      $('adminSidebarSection').classList.toggle('hidden', !hasAdminAccess);
    }

    updateBridgeBadge(bridgeOnline);
    renderTabs();
    loadSharesSidebar();
    navigateTo('/', false);
    refreshStatusLoop();
  }

  function updateBridgeBadge(online) {
    state.bridgeOnline = !!online;
    const badge = $('topBridgeBadge');
    const text = $('topBridgeText');
    const cBtn = $('btnConnectQnap');
    if (online) {
      if (badge) { badge.className = 'status-pill online status-btn'; }
      if (text) text.textContent = 'QNAP Online';
      if (cBtn) { cBtn.classList.remove('connecting'); cBtn.classList.add('connected'); }
    } else {
      if (badge) { badge.className = 'status-pill offline status-btn'; }
      if (text) text.textContent = 'Conector Offline';
      if (cBtn) { cBtn.classList.remove('connecting', 'connected'); }
    }
  }

  function toggleSidebar(forceOpen) {
    const sb = $('sidebar');
    const bd = $('sidebarBackdrop');
    const open = forceOpen !== undefined ? !!forceOpen : !sb.classList.contains('open');
    sb.classList.toggle('open', open);
    if (bd) bd.classList.toggle('hidden', !open);
  }

  function updateMobileViewBtn() {
    const ico = $('mbNavViewIco');
    const lbl = $('mbNavViewLbl');
    if (!ico || !lbl) return;
    if (state.viewMode === 'grid') {
      ico.textContent = '☰';
      lbl.textContent = 'Lista';
    } else {
      ico.textContent = '⊞';
      lbl.textContent = 'Grade';
    }
  }

  let statusTimer = null;
  function refreshStatusLoop() {
    if (statusTimer) clearInterval(statusTimer);
    const run = async () => {
      if (!state.token) return;
      try {
        const h = await apiFetch('health');
        updateBridgeBadge(h.bridge_online);
      } catch { /* ignore */ }
    };
    statusTimer = setInterval(run, 15000);
  }

  // ==================== ABAS & NAVEGAÇÃO ====================
  function renderTabs() {
    const container = $('tabsContainer');
    container.innerHTML = '';
    state.tabs.forEach((tab) => {
      const el = document.createElement('div');
      el.className = 'win-tab' + (tab.id === state.activeTabId ? ' active' : '');
      const label = tab.path === '/' ? 'Este QNAP' : tab.path.split('/').filter(Boolean).pop();
      el.innerHTML = `
        <span>📁</span>
        <span class="win-tab-title" title="${escapeHtml(tab.path)}">${escapeHtml(label)}</span>
        ${state.tabs.length > 1 ? '<button class="win-tab-close" title="Fechar aba">✕</button>' : ''}
      `;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('win-tab-close')) {
          closeTab(tab.id);
          return;
        }
        state.activeTabId = tab.id;
        switchSection('explorer');
        renderTabs();
        loadDirectory(tab.path);
      });
      container.appendChild(el);
    });
  }

  function addTab(path = '/') {
    const id = state.nextTabId++;
    state.tabs.push({ id, path, history: [path], historyIdx: 0, title: path });
    state.activeTabId = id;
    switchSection('explorer');
    renderTabs();
    loadDirectory(path);
  }

  function closeTab(id) {
    if (state.tabs.length <= 1) return;
    const idx = state.tabs.findIndex((t) => t.id === id);
    state.tabs = state.tabs.filter((t) => t.id !== id);
    if (state.activeTabId === id) {
      state.activeTabId = state.tabs[Math.max(0, idx - 1)].id;
      loadDirectory(currentPath());
    }
    renderTabs();
  }

  function switchSection(section) {
    state.currentSection = section;
    $('viewExplorer').classList.toggle('hidden', section !== 'explorer');
    $('viewMonitor').classList.toggle('hidden', section !== 'qnap-monitor');
    $('viewShares').classList.toggle('hidden', section !== 'qnap-shares');
    $('viewUsers').classList.toggle('hidden', section !== 'qnap-users');
    $('commandBar').classList.toggle('hidden', section !== 'explorer');

    document.querySelectorAll('.side-item').forEach((btn) => {
      const nav = btn.dataset.nav;
      if (section === 'explorer') {
        btn.classList.toggle('active', nav === 'explorer' && btn.dataset.path === currentPath());
      } else {
        btn.classList.toggle('active', nav === section);
      }
    });
    document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.adminTab === section);
    });
    $('mbNavHome')?.classList.toggle('active', section === 'explorer');
    $('mbNavAdmin')?.classList.toggle('active', section !== 'explorer');

    if (section === 'qnap-monitor') loadMonitorView();
    if (section === 'qnap-shares') loadSharesView();
    if (section === 'qnap-users') loadUsersView();
    toggleSidebar(false);
  }

  function navigateTo(path, pushHistory = true) {
    let norm = '/' + String(path || '/').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
    const tab = activeTab();
    if (pushHistory && tab.path !== norm) {
      tab.history = tab.history.slice(0, tab.historyIdx + 1);
      tab.history.push(norm);
      tab.historyIdx = tab.history.length - 1;
    }
    tab.path = norm;
    state.searchActive = false;
    $('searchBanner').classList.add('hidden');
    $('searchInput').value = '';
    $('btnClearSearch').classList.add('hidden');
    switchSection('explorer');
    renderTabs();
    loadDirectory(norm);
  }

  function updateNavButtons() {
    const tab = activeTab();
    $('btnBack').disabled = tab.historyIdx <= 0;
    $('btnForward').disabled = tab.historyIdx >= tab.history.length - 1;
    $('btnUp').disabled = tab.path === '/';
    $('searchInput').placeholder = `Pesquisar em ${tab.path === '/' ? 'NAS09534B' : tab.path.split('/').pop()}...`;
  }

  function bindFolderDropTarget(el, getDestFn) {
    if (!el) return;
    let depth = 0;
    const acceptsTypes = (dt) => {
      const types = Array.from(dt?.types || []);
      return types.includes('Files') || types.includes('application/x-servlynx-paths');
    };
    el.addEventListener('dragenter', (e) => {
      if (!hasAnyWriteAccess() || !acceptsTypes(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depth++;
      if (el.classList.contains('file-row') || el.classList.contains('file-card')) {
        $('dropOverlay')?.classList.add('hidden');
      }
      el.classList.add('drop-target-hover');
    });
    el.addEventListener('dragover', (e) => {
      if (!hasAnyWriteAccess() || !acceptsTypes(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const types = Array.from(e.dataTransfer?.types || []);
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = types.includes('application/x-servlynx-paths')
          ? (e.ctrlKey ? 'copy' : 'move')
          : 'copy';
      }
      el.classList.add('drop-target-hover');
    });
    el.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.classList.remove('drop-target-hover');
    });
    el.addEventListener('drop', async (e) => {
      depth = 0;
      el.classList.remove('drop-target-hover');
      $('dropOverlay')?.classList.add('hidden');
      if (!acceptsTypes(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const destPath = getDestFn();
      const types = Array.from(e.dataTransfer?.types || []);
      const op = types.includes('application/x-servlynx-paths') && e.ctrlKey ? 'copy' : 'move';
      await handleDropEventPayload(e, destPath, op);
    });
  }

  function renderBreadcrumbs(path) {
    const bc = $('breadcrumbs');
    bc.innerHTML = '';
    const rootBtn = document.createElement('button');
    rootBtn.className = 'crumb-btn';
    rootBtn.textContent = 'Este QNAP (NAS09534B)';
    rootBtn.onclick = (e) => { e.stopPropagation(); navigateTo('/'); };
    bindFolderDropTarget(rootBtn, () => '/');
    bc.appendChild(rootBtn);

    const parts = path.split('/').filter(Boolean);
    let accum = '';
    parts.forEach((p) => {
      accum += '/' + p;
      const target = accum;
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      bc.appendChild(sep);

      const btn = document.createElement('button');
      btn.className = 'crumb-btn';
      btn.textContent = p;
      btn.onclick = (e) => { e.stopPropagation(); navigateTo(target); };
      bindFolderDropTarget(btn, () => target);
      bc.appendChild(btn);
    });
    $('addressInput').value = path;
  }

  // ==================== LISTAGEM DE ARQUIVOS ====================
  function updateDriveHeroVisibility() {
    const hero = $('driveHeroBox');
    if (!hero) return;
    const show = state.currentSection === 'explorer' && currentPath() === '/' && !state.searchActive;
    hero.classList.toggle('hidden', !show);
  }

  function applyDiskSummaryToUI(statusObj) {
    if (!statusObj || !statusObj.disk) return;
    const d = statusObj.disk;
    const pct = Math.min(100, d.percent || 0);
    if ($('capText')) $('capText').textContent = `${d.used_human || '--'} / ${d.total_human || '1.8 TB'}`;
    if ($('capFill')) $('capFill').style.width = `${pct}%`;
    if ($('driveHeroFill')) $('driveHeroFill').style.width = `${pct}%`;
    if ($('driveHeroSub')) {
      $('driveHeroSub').textContent = `Usado: ${d.used_human || '--'} de ${d.total_human || '1.8 TB'} • Livre: ${d.avail_human || '--'} • Fotos e músicas sem download`;
    }
    if ($('statusNasInfo')) {
      $('statusNasInfo').textContent = `QNAP ${statusObj.model || 'TS-231P'} • ${statusObj.ip || '192.168.15.44'} • Livre: ${d.avail_human || '--'}`;
    }
  }

  function updateAccessModeBanner(path) {
    const banner = $('accessModeBanner');
    if (!banner) return;
    if (state.user?.role === 'admin' || path === '/' || state.searchActive) {
      banner.classList.add('hidden');
      return;
    }
    if (state.currentDirAccessMode === 'traverse') {
      banner.textContent = '🔒 Visualização restrita: exibindo apenas os subdiretórios compartilhados com sua conta.';
      banner.classList.remove('hidden');
    } else if (state.currentDirAccessMode === 'ro') {
      banner.textContent = '👁️ Somente Leitura: você pode visualizar e baixar arquivos desta pasta.';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  async function loadDirectory(path) {
    state.selectedPaths.clear();
    state.lastSelectedIdx = -1;
    updateToolbarButtons();
    updateNavButtons();
    renderBreadcrumbs(path);
    updateDriveHeroVisibility();
    $('loadingBar').classList.remove('hidden');

    try {
      const q = `path=${encodeURIComponent(path)}${state.showHidden ? '&hidden=1' : ''}`;
      const res = await apiFetch('files', { query: q });
      updateBridgeBadge(res.bridge_online !== false);
      state.currentDirAccessMode = res.access_mode || (state.user?.role === 'admin' ? 'rw' : 'rw');
      state.items = res.items || [];
      if (path === '/' && !state.searchActive) {
        state.sharesCache = state.items.filter((i) => i.is_dir);
        renderSidebarShares(state.sharesCache);
      }
      updateAccessModeBanner(path);
      updateToolbarButtons();
      renderFiles();
      if (res.warning) {
        toast('Aviso: exibindo cache da raiz (' + res.warning + ')', 'err');
      }
    } catch (err) {
      state.items = [];
      renderFiles();
      toast(err.message, 'err');
    } finally {
      $('loadingBar').classList.add('hidden');
    }
  }

  async function loadSharesSidebar() {
    try {
      const res = await apiFetch('shares');
      if (res.shares) {
        state.sharesCache = res.shares;
        renderSidebarShares(res.shares);
      }
    } catch { /* fallback ao carregar raiz */ }

    try {
      const st = hasPerm('manage_qnap') ? await apiFetch('qnap_status') : await apiFetch('connect_qnap');
      if (st.status) {
        state.qnapStatus = st.status;
        applyDiskSummaryToUI(st.status);
      }
    } catch { /* ignore */ }
  }

  function renderSidebarShares(shares) {
    const wrap = $('sidebarShares');
    wrap.innerHTML = '';
    const cp = currentPath();
    shares.forEach((s) => {
      const name = s.name;
      const path = '/' + name;
      const btn = document.createElement('button');
      btn.className = 'side-item' + (state.currentSection === 'explorer' && (cp === path || cp.startsWith(path + '/')) ? ' active' : '');
      btn.dataset.nav = 'explorer';
      btn.dataset.path = path;
      btn.innerHTML = `<span class="side-ico">📁</span><span>${escapeHtml(name)}</span>`;
      btn.onclick = () => navigateTo(path);
      bindFolderDropTarget(btn, () => path);
      wrap.appendChild(btn);
    });

    const pa = state.user?.path_access || {};
    Object.entries(pa).forEach(([subPath, mode]) => {
      if (mode !== 'rw' && mode !== 'ro') return;
      const segs = String(subPath || '').split('/').filter(Boolean);
      if (segs.length < 2) return;
      const leaf = segs[segs.length - 1];
      const rootName = segs[0];
      const btn = document.createElement('button');
      btn.className = 'side-item' + (state.currentSection === 'explorer' && (cp === subPath || cp.startsWith(subPath + '/')) ? ' active' : '');
      btn.dataset.nav = 'explorer';
      btn.dataset.path = subPath;
      btn.title = `${subPath} (${mode.toUpperCase()})`;
      btn.innerHTML = `<span class="side-ico">${mode === 'ro' ? '👁️' : '📂'}</span><span>${escapeHtml(leaf)} <small style="opacity:.7">(${escapeHtml(rootName)})</small></span>`;
      btn.onclick = () => navigateTo(subPath);
      if (mode === 'rw') bindFolderDropTarget(btn, () => subPath);
      wrap.appendChild(btn);
    });
  }

  function sortedItems() {
    const list = [...state.items];
    const dirFactor = state.sortAsc ? 1 : -1;
    list.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      if (state.sortKey === 'size') return ((a.size || 0) - (b.size || 0)) * dirFactor;
      if (state.sortKey === 'mtime') return ((a.mtime || 0) - (b.mtime || 0)) * dirFactor;
      if (state.sortKey === 'type') return getFileMeta(a).type.localeCompare(getFileMeta(b).type) * dirFactor;
      return (a.name || '').localeCompare(b.name || '', 'pt-BR', { numeric: true, sensitivity: 'base' }) * dirFactor;
    });
    return list;
  }

  function renderFiles() {
    const container = $('fileContainer');
    const items = sortedItems();
    container.innerHTML = '';
    container.className = `file-container view-${state.viewMode}`;
    updateMobileViewBtn();

    $('emptyState').classList.toggle('hidden', items.length > 0);
    $('statusCount').textContent = `${items.length} ${items.length === 1 ? 'item' : 'itens'}`;

    if (items.length === 0) return;

    if (state.viewMode === 'details') {
      const table = document.createElement('table');
      table.className = 'file-table';
      const sortIcon = (k) => (state.sortKey === k ? (state.sortAsc ? ' ▲' : ' ▼') : '');
      table.innerHTML = `
        <thead>
          <tr>
            <th data-sort="name">Nome${sortIcon('name')}</th>
            <th class="col-date" data-sort="mtime">Data de modificação${sortIcon('mtime')}</th>
            <th class="col-type" data-sort="type">Tipo${sortIcon('type')}</th>
            <th class="col-size" data-sort="size" style="text-align:right">Tamanho${sortIcon('size')}</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      table.querySelectorAll('th[data-sort]').forEach((th) => {
        th.onclick = () => {
          const k = th.dataset.sort;
          if (state.sortKey === k) state.sortAsc = !state.sortAsc;
          else { state.sortKey = k; state.sortAsc = true; }
          renderFiles();
        };
      });
      const tbody = table.querySelector('tbody');
      items.forEach((item, idx) => {
        const meta = getFileMeta(item);
        const tr = document.createElement('tr');
        tr.className = 'file-row' + (state.selectedPaths.has(item.path) ? ' selected' : '');
        tr.dataset.path = item.path;
        const accBadge = item.access_mode === 'ro'
          ? '<span class="file-access-badge ro" title="Somente Leitura">RO</span>'
          : (item.access_mode === 'traverse' ? '<span class="file-access-badge partial" title="Contém subpasta liberada">Parcial</span>' : '');
        const subMob = item.is_dir
          ? (item.is_share ? 'Pasta Compartilhada' : 'Pasta')
          : `${formatBytes(item.size)} • ${formatDate(item.mtime)}`;
        tr.innerHTML = `
          <td>
            <div class="file-name-cell">
              <button type="button" class="item-check" title="Selecionar">✓</button>
              <span class="file-ico">${meta.ico}</span>
              <div class="file-name-wrap">
                <span class="file-name-text" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}${accBadge}</span>
                <span class="file-sub-mobile">${escapeHtml(subMob)}</span>
              </div>
            </div>
          </td>
          <td class="col-date">${formatDate(item.mtime)}</td>
          <td class="col-type">${escapeHtml(meta.type)}</td>
          <td class="col-size">${item.is_dir ? '' : formatBytes(item.size)}</td>
          <td class="col-actions"><button type="button" class="item-more" title="Opções">⋮</button></td>
        `;
        attachItemEvents(tr, item, idx, items);
        tbody.appendChild(tr);
      });
      container.appendChild(table);
    } else if (state.viewMode === 'grid') {
      const grid = document.createElement('div');
      grid.className = 'file-grid';
      items.forEach((item, idx) => {
        const meta = getFileMeta(item);
        const card = document.createElement('div');
        card.className = 'file-card' + (state.selectedPaths.has(item.path) ? ' selected' : '');
        card.dataset.path = item.path;
        const isImg = !item.is_dir && isImageExt(item.ext);
        const visualHtml = isImg
          ? `<div class="file-card-thumb-wrap"><img class="file-card-thumb" loading="lazy" src="${mediaUrl(item.path, true)}" alt="${escapeHtml(item.name)}" /></div>`
          : `<div class="file-card-ico">${meta.ico}</div>`;
        const accBadge = item.access_mode === 'ro'
          ? ' <span class="file-access-badge ro">RO</span>'
          : (item.access_mode === 'traverse' ? ' <span class="file-access-badge partial">Parcial</span>' : '');
        card.innerHTML = `
          <div class="file-card-top">
            <button type="button" class="item-check" title="Selecionar">✓</button>
            <button type="button" class="item-more" title="Opções">⋮</button>
          </div>
          ${visualHtml}
          <div class="file-card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}${accBadge}</div>
          <div class="file-card-sub">${item.is_dir ? 'Pasta' : formatBytes(item.size)}</div>
        `;
        if (isImg) {
          const img = card.querySelector('.file-card-thumb');
          img?.addEventListener('error', () => {
            const wrap = card.querySelector('.file-card-thumb-wrap');
            if (wrap) wrap.outerHTML = `<div class="file-card-ico">${meta.ico}</div>`;
          }, { once: true });
        }
        attachItemEvents(card, item, idx, items);
        grid.appendChild(card);
      });
      container.appendChild(grid);
    } else {
      const list = document.createElement('div');
      list.className = 'file-list';
      items.forEach((item, idx) => {
        const meta = getFileMeta(item);
        const row = document.createElement('div');
        row.className = 'file-list-item' + (state.selectedPaths.has(item.path) ? ' selected' : '');
        row.dataset.path = item.path;
        row.innerHTML = `
          <button type="button" class="item-check" title="Selecionar">✓</button>
          <span class="file-ico">${meta.ico}</span>
          <span class="file-name-text" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.access_mode === 'ro' ? ' <span class="file-access-badge ro">RO</span>' : (item.access_mode === 'traverse' ? ' <span class="file-access-badge partial">Parcial</span>' : '')}</span>
          <button type="button" class="item-more" title="Opções">⋮</button>
        `;
        attachItemEvents(row, item, idx, items);
        list.appendChild(row);
      });
      container.appendChild(list);
    }
  }

  function toggleMultiSelectItem(item, idx) {
    if (state.selectedPaths.has(item.path)) state.selectedPaths.delete(item.path);
    else state.selectedPaths.add(item.path);
    state.lastSelectedIdx = idx;
    syncSelectionUI();
  }

  function attachItemEvents(el, item, idx, allItems) {
    const chkBtn = el.querySelector('.item-check');
    if (chkBtn) {
      chkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMultiSelectItem(item, idx);
      });
    }

    const moreBtn = el.querySelector('.item-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!state.selectedPaths.has(item.path)) {
          state.selectedPaths.clear();
          state.selectedPaths.add(item.path);
          state.lastSelectedIdx = idx;
          syncSelectionUI();
        }
        const rect = moreBtn.getBoundingClientRect();
        showContextMenu(rect.left - 160, rect.bottom + 4, item);
      });
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        toggleMultiSelectItem(item, idx);
        return;
      }
      if (e.shiftKey && state.lastSelectedIdx >= 0) {
        const start = Math.min(state.lastSelectedIdx, idx);
        const end = Math.max(state.lastSelectedIdx, idx);
        state.selectedPaths.clear();
        for (let i = start; i <= end; i++) state.selectedPaths.add(allItems[i].path);
        syncSelectionUI();
        return;
      }

      if (isTouchCompactMode()) {
        // No celular / tablet, 1 toque abre pastas, fotos, musicas e arquivos sem baixar
        openItem(item);
        return;
      }

      state.selectedPaths.clear();
      state.selectedPaths.add(item.path);
      state.lastSelectedIdx = idx;
      syncSelectionUI();
    });

    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openItem(item);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selectedPaths.has(item.path)) {
        state.selectedPaths.clear();
        state.selectedPaths.add(item.path);
        state.lastSelectedIdx = idx;
        syncSelectionUI();
      }
      showContextMenu(e.clientX, e.clientY, item);
    });

    if (!isTouchCompactMode()) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        const dragPaths = state.selectedPaths.has(item.path)
          ? Array.from(state.selectedPaths)
          : [item.path];
        e.dataTransfer.setData('application/x-servlynx-paths', JSON.stringify(dragPaths));
        e.dataTransfer.effectAllowed = 'copyMove';
      });
    }

    if (item.is_dir) {
      bindFolderDropTarget(el, () => item.path);
    }
  }

  function getSelectedItems() {
    return state.items.filter((i) => state.selectedPaths.has(i.path));
  }

  function syncSelectionUI() {
    document.querySelectorAll('[data-path]').forEach((el) => {
      if (el.classList.contains('file-row') || el.classList.contains('file-card') || el.classList.contains('file-list-item')) {
        el.classList.toggle('selected', state.selectedPaths.has(el.dataset.path));
      }
    });
    updateToolbarButtons();
    const sel = getSelectedItems();
    if (sel.length > 0) {
      const totalBytes = sel.reduce((acc, i) => acc + (i.is_dir ? 0 : (i.size || 0)), 0);
      $('statusSelected').classList.remove('hidden');
      $('statusSelected').textContent = `${sel.length} ${sel.length === 1 ? 'selecionado' : 'selecionados'}${totalBytes ? ' (' + formatBytes(totalBytes) + ')' : ''}`;
    } else {
      $('statusSelected').classList.add('hidden');
    }
    if (state.detailsOpen) renderDetailsPane();
  }

  function updateToolbarButtons() {
    const sel = getSelectedItems();
    const count = sel.length;
    const cp = currentPath();
    const isAdmin = state.user?.role === 'admin';
    const canWriteHere = isAdmin || (cp === '/' ? hasAnyWriteAccess() : canWriteCurrentDir());
    const canDeleteHere = isAdmin || (cp !== '/' && state.currentDirAccessMode === 'rw' && (hasPerm('delete') || hasAnySubdirWriteRule(cp)));
    const isRootChildSelected = sel.some((i) => i.path.split('/').filter(Boolean).length <= 1);
    const hasRestrictedSelected = sel.some((i) => i.access_mode && i.access_mode !== 'rw');

    if ($('btnOpenItem')) $('btnOpenItem').disabled = count !== 1;
    if ($('btnOpenLocalDrive')) $('btnOpenLocalDrive').disabled = count !== 1;
    $('btnCut').disabled = count === 0 || !canWriteHere || !canDeleteHere || isRootChildSelected || hasRestrictedSelected;
    $('btnCopy').disabled = count === 0;
    $('btnPaste').disabled = !canWriteHere;
    $('btnRename').disabled = count !== 1 || !canWriteHere || isRootChildSelected || hasRestrictedSelected;
    $('btnDelete').disabled = count === 0 || !canDeleteHere || (isRootChildSelected && !isAdmin) || hasRestrictedSelected;
    $('btnDownload').disabled = count !== 1;
    $('btnProperties').disabled = count !== 1;
    if ($('btnShareDir')) {
      const canShareSel = (count === 1 && sel[0].is_dir) || cp !== '/';
      $('btnShareDir').disabled = !canAdminShareDirs() || !canShareSel;
    }
    if ($('btnMapDriveCmd')) {
      $('btnMapDriveCmd').disabled = false;
    }
    if ($('btnNewMenu')) $('btnNewMenu').disabled = !canWriteHere && !canAdminShareDirs();
    $('btnUpload').disabled = !canWriteHere;
    if ($('mbNavUpload')) $('mbNavUpload').disabled = !canWriteHere;

    if (state.clipboard.items.length > 0) {
      $('statusClipboard').classList.remove('hidden');
      $('statusClipboard').textContent = `${state.clipboard.mode === 'cut' ? 'Recortados' : 'Copiados'}: ${state.clipboard.items.length}`;
    } else {
      $('statusClipboard').classList.add('hidden');
    }
  }

  function hasAnySubdirWriteRule(path) {
    const pa = state.user?.path_access || {};
    return Object.entries(pa).some(([rp, rm]) => rm === 'rw' && (path === rp || path.startsWith(rp + '/')));
  }

  // ==================== ABRIR / VISUALIZAR FOTOS, MÚSICAS, VÍDEOS & TEXTOS ====================
  function openPhotoViewer(item) {
    const photos = sortedItems().filter((i) => !i.is_dir && isImageExt(i.ext));
    const idx = Math.max(0, photos.findIndex((p) => p.path === item.path));
    state.lightbox = { list: photos, index: idx, zoomed: false };
    renderLightboxPhoto();
  }

  function renderLightboxPhoto() {
    const lb = state.lightbox;
    const photo = lb.list[lb.index];
    if (!photo) return;
    const src = mediaUrl(photo.path, true);
    const hasMany = lb.list.length > 1;
    showModal(`📷 ${photo.name}`, `
      <div class="lightbox-wrap">
        <div class="lightbox-stage ${lb.zoomed ? 'zoom-scroll' : ''}" id="lightboxStage">
          ${hasMany ? '<button type="button" class="lightbox-nav prev" id="lbPrev" title="Foto anterior">‹</button>' : ''}
          <img id="lightboxImg" class="lightbox-img ${lb.zoomed ? 'zoomed' : ''}" src="${src}" alt="${escapeHtml(photo.name)}" />
          ${hasMany ? '<button type="button" class="lightbox-nav next" id="lbNext" title="Próxima foto">›</button>' : ''}
        </div>
        <div class="lightbox-bar">
          <span>Foto <strong>${lb.index + 1}</strong> de <strong>${lb.list.length}</strong> • ${formatBytes(photo.size)} • ${formatDate(photo.mtime)}</span>
          <button type="button" class="btn-sm" id="lbZoomBtn">${lb.zoomed ? '🔍 Ajustar à tela' : '🔍 Ampliar Zoom'}</button>
        </div>
      </div>
    `, [
      ...(hasMany ? [
        { text: '◀ Anterior', cls: 'btn-secondary', onClick: () => stepLightbox(-1) },
        { text: 'Próxima ▶', cls: 'btn-secondary', onClick: () => stepLightbox(1) }
      ] : []),
      { text: '⬇️ Baixar', cls: 'btn-secondary', onClick: () => downloadItem(photo) },
      { text: 'Fechar', cls: 'btn-primary', onClick: closeModal }
    ], true);

    const prevBtn = $('lbPrev');
    const nextBtn = $('lbNext');
    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); stepLightbox(-1); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); stepLightbox(1); };

    const zoomBtn = $('lbZoomBtn');
    const imgEl = $('lightboxImg');
    const toggleZoom = () => {
      state.lightbox.zoomed = !state.lightbox.zoomed;
      imgEl?.classList.toggle('zoomed', state.lightbox.zoomed);
      $('lightboxStage')?.classList.toggle('zoom-scroll', state.lightbox.zoomed);
      if (zoomBtn) zoomBtn.textContent = state.lightbox.zoomed ? '🔍 Ajustar à tela' : '🔍 Ampliar Zoom';
    };
    if (zoomBtn) zoomBtn.onclick = toggleZoom;
    if (imgEl) {
      imgEl.onclick = toggleZoom;
      imgEl.onerror = () => {
        const stg = $('lightboxStage');
        if (stg) stg.innerHTML = `<div style="color:#fff;padding:24px;text-align:center">Não foi possível pré-visualizar este formato no navegador.<br/><button class="btn-primary" style="margin-top:12px" id="lbFallbackDl">Baixar Arquivo</button></div>`;
        $('lbFallbackDl')?.addEventListener('click', () => downloadItem(photo));
      };
    }

    // Suporte a gesto swipe horizontal no celular
    const stage = $('lightboxStage');
    if (stage && hasMany) {
      let touchStartX = 0;
      stage.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches?.[0]?.clientX || 0;
      }, { passive: true });
      stage.addEventListener('touchend', (e) => {
        const endX = e.changedTouches?.[0]?.clientX || 0;
        const dx = endX - touchStartX;
        if (Math.abs(dx) > 45) stepLightbox(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
  }

  function stepLightbox(delta) {
    const lb = state.lightbox;
    if (!lb.list.length) return;
    lb.index = (lb.index + delta + lb.list.length) % lb.list.length;
    lb.zoomed = false;
    renderLightboxPhoto();
  }

  function openVideoViewer(item) {
    const src = mediaUrl(item.path, true);
    showModal(`🎬 ${item.name}`, `
      <div>
        <video id="modalVideoPlayer" class="video-player" controls autoplay playsinline src="${src}"></video>
        <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">
          Reprodução direta do QNAP sem baixar • ${formatBytes(item.size)}
        </div>
      </div>
    `, [
      { text: '⬇️ Baixar Vídeo', cls: 'btn-secondary', onClick: () => downloadItem(item) },
      { text: 'Fechar', cls: 'btn-primary', onClick: closeModal }
    ], true);
  }

  function playAudioItem(item, explicitList = null) {
    const tracks = explicitList || sortedItems().filter((i) => !i.is_dir && isAudioExt(i.ext));
    const list = tracks.length ? tracks : [item];
    const idx = Math.max(0, list.findIndex((t) => t.path === item.path));
    state.audio = { playlist: list, index: idx };
    loadCurrentAudioTrack(true);
  }

  function loadCurrentAudioTrack(autoPlay = true) {
    const { playlist, index } = state.audio;
    const track = playlist[index];
    const audio = $('globalAudio');
    const bar = $('audioPlayerBar');
    if (!track || !audio || !bar) return;

    bar.classList.remove('hidden');
    $('audioTrackTitle').textContent = track.name;
    $('audioTrackSub').textContent = `Faixa ${index + 1} de ${playlist.length} • ${formatBytes(track.size)} • Tocando do QNAP`;
    audio.src = mediaUrl(track.path, true);
    if (autoPlay) {
      audio.play().catch(() => toast('Toque em ▶ no player para iniciar o áudio.', 'info'));
    }

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.name,
          artist: 'ServLynx QNAP NAS',
          album: currentPath() || '/'
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => stepAudioTrack(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => stepAudioTrack(1));
      } catch { /* ignore */ }
    }
  }

  function stepAudioTrack(delta) {
    const { playlist, index } = state.audio;
    if (!playlist.length) return;
    state.audio.index = (index + delta + playlist.length) % playlist.length;
    loadCurrentAudioTrack(true);
  }

  function openAudioPlaylistModal() {
    const { playlist, index } = state.audio;
    if (!playlist.length) return;
    showModal('🎵 Playlist da Pasta Atual', `
      <div class="upload-queue-list" style="max-height:55vh">
        ${playlist.map((t, i) => `
          <div class="upload-q-row" style="align-items:center;padding:8px 4px;cursor:pointer;${i === index ? 'background:#eff6ff;font-weight:700;color:#0067c0' : ''}" data-track-idx="${i}">
            <span>${i === index ? '🔊' : '🎵'} ${escapeHtml(t.name)}</span>
            <span style="color:var(--text-muted)">${formatBytes(t.size)}</span>
          </div>
        `).join('')}
      </div>
    `, [{ text: 'Fechar', cls: 'btn-primary', onClick: closeModal }]);
    $('modalBody').querySelectorAll('[data-track-idx]').forEach((row) => {
      row.onclick = () => {
        state.audio.index = Number(row.dataset.trackIdx);
        loadCurrentAudioTrack(true);
        closeModal();
      };
    });
  }

  async function openItem(item) {
    if (item.is_dir) {
      navigateTo(item.path);
      return;
    }
    const ext = (item.ext || '').toLowerCase();
    if (isImageExt(ext)) {
      openPhotoViewer(item);
      return;
    }
    if (isAudioExt(ext)) {
      playAudioItem(item);
      return;
    }
    if (isVideoExt(ext)) {
      openVideoViewer(item);
      return;
    }
    if (ext === 'pdf') {
      const src = mediaUrl(item.path, true);
      showModal(item.name, `
        <iframe src="${src}" style="width:100%;height:70vh;border:1px solid var(--border);border-radius:6px"></iframe>
      `, [
        { text: '⬇️ Baixar PDF', cls: 'btn-secondary', onClick: () => downloadItem(item) },
        { text: 'Fechar', cls: 'btn-primary', onClick: closeModal }
      ], true);
      return;
    }
    if (isTextExt(ext) && (item.size || 0) <= 2 * 1024 * 1024) {
      try {
        toast('Abrindo arquivo...', 'info');
        const res = await apiFetch('preview', { query: `path=${encodeURIComponent(item.path)}` });
        const canSave = state.user?.role === 'admin' || (item.access_mode ? item.access_mode === 'rw' : canWriteCurrentDir());
        showModal(`Editor: ${item.name}`, `
          <textarea id="editorArea" class="text-editor" ${canSave ? '' : 'readonly'}>${escapeHtml(res.content || '')}</textarea>
        `, [
          ...(canSave ? [{
            text: 'Salvar no QNAP',
            cls: 'btn-primary',
            onClick: async () => {
              try {
                await apiFetch('save_text', { json: { path: item.path, content: $('editorArea').value } });
                toast('Arquivo salvo com sucesso no QNAP!', 'ok');
                closeModal();
                loadDirectory(currentPath());
              } catch (e) { toast(e.message, 'err'); }
            }
          }] : []),
          { text: 'Baixar', cls: 'btn-secondary', onClick: () => downloadItem(item) },
          { text: 'Fechar', cls: 'btn-secondary', onClick: closeModal }
        ], true);
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    downloadItem(item);
  }

  function downloadItem(item) {
    toast(`Preparando download de "${item.name}"...`);
    const url = `${API_URL}?route=download&path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(state.token)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = item.is_dir ? `${item.name}.zip` : item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function renderDetailsPane() {
    const pane = $('detailsContent');
    const sel = getSelectedItems();
    if (sel.length !== 1) {
      pane.innerHTML = `<div class="details-empty">${sel.length > 1 ? sel.length + ' itens selecionados' : 'Selecione um item para ver os detalhes.'}</div>`;
      return;
    }
    const item = sel[0];
    const meta = getFileMeta(item);
    let previewHtml = `<div class="details-preview-icon">${meta.ico}</div>`;
    if (!item.is_dir && isImageExt(item.ext)) {
      previewHtml = `<img class="details-preview-img" src="${mediaUrl(item.path, true)}" alt="${escapeHtml(item.name)}" />`;
    } else if (!item.is_dir && isAudioExt(item.ext)) {
      previewHtml = `<div style="margin:8px 0"><audio controls preload="none" style="width:100%" src="${mediaUrl(item.path, true)}"></audio></div>`;
    }
    pane.innerHTML = `
      ${previewHtml}
      <div style="font-weight:700;font-size:14px;word-break:break-word;text-align:center">${escapeHtml(item.name)}</div>
      <div style="text-align:center;color:var(--text-muted);font-size:12px;margin-top:3px">${escapeHtml(meta.type)}</div>
      <div class="details-kv">
        <div class="details-row"><span>Caminho</span><span>${escapeHtml(item.path)}</span></div>
        <div class="details-row"><span>Tamanho</span><span>${item.is_dir ? 'Pasta' : formatBytes(item.size)}</span></div>
        <div class="details-row"><span>Modificado</span><span>${formatDate(item.mtime)}</span></div>
        <div class="details-row"><span>Permissões</span><span>${escapeHtml(item.mode || 'rwxr-xr-x')}</span></div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-direction:column">
        <button class="btn-primary" id="detOpenBtn">${item.is_dir ? 'Abrir Pasta' : isAudioExt(item.ext) ? '🎵 Tocar Música' : isImageExt(item.ext) ? '📷 Ver Foto' : 'Abrir / Visualizar'}</button>
        <button class="btn-secondary" id="detOpenLocalBtn">💻 Abrir no PC (Drive sem baixar)</button>
        <button class="btn-secondary" id="detDlBtn">⬇️ Baixar ${item.is_dir ? '(ZIP)' : ''}</button>
        ${item.is_dir ? '<button class="btn-secondary" id="detMapDriveBtn">💿 Mapear esta Pasta como Drive (PC)</button>' : ''}
        ${(item.is_dir && canAdminShareDirs()) ? '<button class="btn-secondary" id="detShareBtn">🤝 Compartilhar com Usuário</button>' : ''}
      </div>
    `;
    $('detOpenBtn').onclick = () => openItem(item);
    if ($('detOpenLocalBtn')) $('detOpenLocalBtn').onclick = () => openItemInLocalDrive(item);
    $('detDlBtn').onclick = () => downloadItem(item);
    if ($('detMapDriveBtn')) $('detMapDriveBtn').onclick = () => openDriveModal(item.path);
    if ($('detShareBtn')) $('detShareBtn').onclick = () => openShareForPath(item.path);
  }

  // ==================== OPERAÇÕES DE ARQUIVO ====================
  function openNewFolderModal() {
    const cp = currentPath();
    if (cp === '/') {
      openNewShareModal();
      return;
    }
    showModal('Nova Pasta no QNAP', `
      <div class="form-group">
        <label>Local</label>
        <input type="text" value="${escapeHtml(cp)}" disabled />
      </div>
      <div class="form-group">
        <label>Nome da nova pasta</label>
        <input type="text" id="newFolderName" value="Nova pasta" autofocus />
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Criar Pasta',
        cls: 'btn-primary',
        onClick: async () => {
          const name = $('newFolderName').value.trim();
          if (!name) return;
          try {
            await apiFetch('mkdir', { json: { path: cp, name } });
            toast(`Pasta "${name}" criada!`, 'ok');
            closeModal();
            loadDirectory(cp);
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
    setTimeout(() => $('newFolderName')?.select(), 60);
  }

  function openNewFileModal() {
    const cp = currentPath();
    if (cp === '/') {
      toast('Abra uma pasta compartilhada antes de criar um arquivo.', 'err');
      return;
    }
    showModal('Novo Arquivo de Texto', `
      <div class="form-group">
        <label>Nome do arquivo</label>
        <input type="text" id="newFileName" value="novo_documento.txt" />
      </div>
      <div class="form-group">
        <label>Conteúdo inicial (opcional)</label>
        <textarea id="newFileContent" rows="5"></textarea>
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Criar Arquivo',
        cls: 'btn-primary',
        onClick: async () => {
          const name = $('newFileName').value.trim();
          if (!name) return;
          try {
            await apiFetch('touch', { json: { path: cp, name, content: $('newFileContent').value } });
            toast(`Arquivo "${name}" criado!`, 'ok');
            closeModal();
            loadDirectory(cp);
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  }

  function openRenameModal() {
    const sel = getSelectedItems();
    if (sel.length !== 1) return;
    const item = sel[0];
    showModal('Renomear', `
      <div class="form-group">
        <label>Novo nome para "${escapeHtml(item.name)}"</label>
        <input type="text" id="renameInput" value="${escapeHtml(item.name)}" />
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Salvar',
        cls: 'btn-primary',
        onClick: async () => {
          const newName = $('renameInput').value.trim();
          if (!newName || newName === item.name) { closeModal(); return; }
          try {
            await apiFetch('rename', { json: { path: item.path, new_name: newName } });
            toast('Renomeado com sucesso!', 'ok');
            closeModal();
            loadDirectory(currentPath());
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
    setTimeout(() => $('renameInput')?.select(), 60);
  }

  async function doDeleteSelected() {
    const sel = getSelectedItems();
    if (!sel.length) return;
    const names = sel.map((i) => i.name).slice(0, 5).join(', ') + (sel.length > 5 ? ` e mais ${sel.length - 5}` : '');
    showModal('Confirmar Exclusão', `
      <p>Tem certeza que deseja excluir permanentemente <strong>${sel.length}</strong> ${sel.length === 1 ? 'item' : 'itens'} no QNAP?</p>
      <p style="color:var(--text-muted);font-size:12px">${escapeHtml(names)}</p>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Excluir Permanentemente',
        cls: 'btn-danger',
        onClick: async () => {
          try {
            await apiFetch('delete', { json: { paths: sel.map((i) => i.path) } });
            toast('Itens excluídos do QNAP.', 'ok');
            closeModal();
            loadDirectory(currentPath());
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  }

  let directPasteTargetDest = null;
  let contextMenuTargetDir = null;

  function buildShareSelectOptions(preferredDest) {
    const shares = (state.sharesCache || []).map((s) => '/' + (s.name || '').replace(/^\/+/, ''));
    const fallbackShares = shares.length ? shares : ['/Public', '/Multimedia', '/Musica', '/Lynx', '/Download'];
    const optionsList = [];
    if (preferredDest && preferredDest !== '/') {
      optionsList.push({ value: preferredDest, label: `Pasta destino: ${preferredDest}` });
    }
    const pa = state.user?.path_access || {};
    Object.entries(pa).forEach(([subPath, mode]) => {
      if (mode === 'rw' && subPath !== preferredDest && !optionsList.some((o) => o.value === subPath)) {
        optionsList.push({ value: subPath, label: `${subPath} (Subpasta RW)` });
      }
    });
    fallbackShares.forEach((sp) => {
      if (sp !== '/' && sp !== preferredDest && !optionsList.some((o) => o.value === sp)) {
        optionsList.push({ value: sp, label: sp });
      }
    });
    return optionsList;
  }

  async function runInternalTransferModal(route, sources, destPath, onAfterSuccess = null) {
    const opLabel = route === 'move' ? 'Movendo' : 'Copiando';
    showModal(`📦 ${opLabel} no QNAP`, `
      <p style="margin-top:0"><strong>${opLabel}</strong> ${sources.length} item(ns) para <code>${escapeHtml(destPath)}</code>...</p>
      <div class="progress-track"><div class="progress-fill" id="intTxFill" style="width:65%"></div></div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:8px">Aguarde a conclusão no servidor NAS...</div>
    `, []);
    try {
      await apiFetch(route, { json: { sources, dest: destPath } });
      const fill = $('intTxFill');
      if (fill) fill.style.width = '100%';
      if (typeof onAfterSuccess === 'function') onAfterSuccess();
      toast(`${opLabel === 'Movendo' ? 'Movido(s)' : 'Copiado(s)'} para ${destPath}!`, 'ok');
      closeModal();
      loadDirectory(currentPath());
    } catch (e) {
      closeModal();
      toast(e.message, 'err');
    }
  }

  async function runLiveTransferModal({ rawEntries = [], fallbackFiles = [], preExtracted = null, destPath }) {
    if (!hasAnyWriteAccess()) {
      toast('Sua conta não possui permissão de envio/escrita.', 'err');
      return;
    }
    if (!destPath || destPath === '/') {
      toast('Escolha uma pasta compartilhada de destino.', 'err');
      return;
    }

    let cancelled = false;
    showModal(`📦 Transferindo para ${destPath}`, `
      <div style="font-size:13px;font-weight:600;margin-bottom:6px" id="txStatusText">Analisando pastas e arquivos...</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px" id="txDetailText">Preparando transferência para <code>${escapeHtml(destPath)}</code></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600">
        <span id="txStepLabel">Lendo estrutura</span>
        <span id="txPctLabel">0%</span>
      </div>
      <div class="progress-track"><div class="progress-fill" id="txFillBar" style="width:5%"></div></div>
      <div id="txErrorBox" class="login-error hidden" style="margin-top:10px;margin-bottom:0"></div>
    `, [
      {
        text: 'Cancelar',
        cls: 'btn-secondary',
        onClick: () => {
          cancelled = true;
          const st = $('txStatusText');
          if (st) st.textContent = 'Cancelando transferência...';
        }
      }
    ]);

    const setStatus = (title, detail, step, pct) => {
      if ($('txStatusText')) $('txStatusText').textContent = title;
      if ($('txDetailText')) $('txDetailText').textContent = detail;
      if ($('txStepLabel')) $('txStepLabel').textContent = step;
      if ($('txPctLabel') && pct !== null) $('txPctLabel').textContent = Math.round(pct) + '%';
      if ($('txFillBar') && pct !== null) $('txFillBar').style.width = Math.max(2, Math.min(100, pct)) + '%';
    };

    try {
      const extracted = preExtracted || await extractDropUploadEntries(rawEntries, fallbackFiles, (scan) => {
        setStatus(
          'Analisando pastas e subpastas...',
          `${scan.filesCount} arquivo(s) e ${scan.dirsCount} pasta(s) encontrados${scan.currentName ? ' • ' + scan.currentName : ''}`,
          'Lendo origem',
          8
        );
      });

      const rawFiles = extracted.rawFiles || [];
      const rawDirs = extracted.rawDirs || [];

      if (!rawFiles.length && !rawDirs.length) {
        if ($('txErrorBox')) {
          $('txErrorBox').textContent = 'Nenhum arquivo ou pasta acessível foi detectado neste item. Use "Colar Pasta / Selecionar Pasta" caso o Windows tenha restringido o arrasto.';
          $('txErrorBox').classList.remove('hidden');
        }
        setStatus('Nada para transferir', 'Selecione uma pasta ou arquivos válidos.', 'Concluído', 0);
        return;
      }

      const ensuredDirs = new Set();
      for (let dIdx = 0; dIdx < rawDirs.length; dIdx++) {
        if (cancelled) break;
        const relDir = rawDirs[dIdx];
        const pct = rawFiles.length ? 10 + Math.round(((dIdx + 1) / Math.max(1, rawDirs.length)) * 10) : Math.round(((dIdx + 1) / rawDirs.length) * 100);
        setStatus(
          `Criando pasta (${dIdx + 1}/${rawDirs.length})...`,
          relDir,
          'Criando diretórios no QNAP',
          pct
        );
        await ensureRelativePathDirs(destPath, relDir, ensuredDirs);
      }

      const totalBytes = rawFiles.reduce((acc, f) => acc + Number(f?.size || f?.file?.size || 0), 0);
      let uploadedBytes = 0;
      let okCount = 0;
      const errors = [];

      for (let i = 0; i < rawFiles.length; i++) {
        if (cancelled) break;
        const rf = rawFiles[i];
        const fileName = rf?.name || rf?.file?.name || `arquivo_${i + 1}`;
        const fileSize = Number(rf?.size || rf?.file?.size || 0);
        const relDir = rf?.relDir || '';

        const baseFrac = totalBytes > 0 ? (uploadedBytes / totalBytes) : (i / Math.max(1, rawFiles.length));
        setStatus(
          `Enviando ${i + 1} de ${rawFiles.length}: ${fileName}`,
          `${relDir ? 'Pasta: ' + relDir + ' • ' : ''}${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`,
          `Arquivo ${i + 1}/${rawFiles.length}`,
          Math.min(98, 20 + baseFrac * 78)
        );

        try {
          const item = rf?.blob ? rf : await prepareUploadEntry(rf.file || rf, relDir);
          const itemDest = item.relDir ? await ensureRelativePathDirs(destPath, item.relDir, ensuredDirs) : destPath;
          await uploadSingleFileXhr(item, itemDest, (frac) => {
            const curLoaded = uploadedBytes + fileSize * frac;
            const totFrac = totalBytes > 0 ? (curLoaded / totalBytes) : ((i + frac) / Math.max(1, rawFiles.length));
            const pct = Math.min(99, 20 + totFrac * 79);
            if ($('txPctLabel')) $('txPctLabel').textContent = Math.round(pct) + '%';
            if ($('txFillBar')) $('txFillBar').style.width = pct + '%';
          });
          okCount++;
        } catch (err) {
          errors.push(`${fileName}: ${err?.message || 'erro ao enviar'}`);
        }
        uploadedBytes += fileSize;
      }

      if (cancelled) {
        toast(`Transferência cancelada (${okCount} enviado(s)).`, 'info');
        closeModal();
        loadDirectory(currentPath());
        return;
      }

      if (errors.length) {
        setStatus(
          `Concluído com ${errors.length} falha(s)`,
          `${okCount} arquivo(s) enviado(s) e ${rawDirs.length} pasta(s) verificada(s).`,
          'Finalizado',
          100
        );
        if ($('txErrorBox')) {
          $('txErrorBox').innerHTML = escapeHtml(errors.slice(0, 5).join(' | '));
          $('txErrorBox').classList.remove('hidden');
        }
        $('modalFooter').innerHTML = '';
        const btnOk = document.createElement('button');
        btnOk.className = 'btn-primary';
        btnOk.textContent = 'Fechar';
        btnOk.onclick = closeModal;
        $('modalFooter').appendChild(btnOk);
        loadDirectory(currentPath());
        return;
      }

      setStatus(
        'Transferência concluída!',
        `${okCount} arquivo(s) e ${rawDirs.length} pasta(s) copiados para ${destPath}`,
        '100%',
        100
      );
      toast(`✅ ${okCount || rawDirs.length} item(ns) transferido(s) para ${destPath}!`, 'ok');
      closeModal();
      loadDirectory(currentPath());
    } catch (err) {
      if ($('txErrorBox')) {
        $('txErrorBox').textContent = err?.message || 'Falha durante a transferência';
        $('txErrorBox').classList.remove('hidden');
      }
      toast(err?.message || 'Erro ao transferir', 'err');
    }
  }

  async function handleExternalTransfer(rawEntries, fallbackFiles, destPath) {
    if (!hasAnyWriteAccess()) {
      toast('Sua conta não possui permissão de envio/escrita.', 'err');
      return;
    }
    if (!destPath || destPath === '/') {
      showModal('📂 Lendo pasta selecionada...', `
        <p style="margin-top:0">Listando arquivos e subpastas para escolher o destino no QNAP...</p>
        <div class="progress-track"><div class="progress-fill" style="width:45%"></div></div>
      `, []);
      try {
        const { rawFiles, rawDirs } = await extractDropUploadEntries(rawEntries, fallbackFiles);
        closeModal();
        if (!rawFiles.length && !rawDirs.length) {
          toast('Nenhum item acessível foi encontrado na seleção.', 'err');
          return;
        }
        openUploadModal(rawFiles, rawDirs);
      } catch (err) {
        closeModal();
        toast(err.message, 'err');
      }
      return;
    }
    await runLiveTransferModal({ rawEntries, fallbackFiles, destPath });
  }

  async function handleDropEventPayload(e, destPath, internalOp = 'move') {
    const internalRaw = e.dataTransfer?.getData('application/x-servlynx-paths') || '';
    // IMPORTANTE: ler entries e files de forma síncrona antes de qualquer await
    const rawEntries = Array.from(e.dataTransfer?.items || [])
      .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    const fallbackFiles = Array.from(e.dataTransfer?.files || []);

    if (internalRaw) {
      let sources = [];
      try { sources = JSON.parse(internalRaw); } catch {}
      if (!sources.length) return;
      if (!hasAnyWriteAccess()) {
        toast('Sem permissão para mover/copiar neste destino.', 'err');
        return;
      }
      if (!destPath || destPath === '/') {
        toast('Solte sobre uma pasta compartilhada do QNAP.', 'info');
        return;
      }
      const isSelfOrChild = sources.some((s) => destPath === s || destPath.startsWith(s + '/'));
      if (isSelfOrChild) {
        toast('Não é possível mover ou copiar uma pasta para dentro dela mesma.', 'err');
        return;
      }
      await runInternalTransferModal(internalOp, sources, destPath);
      return;
    }

    if (!rawEntries.length && !fallbackFiles.length) return;
    await handleExternalTransfer(rawEntries, fallbackFiles, destPath);
  }

  function openExplorerPasteModal(targetDest = null) {
    if (!canWriteCurrentDir() && !hasAnyWriteAccess()) {
      toast('Sua conta não possui permissão de envio/escrita.', 'err');
      return;
    }
    const opts = buildShareSelectOptions(targetDest && targetDest !== '/' ? targetDest : currentPath());
    showModal('📌 Colar Pasta ou Arquivos no QNAP', `
      <div class="upload-dest-box">
        <div class="form-group" style="margin-bottom:0">
          <label for="pasteDestFolder">Pasta de destino no QNAP</label>
          <select id="pasteDestFolder">
            ${opts.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <p style="font-size:12.5px;color:var(--text-muted);margin:10px 0 12px">
        Por segurança dos navegadores web, pastas copiadas com <strong>Ctrl+C</strong> no Windows Explorer podem exigir seleção direta ou arraste para iniciar a cópia completa de subpastas:
      </p>
      <div class="upload-pick-grid" style="grid-template-columns:1fr 1fr">
        <button type="button" class="upload-pick-btn" id="btnPastePickFolder">
          <span class="upload-pick-ico">📂</span>
          <span>Colar / Enviar Pasta Completa</span>
        </button>
        <button type="button" class="upload-pick-btn" id="btnPastePickFiles">
          <span class="upload-pick-ico">📄</span>
          <span>Colar / Enviar Arquivos</span>
        </button>
      </div>
      <div style="margin-top:12px;padding:10px;border:1px dashed var(--primary);border-radius:8px;background:#f8fafc;text-align:center;font-size:12px;color:#334155" id="pasteDropHintBox">
        💡 Dica: você também pode <strong>arrastar a pasta direto do Explorer</strong> para cima de qualquer pasta aqui ou usar <strong>Ctrl+V</strong> após copiar imagens/arquivos.
      </div>
    `, [
      { text: 'Fechar', cls: 'btn-secondary', onClick: closeModal }
    ]);

    const getChosenDest = () => $('pasteDestFolder')?.value || '/Public';
    $('btnPastePickFolder').onclick = () => {
      directPasteTargetDest = getChosenDest();
      $('folderUploadInput').click();
    };
    $('btnPastePickFiles').onclick = () => {
      directPasteTargetDest = getChosenDest();
      $('fileUploadInput').click();
    };
    bindFolderDropTarget($('pasteDropHintBox'), getChosenDest);
  }

  async function doPaste(explicitTarget = null) {
    if (!canWriteCurrentDir() && !hasAnyWriteAccess()) {
      toast('Sua conta não possui permissão de envio/escrita.', 'err');
      return;
    }
    const targetDest = explicitTarget || currentPath();
    if (state.clipboard.items.length > 0) {
      if (targetDest === '/') {
        toast('Abra uma pasta compartilhada para colar os itens do QNAP.', 'info');
        return;
      }
      const route = state.clipboard.mode === 'cut' ? 'move' : 'copy';
      await runInternalTransferModal(route, state.clipboard.items, targetDest, () => {
        if (state.clipboard.mode === 'cut') state.clipboard = { mode: null, items: [] };
        updateToolbarButtons();
      });
      return;
    }
    openExplorerPasteModal(targetDest);
  }

  async function openPropertiesModal() {
    const sel = getSelectedItems();
    if (sel.length !== 1) return;
    const item = sel[0];
    showModal(`Propriedades: ${item.name}`, `<p>Calculando tamanho e detalhes no QNAP...</p>`, [
      { text: 'Fechar', cls: 'btn-secondary', onClick: closeModal }
    ]);
    try {
      const res = await apiFetch('properties', { query: `path=${encodeURIComponent(item.path)}` });
      const p = res.properties || {};
      $('modalBody').innerHTML = `
        <div class="details-kv" style="margin-top:0;border:none">
          <div class="details-row"><span>Nome</span><span>${escapeHtml(item.name)}</span></div>
          <div class="details-row"><span>Caminho Completo</span><span>/share/CACHEDEV1_DATA${escapeHtml(item.path)}</span></div>
          <div class="details-row"><span>Tipo</span><span>${escapeHtml(getFileMeta(item).type)}</span></div>
          <div class="details-row"><span>Tamanho Total</span><span>${escapeHtml(p.size_human || formatBytes(item.size))}</span></div>
          <div class="details-row"><span>Arquivos / Subpastas</span><span>${p.files_count ?? '—'} arquivos / ${p.dirs_count ?? '—'} pastas</span></div>
          <div class="details-row"><span>Modificado em</span><span>${formatDate(item.mtime)}</span></div>
          <div class="details-row"><span>Permissões Linux</span><span>${escapeHtml(p.mode || item.mode || '—')}</span></div>
          <div class="details-row"><span>Proprietário</span><span>${escapeHtml(p.owner || 'admin')}</span></div>
        </div>
      `;
    } catch (e) {
      $('modalBody').innerHTML = `<div class="login-error">${escapeHtml(e.message)}</div>`;
    }
  }

  const MAX_MEMORY_BLOB_BYTES = 150 * 1024 * 1024;
  let pendingUploadFiles = [];
  let pendingUploadDirs = [];

  function normalizeRelDir(rawDir) {
    return String(rawDir || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.replace(/[\/\\:*?"<>|]/g, '').trim())
      .filter((s) => s && s !== '.' && s !== '..')
      .join('/');
  }

  function getFileRelDir(file) {
    const wrp = String(file?.webkitRelativePath || '');
    if (!wrp || !wrp.includes('/')) return '';
    const parts = wrp.split('/');
    parts.pop();
    return normalizeRelDir(parts.join('/'));
  }

  async function readBlobAsArrayBuffer(blob) {
    if (typeof blob.arrayBuffer === 'function') {
      return await blob.arrayBuffer();
    }
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('Falha ao ler arquivo'));
      fr.readAsArrayBuffer(blob);
    });
  }

  async function prepareUploadEntry(file, explicitRelDir = null) {
    const relDir = explicitRelDir !== null ? normalizeRelDir(explicitRelDir) : getFileRelDir(file);
    const mime = file?.type || 'application/octet-stream';
    try {
      let blob;
      let size = Number(file?.size || 0);
      if (size <= MAX_MEMORY_BLOB_BYTES) {
        const buf = await readBlobAsArrayBuffer(file);
        size = buf.byteLength;
        blob = new Blob([buf], { type: mime });
      } else {
        await readBlobAsArrayBuffer(file.slice(0, Math.min(64, size)));
        blob = file;
      }
      return {
        name: file.name,
        size,
        type: mime,
        blob,
        relDir
      };
    } catch {
      throw new Error(`Não foi possível ler "${file?.name || 'item'}" (verifique se é uma pasta vazia/bloqueada ou se o arquivo está aberto em outro programa).`);
    }
  }

  async function prepareUploadEntries(rawItems) {
    const prepared = [];
    for (const raw of (rawItems || [])) {
      if (raw && raw.blob) {
        prepared.push(raw);
        continue;
      }
      const file = raw && raw.file ? raw.file : raw;
      const relDir = raw && 'relDir' in raw ? raw.relDir : null;
      if (!file) continue;
      try {
        prepared.push(await prepareUploadEntry(file, relDir));
      } catch (err) {
        toast(err.message, 'err');
      }
    }
    return prepared;
  }

  function readAllDirectoryEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (!batch || !batch.length) resolve(all);
          else {
            all.push(...batch);
            readBatch();
          }
        }, reject);
      };
      readBatch();
    });
  }

  function addCumulativeDirs(relDir, dirsSet) {
    const clean = normalizeRelDir(relDir);
    if (!clean) return;
    const segs = clean.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      dirsSet.add(acc);
    }
  }

  async function traverseWebkitEntry(entry, parentRelDir, outFiles, dirsSet, onScanProgress) {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      outFiles.push({
        file,
        name: file.name,
        size: Number(file.size || 0),
        relDir: parentRelDir
      });
      if (onScanProgress) {
        onScanProgress({ filesCount: outFiles.length, dirsCount: dirsSet.size, currentName: file.name });
      }
    } else if (entry.isDirectory) {
      const nextDir = parentRelDir ? `${parentRelDir}/${entry.name}` : entry.name;
      addCumulativeDirs(nextDir, dirsSet);
      if (onScanProgress) {
        onScanProgress({ filesCount: outFiles.length, dirsCount: dirsSet.size, currentName: entry.name });
      }
      const children = await readAllDirectoryEntries(entry.createReader());
      for (const child of children) {
        await traverseWebkitEntry(child, nextDir, outFiles, dirsSet, onScanProgress);
      }
    }
  }

  async function extractDropUploadEntries(rawEntries, fallbackFiles, onScanProgress = null) {
    const outFiles = [];
    const dirsSet = new Set();
    if (rawEntries && rawEntries.length) {
      for (const entry of rawEntries) {
        try {
          await traverseWebkitEntry(entry, '', outFiles, dirsSet, onScanProgress);
        } catch (err) {
          toast(`Não foi possível ler "${entry?.name || 'item'}": ${err?.message || 'acesso negado'}`, 'err');
        }
      }
    } else {
      for (const f of (fallbackFiles || [])) {
        const relDir = getFileRelDir(f);
        if (relDir) addCumulativeDirs(relDir, dirsSet);
        outFiles.push({
          file: f,
          name: f.name,
          size: Number(f.size || 0),
          relDir
        });
      }
    }
    const rawDirs = Array.from(dirsSet).sort((a, b) => a.split('/').length - b.split('/').length);
    return { rawFiles: outFiles, rawDirs };
  }

  async function ensureRelativePathDirs(baseDest, relDir, ensuredSet) {
    let curr = String(baseDest || '/').replace(/\/+$/, '') || '/';
    const cleanRel = normalizeRelDir(relDir);
    if (!cleanRel) return curr;
    const segments = cleanRel.split('/').filter(Boolean);
    for (const seg of segments) {
      const next = (curr === '/' ? '' : curr) + '/' + seg;
      if (!ensuredSet.has(next)) {
        try {
          await apiFetch('mkdir', { json: { path: curr, name: seg } });
        } catch (err) {
          if (!String(err?.message || '').toLowerCase().includes('existe')) {
            throw err;
          }
        }
        ensuredSet.add(next);
      }
      curr = next;
    }
    return curr;
  }

  function openUploadModal(initialFiles = null, initialDirs = []) {
    if (!canWriteCurrentDir() && !hasAnyWriteAccess()) {
      toast('Sua conta não possui permissão de envio/escrita.', 'err');
      return;
    }
    pendingUploadFiles = initialFiles ? Array.from(initialFiles) : [];
    pendingUploadDirs = initialDirs ? Array.from(new Set(initialDirs.filter(Boolean))) : [];
    const cp = currentPath();
    const optionsList = buildShareSelectOptions(cp !== '/' && canWriteCurrentDir() ? cp : null);

    showModal('⬆️ Enviar Fotos e Arquivos para o QNAP', `
      <div class="upload-dest-box">
        <div class="form-group" style="margin-bottom:10px">
          <label for="upDestFolder">Pasta de destino no QNAP</label>
          <select id="upDestFolder">
            ${optionsList.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label for="upSubfolder">Criar ou enviar para subpasta (opcional)</label>
          <input type="text" id="upSubfolder" placeholder="Ex: Fotos_Celular (deixe vazio para enviar direto na pasta)" />
        </div>
      </div>

      <div class="upload-pick-grid">
        <button type="button" class="upload-pick-btn" id="btnPickGallery">
          <span class="upload-pick-ico">🖼️</span>
          <span>Fotos e Vídeos (Galeria)</span>
        </button>
        <button type="button" class="upload-pick-btn" id="btnPickCamera">
          <span class="upload-pick-ico">📷</span>
          <span>Tirar Foto (Câmera)</span>
        </button>
        <button type="button" class="upload-pick-btn" id="btnPickAnyFile">
          <span class="upload-pick-ico">📄</span>
          <span>Qualquer Arquivo</span>
        </button>
        <button type="button" class="upload-pick-btn" id="btnPickFolder">
          <span class="upload-pick-ico">📂</span>
          <span>Enviar Pasta</span>
        </button>
      </div>

      <div id="upQueueWrap" class="${(pendingUploadFiles.length || pendingUploadDirs.length) ? '' : 'hidden'}">
        <div style="font-weight:600;font-size:12px;margin-bottom:6px" id="upQueueTitle"></div>
        <div class="upload-queue-list" id="upQueueList"></div>
      </div>

      <div id="upProgressWrap" class="hidden">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600">
          <span id="upProgressLabel">Enviando...</span>
          <span id="upProgressPct">0%</span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="upProgressFill"></div></div>
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: '⬆️ Enviar para o QNAP',
        cls: 'btn-primary',
        onClick: startModalUpload
      }
    ]);

    renderPendingUploadQueue();
    $('btnPickGallery').onclick = () => $('photoUploadInput').click();
    $('btnPickCamera').onclick = () => $('cameraUploadInput').click();
    $('btnPickAnyFile').onclick = () => $('fileUploadInput').click();
    $('btnPickFolder').onclick = () => $('folderUploadInput').click();
  }

  function appendPendingUploadFiles(preparedList, extraDirs = []) {
    const arr = Array.from(preparedList || []);
    const dirs = Array.from(new Set((extraDirs || []).filter(Boolean)));
    if (!arr.length && !dirs.length) return;
    pendingUploadFiles = pendingUploadFiles.concat(arr);
    pendingUploadDirs = Array.from(new Set(pendingUploadDirs.concat(dirs)));
    if ($('modalBackdrop').classList.contains('hidden') || !$('upDestFolder')) {
      openUploadModal(pendingUploadFiles, pendingUploadDirs);
    } else {
      renderPendingUploadQueue();
    }
  }

  function renderPendingUploadQueue() {
    const wrap = $('upQueueWrap');
    const list = $('upQueueList');
    const title = $('upQueueTitle');
    if (!wrap || !list || !title) return;
    if (!pendingUploadFiles.length && !pendingUploadDirs.length) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    const total = pendingUploadFiles.reduce((acc, f) => acc + (f.size || 0), 0);
    const dirNote = pendingUploadDirs.length ? ` • ${pendingUploadDirs.length} pasta(s)` : '';
    title.textContent = `${pendingUploadFiles.length} arquivo(s) pronto(s) (${formatBytes(total)}${dirNote}):`;
    const fileRows = pendingUploadFiles.map((f, idx) => {
      const display = f.relDir ? `${f.relDir}/${f.name}` : f.name;
      return `
        <div class="upload-q-row">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(display)}</span>
          <span style="color:var(--text-muted);flex-shrink:0">${formatBytes(f.size)} <button type="button" data-rm-up="${idx}" style="border:none;background:none;color:var(--danger);cursor:pointer;font-weight:700">✕</button></span>
        </div>
      `;
    }).join('');
    const dirRows = (!pendingUploadFiles.length ? pendingUploadDirs : []).map((d) => `
      <div class="upload-q-row">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📂 ${escapeHtml(d)}</span>
        <span style="color:var(--text-muted);flex-shrink:0">Pasta</span>
      </div>
    `).join('');
    list.innerHTML = fileRows + dirRows;
    list.querySelectorAll('[data-rm-up]').forEach((b) => {
      b.onclick = () => {
        pendingUploadFiles.splice(Number(b.dataset.rmUp), 1);
        renderPendingUploadQueue();
      };
    });
  }

  function uploadSingleFileXhr(item, targetPath, onPct) {
    const payload = item?.blob || item;
    const fileName = item?.name || payload?.name || 'arquivo';
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('path', targetPath);
      form.append('files[]', payload, fileName);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}?route=upload`);
      if (state.token) xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onPct) onPct(ev.loaded / Math.max(1, ev.total));
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300 && data.ok) resolve(data);
          else reject(new Error((data.errors && data.errors.join('; ')) || data.error || `Erro HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`Resposta inválida ao enviar ${fileName}`));
        }
      };
      xhr.onerror = () => reject(new Error(`Falha de rede/acesso ao enviar ${fileName}`));
      xhr.send(form);
    });
  }

  async function startModalUpload() {
    if (!pendingUploadFiles.length && !pendingUploadDirs.length) {
      toast('Selecione pelo menos uma foto, arquivo ou pasta primeiro.', 'err');
      return;
    }
    let dest = $('upDestFolder')?.value || currentPath();
    const sub = normalizeRelDir($('upSubfolder')?.value || '');
    if (dest === '/') {
      toast('Escolha uma pasta compartilhada de destino.', 'err');
      return;
    }

    const progWrap = $('upProgressWrap');
    const progLbl = $('upProgressLabel');
    const progPct = $('upProgressPct');
    const progFill = $('upProgressFill');
    if (progWrap) progWrap.classList.remove('hidden');
    $('modalFooter').querySelectorAll('button').forEach((b) => { b.disabled = true; });

    try {
      const rawItems = Array.from(pendingUploadFiles);
      const ensuredDirs = new Set();
      if (sub) {
        if (progLbl) progLbl.textContent = `Criando pasta "${sub}"...`;
        dest = await ensureRelativePathDirs(dest, sub, ensuredDirs);
      }

      for (const relDir of pendingUploadDirs) {
        if (progLbl) progLbl.textContent = `Preparando pasta "${relDir}"...`;
        await ensureRelativePathDirs(dest, relDir, ensuredDirs);
      }

      const uploadedNames = [];
      for (let i = 0; i < rawItems.length; i++) {
        const raw = rawItems[i];
        const rawName = raw?.name || raw?.file?.name || `arquivo_${i + 1}`;
        if (progLbl) progLbl.textContent = `Preparando ${i + 1} de ${rawItems.length}: ${rawName}`;
        const item = raw?.blob ? raw : await prepareUploadEntry(raw.file || raw, 'relDir' in raw ? raw.relDir : null);
        const itemDest = item.relDir ? await ensureRelativePathDirs(dest, item.relDir, ensuredDirs) : dest;
        await uploadSingleFileXhr(item, itemDest, (frac) => {
          const pct = Math.min(99, Math.round(((i + frac) / rawItems.length) * 100));
          if (progLbl) progLbl.textContent = `Enviando ${i + 1} de ${rawItems.length}: ${item.name}`;
          if (progPct) progPct.textContent = pct + '%';
          if (progFill) progFill.style.width = pct + '%';
        });
        uploadedNames.push(item.name);
      }

      if (progPct) progPct.textContent = '100%';
      if (progFill) progFill.style.width = '100%';
      const msg = uploadedNames.length
        ? `${uploadedNames.length} arquivo(s) enviado(s) para ${dest}!`
        : `${pendingUploadDirs.length} pasta(s) criada(s) em ${dest}!`;
      toast(msg, 'ok');
      pendingUploadFiles = [];
      pendingUploadDirs = [];
      closeModal();
      navigateTo(dest);
    } catch (err) {
      toast(err.message, 'err');
      $('modalFooter').querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  }

  async function handleFileUpload(fileListOrEntries, forcedDest = null, extraDirs = []) {
    if (!hasAnyWriteAccess()) {
      toast('Sua conta não possui permissão de envio/escrita.', 'err');
      return;
    }
    const itemsArr = Array.from(fileListOrEntries || []).map((raw) => {
      if (raw && (raw.blob || raw.file)) return raw;
      const relDir = getFileRelDir(raw);
      return { file: raw, name: raw.name, size: Number(raw.size || 0), relDir };
    });
    const dirsSet = new Set(extraDirs || []);
    itemsArr.forEach((it) => {
      if (it.relDir) addCumulativeDirs(it.relDir, dirsSet);
    });
    const dirs = Array.from(dirsSet).sort((a, b) => a.split('/').length - b.split('/').length);
    const dest = forcedDest || currentPath();
    if (dest === '/') {
      openUploadModal(itemsArr, dirs);
      return;
    }
    if (!itemsArr.length && !dirs.length) return;
    await runLiveTransferModal({
      preExtracted: { rawFiles: itemsArr, rawDirs: dirs },
      destPath: dest
    });
  }

  async function doSearch(query) {
    const q = query.trim();
    if (!q) return;
    $('loadingBar').classList.remove('hidden');
    state.searchActive = true;
    state.searchQuery = q;
    $('searchBanner').classList.remove('hidden');
    $('searchBannerText').textContent = `Pesquisando por "${q}" em ${currentPath()}...`;
    try {
      const res = await apiFetch('search', { query: `path=${encodeURIComponent(currentPath())}&q=${encodeURIComponent(q)}` });
      state.items = res.items || [];
      $('searchBannerText').textContent = `Resultados para "${q}" (${state.items.length} encontrado(s))`;
      renderFiles();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      $('loadingBar').classList.add('hidden');
    }
  }

  // ==================== MONITOR QNAP ====================
  async function loadMonitorView() {
    $('monitorCards').innerHTML = '<p>Consultando hardware do QNAP em tempo real...</p>';
    try {
      const res = await apiFetch('qnap_status');
      const s = res.status || {};
      state.qnapStatus = s;
      updateBridgeBadge(res.bridge_online !== false);

      const memUsed = s.memory ? `${s.memory.used_mb} MB / ${s.memory.total_mb} MB (${s.memory.percent}%)` : '—';
      const diskUsed = s.disk ? `${s.disk.used_human} / ${s.disk.total_human} (${s.disk.percent}%)` : '—';

      $('monitorCards').innerHTML = `
        <div class="stat-card">
          <div class="stat-label">Modelo &amp; Firmware</div>
          <div class="stat-value">${escapeHtml(s.model || 'TS-231P')}</div>
          <div class="stat-sub">Host: ${escapeHtml(s.hostname || 'NAS09534B')} • QTS ${escapeHtml(s.firmware || '4.3.6')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">CPU &amp; Carga</div>
          <div class="stat-value">${escapeHtml(s.cpu_load || '—')}</div>
          <div class="stat-sub">Uptime: ${escapeHtml(s.uptime || '—')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Memória RAM</div>
          <div class="stat-value">${s.memory ? s.memory.percent + '%' : '—'}</div>
          <div class="stat-sub">${escapeHtml(memUsed)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Volume Principal</div>
          <div class="stat-value">${s.disk ? s.disk.percent + '%' : '—'}</div>
          <div class="stat-sub">${escapeHtml(diskUsed)} • Livre: ${escapeHtml(s.disk?.avail_human || '--')}</div>
        </div>
      `;

      const disksHtml = (s.physical_disks || []).map((d) => `
        <div class="details-row" style="padding:8px 0;border-bottom:1px solid #f1f5f9">
          <span><strong>Baia ${d.bay}</strong> (${escapeHtml(d.dev)}) — ${escapeHtml(d.model)}</span>
          <span>${escapeHtml(d.size)} • 🌡️ ${d.temp || '--'}°C</span>
        </div>
      `).join('') || '<p style="color:var(--text-muted)">Informações de discos físicos indisponíveis.</p>';

      $('monitorDisks').innerHTML = `
        ${disksHtml}
        <div style="margin-top:12px;font-size:12px;color:var(--text-muted)">
          RAID: <strong>${escapeHtml(s.raid_summary || '/dev/md1 (RAID 1)')}</strong>
        </div>
      `;

      const svcs = s.services || {};
      $('monitorServices').innerHTML = `
        <div class="details-row"><span>IP na Rede Local</span><span>${escapeHtml(s.ip || '192.168.15.44')}</span></div>
        <div class="details-row"><span>Endereço MAC</span><span>${escapeHtml(s.mac || '24:5E:BE:09:53:4B')}</span></div>
        <div class="details-row"><span>Compartilhamento SMB (Samba)</span><span class="badge ${svcs.smb ? 'badge-ok' : 'badge-off'}">${svcs.smb ? 'Ativo' : 'Parado'}</span></div>
        <div class="details-row"><span>Servidor SSH (Porta 22)</span><span class="badge ${svcs.ssh ? 'badge-ok' : 'badge-off'}">${svcs.ssh ? 'Ativo' : 'Parado'}</span></div>
        <div class="details-row"><span>Interface Web QTS (8080)</span><span class="badge ${svcs.web ? 'badge-ok' : 'badge-off'}">${svcs.web ? 'Ativo' : 'Parado'}</span></div>
        <div class="details-row"><span>Agente ServLynx Bridge</span><span class="badge ${res.bridge_online !== false ? 'badge-ok' : 'badge-off'}">${res.bridge_online !== false ? 'Conectado' : 'Cache'}</span></div>
      `;
    } catch (e) {
      $('monitorCards').innerHTML = `<div class="login-error">${escapeHtml(e.message)}</div>`;
    }
  }

  // ==================== COMPARTILHAMENTOS (SHARES) & ACL ====================
  let usersListCache = [];
  let qnapUsersCache = [];

  async function ensureUsersAndSharesLoaded() {
    if (!qnapUsersCache.length || !state.sharesCache.length || !usersListCache.length) {
      const res = await apiFetch('users');
      usersListCache = res.users || [];
      qnapUsersCache = res.qnap_users || [];
      if (Array.isArray(res.shares) && res.shares.length) {
        state.sharesCache = res.shares;
      }
    }
  }

  function renderAclSelect(attrs, selected = 'none', disabled = false) {
    const val = selected || 'none';
    return `
      <select class="access-select" ${attrs} ${disabled ? 'disabled' : ''}>
        <option value="rw" ${val === 'rw' ? 'selected' : ''}>✅ Leitura e Escrita (RW)</option>
        <option value="ro" ${val === 'ro' ? 'selected' : ''}>👁️ Somente Leitura (RO)</option>
        <option value="none" ${val === 'none' ? 'selected' : ''}>🚫 Sem Acesso</option>
      </select>
    `;
  }

  function computeQnapUserModeForShare(qUser, shareObj) {
    if (qUser?.username === 'admin') return 'rw';
    if (qUser?.share_access && shareObj?.name in qUser.share_access) {
      return qUser.share_access[shareObj.name];
    }
    const uname = qUser?.username || '';
    const vUsers = shareObj?.valid_users || [];
    const wList = shareObj?.write_list || [];
    const rList = shareObj?.read_list || [];
    const invList = shareObj?.invalid_users || [];
    const groups = ['everyone', ...(qUser?.is_admin ? ['administrators'] : [])].map((g) => '@' + g);
    if (invList.includes(uname) || groups.some((gt) => invList.includes(gt))) return 'none';
    const isValid = vUsers.includes(uname) || groups.some((gt) => vUsers.includes(gt));
    if (!isValid) return 'none';
    if (wList.includes(uname) || groups.some((gt) => wList.includes(gt))) return 'rw';
    if (rList.includes(uname) || groups.some((gt) => rList.includes(gt))) return 'ro';
    return rList.length === 0 ? 'rw' : 'ro';
  }

  function renderShareAclSummary(s) {
    const pills = [];
    if (s.everyone_access === 'rw') pills.push('<span class="access-pill rw">🌐 Todos: RW</span>');
    else if (s.everyone_access === 'ro') pills.push('<span class="access-pill ro">🌐 Todos: Leitura</span>');
    const writes = (s.write_list || []).filter((u) => u && u !== 'root' && !u.startsWith('@'));
    const reads = (s.read_list || []).filter((u) => u && u !== 'root' && !u.startsWith('@') && !writes.includes(u));
    writes.forEach((u) => pills.push(`<span class="access-pill rw">👤 ${escapeHtml(u)}: RW</span>`));
    reads.forEach((u) => pills.push(`<span class="access-pill ro">👁️ ${escapeHtml(u)}: RO</span>`));
    if (!pills.length) {
      (s.valid_users || []).filter((u) => u && u !== 'root' && !u.startsWith('@')).forEach((u) => {
        pills.push(`<span class="access-pill rw">👤 ${escapeHtml(u)}</span>`);
      });
    }
    return pills.join('') || '<span class="access-pill none">Somente root/admin</span>';
  }

  async function loadSharesView() {
    $('sharesTbody').innerHTML = '<tr><td colspan="5">Carregando compartilhamentos do QNAP...</td></tr>';
    if ($('subdirSharesTbody')) {
      $('subdirSharesTbody').innerHTML = '<tr><td colspan="4">Carregando subdiretórios compartilhados...</td></tr>';
    }
    try {
      const [res, subRes] = await Promise.all([
        apiFetch('shares'),
        apiFetch('subdir_access').catch(() => ({ ok: true, subdirs: [] }))
      ]);
      const shares = res.shares || [];
      state.sharesCache = shares;
      renderSidebarShares(shares);
      $('sharesTbody').innerHTML = shares.map((s) => `
        <tr>
          <td><strong>🗄️ ${escapeHtml(s.name)}</strong></td>
          <td><code>${escapeHtml(s.nas_path || ('/share/CACHEDEV1_DATA/' + s.name))}</code></td>
          <td>${escapeHtml(s.comment || '—')}</td>
          <td style="max-width:260px;white-space:normal">${renderShareAclSummary(s)}</td>
          <td>
            <div style="display:flex;gap:5px;flex-wrap:wrap">
              <button class="btn-sm" onclick="window.__openShare('${escapeHtml(s.name)}')">Abrir Pasta</button>
              <button class="btn-sm" onclick="window.__editShareAccess('${escapeHtml(s.name)}')">🔐 Controlar Acesso</button>
              <button class="btn-sm" onclick="window.__editSubdirAccess('/${escapeHtml(s.name)}')">🤝 Subpastas</button>
              <button class="btn-danger-sm" onclick="window.__deleteShare('${escapeHtml(s.name)}')">Remover</button>
            </div>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="5">Nenhum compartilhamento encontrado.</td></tr>';

      const subdirs = (subRes?.subdirs || []).filter((sd) => sd.path.split('/').filter(Boolean).length >= 2);
      if ($('subdirSharesTbody')) {
        $('subdirSharesTbody').innerHTML = subdirs.map((sd) => {
          const pills = (sd.users || []).map((u) => {
            const cls = u.mode === 'rw' ? 'rw' : (u.mode === 'ro' ? 'ro' : 'none');
            const lbl = u.mode === 'rw' ? 'RW' : (u.mode === 'ro' ? 'RO' : 'Bloq');
            return `<span class="access-pill ${cls}">👤 ${escapeHtml(u.name || u.email)}: ${lbl}</span>`;
          }).join('') || '<span class="access-pill none">Sem regras</span>';
          return `
            <tr>
              <td><strong>📂 ${escapeHtml(sd.path)}</strong></td>
              <td><span class="badge badge-user">${escapeHtml(sd.parent_share || '—')}</span></td>
              <td style="max-width:300px;white-space:normal">${pills}</td>
              <td>
                <div style="display:flex;gap:5px;flex-wrap:wrap">
                  <button class="btn-sm" onclick="window.__openSubdirPath('${escapeHtml(sd.path)}')">Abrir Pasta</button>
                  <button class="btn-sm" onclick="window.__editSubdirAccess('${escapeHtml(sd.path)}')">🤝 Editar Acesso</button>
                  <button class="btn-danger-sm" onclick="window.__deleteSubdirAccess('${escapeHtml(sd.path)}')">Remover</button>
                </div>
              </td>
            </tr>
          `;
        }).join('') || '<tr><td colspan="4" style="color:var(--text-muted)">Nenhum subdiretório compartilhado especificamente ainda. Clique em <strong>🤝 Compartilhar Subdiretório</strong> acima ou no botão direito de qualquer subpasta no Explorador.</td></tr>';
      }
    } catch (e) {
      $('sharesTbody').innerHTML = `<tr><td colspan="5"><div class="login-error">${escapeHtml(e.message)}</div></td></tr>`;
    }
  }

  window.__openShare = (name) => navigateTo('/' + name);
  window.__openSubdirPath = (path) => navigateTo(path);

  window.__editShareAccess = async (shareName) => {
    try {
      usersListCache = [];
      await ensureUsersAndSharesLoaded();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    const shareObj = state.sharesCache.find((s) => s.name === shareName) || { name: shareName, everyone_access: 'none' };
    const evMode = shareObj.everyone_access || 'none';
    const qUsers = qnapUsersCache || [];
    const pUsers = usersListCache || [];
    const allShareNames = state.sharesCache.map((s) => s.name);

    const resolveUnifiedMode = (pu) => {
      const pa = pu.path_access || {};
      if (pa['/' + shareName] && ['rw', 'ro', 'none'].includes(pa['/' + shareName])) {
        return pa['/' + shareName];
      }
      const allowedPortal = (pu.allowed_shares || []).includes('*') || (pu.allowed_shares || []).includes(shareName);
      if (!allowedPortal) return 'none';
      const linkedQu = qUsers.find((qu) => qu.username && pu.nas_username && qu.username.toLowerCase() === pu.nas_username.toLowerCase());
      if (linkedQu) {
        const qMode = computeQnapUserModeForShare(linkedQu, shareObj);
        if (qMode === 'ro' || qMode === 'rw') return qMode;
      }
      return pu.permissions?.write ? 'rw' : (pu.permissions?.read ? 'ro' : 'none');
    };

    const orphanQnap = qUsers.filter((qu) => !pUsers.some((pu) => pu.nas_username && qu.username && pu.nas_username.toLowerCase() === qu.username.toLowerCase()));

    showModal(`🔐 Controlar Acesso à Pasta: ${shareName}`, `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;padding:8px 10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
        <span style="font-size:12px;color:#1e3a8a">As permissões abaixo atualizam automaticamente o <strong>Portal Web, Disco L: e QNAP SMB</strong> em um único lugar.</span>
        <button type="button" class="btn-sm" id="btnShareSubdirFromRoot">📂 Compartilhar Subdiretório de "${escapeHtml(shareName)}"...</button>
      </div>

      <div class="form-group">
        <label>Acesso Geral na Rede QNAP (@everyone / SMB)</label>
        <select id="shEveryoneAccess">
          <option value="none" ${evMode === 'none' ? 'selected' : ''}>🔒 Restrito (apenas usuários autorizados abaixo)</option>
          <option value="rw" ${evMode === 'rw' ? 'selected' : ''}>✏️ Todos os usuários do QNAP (Leitura e Escrita)</option>
          <option value="ro" ${evMode === 'ro' ? 'selected' : ''}>👁️ Todos os usuários do QNAP (Somente Leitura)</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom:${orphanQnap.length ? '14px' : '0'}">
        <label>Usuários do Sistema (Portal Web, Disco L: e QNAP SMB)</label>
        <div class="access-matrix-list">
          ${pUsers.map((pu) => {
            const isPortalAdmin = pu.role === 'admin' || (pu.email || '').toLowerCase() === 'edsonmanoel2012@gmail.com';
            const curMode = isPortalAdmin ? 'rw' : resolveUnifiedMode(pu);
            return `
              <div class="access-row">
                <div class="access-row-info">
                  <span class="access-row-title">${escapeHtml(pu.name)} ${isPortalAdmin ? '<span class="badge badge-admin">Admin Total</span>' : ''}</span>
                  <span class="access-row-sub">${escapeHtml(pu.email)}${pu.nas_username ? ' • QNAP: ' + escapeHtml(pu.nas_username) : ''}</span>
                </div>
                ${isPortalAdmin ? '<span class="access-pill rw">Acesso Total (RW *)</span>' : `
                  <select class="access-select" data-sh-unified-u="${escapeHtml(pu.id)}">
                    <option value="rw" ${curMode === 'rw' ? 'selected' : ''}>✅ Leitura e Escrita (RW)</option>
                    <option value="ro" ${curMode === 'ro' ? 'selected' : ''}>👁️ Somente Leitura (RO)</option>
                    <option value="none" ${curMode === 'none' ? 'selected' : ''}>🚫 Sem Acesso (Bloqueado)</option>
                  </select>
                `}
              </div>
            `;
          }).join('') || '<p style="font-size:12px;color:var(--text-muted);margin:4px">Nenhum usuário cadastrado.</p>'}
        </div>
      </div>

      ${orphanQnap.length ? `
        <div class="form-group" style="margin-bottom:0">
          <label>Contas Exclusivas do Sistema QNAP</label>
          <div class="access-matrix-list">
            ${orphanQnap.map((qu) => {
              const curMode = computeQnapUserModeForShare(qu, shareObj);
              const isSysAdmin = qu.username === 'admin';
              return `
                <div class="access-row">
                  <div class="access-row-info">
                    <span class="access-row-title">👤 ${escapeHtml(qu.username)} ${qu.is_admin ? '<span class="badge badge-admin">Admin QNAP</span>' : ''}</span>
                    <span class="access-row-sub">${escapeHtml(qu.comment || (qu.group || 'everyone'))}</span>
                  </div>
                  ${renderAclSelect(`data-sh-qu="${escapeHtml(qu.username)}"`, curMode, isSysAdmin)}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: '💾 Salvar Permissões da Pasta',
        cls: 'btn-primary',
        onClick: async () => {
          const user_access = {};
          document.querySelectorAll('[data-sh-unified-u]').forEach((sel) => {
            user_access[sel.dataset.shUnifiedU] = sel.value;
          });
          const qnap_access = {};
          document.querySelectorAll('[data-sh-qu]').forEach((sel) => {
            qnap_access[sel.dataset.shQu] = sel.value;
          });
          try {
            await apiFetch('shares', {
              method: 'POST',
              json: {
                op: 'set_access',
                name: shareName,
                everyone_access: $('shEveryoneAccess').value,
                user_access,
                qnap_access,
                all_shares: allShareNames
              }
            });
            toast(`Permissões da pasta "${shareName}" salvas no Portal e no QNAP!`, 'ok');
            closeModal();
            qnapUsersCache = [];
            usersListCache = [];
            await ensureUsersAndSharesLoaded().catch(() => {});
            loadSharesView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ], true);

    $('btnShareSubdirFromRoot').onclick = () => {
      closeModal();
      openSubdirAccessModal('/' + shareName);
    };
  };

  function openShareForPath(targetPath = null) {
    const p = targetPath || currentPath();
    openSubdirAccessModal(p);
  }

  window.__editSubdirAccess = (initialPath = '') => openSubdirAccessModal(initialPath);

  window.__deleteSubdirAccess = (subPath) => {
    showModal('Remover Compartilhamento do Subdiretório', `
      <p>Deseja remover todas as regras específicas de acesso para o subdiretório <strong>${escapeHtml(subPath)}</strong>?</p>
      <p style="font-size:12px;color:var(--text-muted)">Os arquivos no disco do QNAP não serão apagados; os usuários voltarão a seguir a permissão da pasta pai.</p>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Remover Regras',
        cls: 'btn-danger',
        onClick: async () => {
          try {
            await apiFetch('subdir_access', { method: 'DELETE', json: { path: subPath } });
            toast(`Regras removidas para ${subPath}.`, 'ok');
            usersListCache = [];
            closeModal();
            loadSharesView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  };

  async function openSubdirAccessModal(initialPath = '') {
    try {
      usersListCache = [];
      await ensureUsersAndSharesLoaded();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    const shareNames = state.sharesCache.length ? state.sharesCache.map((s) => s.name) : ['Public', 'Lynx', 'Download'];
    let curPath = String(initialPath || '').trim() || (currentPath() !== '/' ? currentPath() : '/' + shareNames[0]);
    if (!curPath.startsWith('/')) curPath = '/' + curPath;
    const initRoot = curPath.split('/').filter(Boolean)[0] || shareNames[0];
    const pUsers = (usersListCache || []).filter((u) => u.role !== 'admin' && (u.email || '').toLowerCase() !== 'edsonmanoel2012@gmail.com');

    showModal('🤝 Compartilhar Subdiretório com Usuário Específico', `
      <div class="subdir-picker-bar">
        <div style="font-size:12px;font-weight:700;color:#0f172a">1. Escolha ou digite o Subdiretório no QNAP</div>
        <div class="subdir-picker-row">
          <div class="form-group" style="margin-bottom:0">
            <label for="subRootSelect">Pasta Compartilhada Raiz</label>
            <select id="subRootSelect">
              ${shareNames.map((sn) => `<option value="${escapeHtml(sn)}" ${sn === initRoot ? 'selected' : ''}>🗄️ ${escapeHtml(sn)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label for="subChildSelect">Navegar em Subpastas Existentes</label>
            <select id="subChildSelect">
              <option value="">Carregando subpastas...</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label for="subSharePathInput">Caminho do Subdiretório (ex: /Servidor Eco/Comercial)</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="subSharePathInput" value="${escapeHtml(curPath)}" placeholder="/PastaRaiz/Subpasta" style="flex:1" />
            <button type="button" class="btn-sm" id="btnSubUp" title="Subir um nível">↑ Subir</button>
            <button type="button" class="btn-sm" id="btnSubRefresh" title="Recarregar subpastas e matriz">↻</button>
          </div>
        </div>
        <div id="subRootHintWrap" class="hidden" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:4px">
          <span style="font-size:11.5px;color:#9d5d00">Você selecionou apenas a pasta raiz. Escolha ou digite uma <strong>/Subpasta</strong> acima, ou configure a pasta raiz inteira:</span>
          <button type="button" class="btn-sm" id="btnSwitchToRootAcl">🔐 Permissões da Pasta Raiz</button>
        </div>
        <label class="perm-check" style="background:#fff">
          <input type="checkbox" id="chkSubCreateIfMissing" checked /> Criar subdiretório automaticamente no QNAP caso ainda não exista
        </label>
      </div>

      <div class="quick-share-user-box">
        <div style="font-size:12px;font-weight:700;color:#1e3a8a">2. Liberar para Usuário Específico</div>
        <div class="quick-share-controls">
          <select id="subQuickUserSelect">
            ${pUsers.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)} (${escapeHtml(u.email)})</option>`).join('') || '<option value="">Nenhum usuário comum cadastrado</option>'}
          </select>
          <select id="subQuickModeSelect">
            <option value="rw">✅ Leitura e Escrita (RW)</option>
            <option value="ro">👁️ Somente Leitura (RO)</option>
            <option value="none">🚫 Bloquear neste subdiretório</option>
            <option value="inherit">🔁 Herdar da pasta pai</option>
          </select>
          <button type="button" class="btn-primary" id="btnApplyQuickShare">Aplicar ao Usuário</button>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:0">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <label style="margin:0">3. Permissões de Todos os Usuários neste Subdiretório</label>
          <input type="text" id="subUserSearchInput" placeholder="Filtrar usuário..." style="width:190px;padding:4px 8px;font-size:12px" />
        </div>
        <div id="subUsersMatrixList" class="access-matrix-list">
          <p style="font-size:12px;color:var(--text-muted);margin:6px">Carregando matriz de permissões...</p>
        </div>
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: '💾 Salvar Compartilhamento do Subdiretório',
        cls: 'btn-primary',
        onClick: async () => {
          const targetPath = '/' + ($('subSharePathInput')?.value || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
          const segs = targetPath.split('/').filter(Boolean);
          if (segs.length < 2) {
            toast('Informe ou selecione um subdiretório (ex: /Servidor Eco/Comercial).', 'err');
            return;
          }
          const portal_access = {};
          document.querySelectorAll('[data-sub-pu]').forEach((sel) => {
            portal_access[sel.dataset.subPu] = sel.value;
          });
          try {
            const res = await apiFetch('subdir_access', {
              json: {
                path: targetPath,
                create_if_missing: $('chkSubCreateIfMissing')?.checked ?? true,
                portal_access
              }
            });
            if (Array.isArray(res.users)) usersListCache = res.users;
            toast(`Compartilhamento de "${targetPath}" salvo com sucesso!`, 'ok');
            closeModal();
            if (state.currentSection === 'qnap-shares') loadSharesView();
            else if (state.currentSection === 'qnap-users') loadUsersView();
            else loadDirectory(currentPath());
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ], true);

    const normalizeModalPath = (p) => '/' + String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');

    const syncRootHint = (norm) => {
      const segs = norm.split('/').filter(Boolean);
      const wrap = $('subRootHintWrap');
      if (!wrap) return;
      if (segs.length === 1) {
        wrap.classList.remove('hidden');
        wrap.style.display = 'flex';
        $('btnSwitchToRootAcl').textContent = `🔐 Permissões da Pasta "${segs[0]}"`;
        $('btnSwitchToRootAcl').onclick = () => { closeModal(); window.__editShareAccess(segs[0]); };
      } else {
        wrap.classList.add('hidden');
        wrap.style.display = 'none';
      }
    };

    const loadSubfolderOptions = async (browsePath) => {
      const sel = $('subChildSelect');
      if (!sel) return;
      sel.innerHTML = '<option value="">Carregando subpastas...</option>';
      try {
        const res = await apiFetch('files', { query: `path=${encodeURIComponent(browsePath)}` });
        const dirs = (res.items || []).filter((i) => i.is_dir);
        sel.innerHTML = `<option value="">-- Subpastas dentro de ${escapeHtml(browsePath)} (${dirs.length}) --</option>`
          + dirs.map((d) => `<option value="${escapeHtml(d.path)}">📁 ${escapeHtml(d.name)}</option>`).join('');
      } catch {
        sel.innerHTML = '<option value="">(Digite o caminho no campo abaixo ou crie automaticamente)</option>';
      }
    };

    const modeBadgeLabel = (m) => (m === 'rw' ? 'RW (Leitura e Escrita)' : (m === 'ro' ? 'Somente Leitura' : 'Sem acesso'));

    const loadSubdirMatrix = async (norm) => {
      const box = $('subUsersMatrixList');
      if (!box) return;
      syncRootHint(norm);
      try {
        const res = await apiFetch('subdir_access', { query: `path=${encodeURIComponent(norm)}` });
        const rows = res.users_matrix || [];
        const filterQ = ($('subUserSearchInput')?.value || '').trim().toLowerCase();
        box.innerHTML = rows.map((u) => {
          const matchText = `${u.name} ${u.email} ${u.nas_username}`.toLowerCase();
          const hideRow = filterQ && !matchText.includes(filterQ);
          if (u.is_admin) {
            return `
              <div class="access-row ${hideRow ? 'hidden' : ''}" data-sub-row-text="${escapeHtml(matchText)}">
                <div class="access-row-info">
                  <span class="access-row-title">${escapeHtml(u.name)} <span class="badge badge-admin">Admin Total</span></span>
                  <span class="access-row-sub">${escapeHtml(u.email)}</span>
                </div>
                <span class="access-pill rw">Acesso Total (*)</span>
              </div>
            `;
          }
          const exp = u.explicit_mode || 'inherit';
          const inhLabel = modeBadgeLabel(u.inherited_mode || 'none');
          return `
            <div class="access-row ${hideRow ? 'hidden' : ''}" data-sub-uid="${escapeHtml(u.id)}" data-sub-row-text="${escapeHtml(matchText)}">
              <div class="access-row-info">
                <span class="access-row-title">${escapeHtml(u.name)}</span>
                <span class="access-row-sub">${escapeHtml(u.email)} • Na pasta pai: <strong>${escapeHtml(inhLabel)}</strong></span>
              </div>
              <select class="access-select" data-sub-pu="${escapeHtml(u.id)}">
                <option value="inherit" ${exp === 'inherit' ? 'selected' : ''}>🔁 Herdar (${escapeHtml(inhLabel)})</option>
                <option value="rw" ${exp === 'rw' ? 'selected' : ''}>✅ Leitura e Escrita (RW)</option>
                <option value="ro" ${exp === 'ro' ? 'selected' : ''}>👁️ Somente Leitura (RO)</option>
                <option value="none" ${exp === 'none' ? 'selected' : ''}>🚫 Bloqueado aqui</option>
              </select>
            </div>
          `;
        }).join('') || '<p style="font-size:12px;color:var(--text-muted);margin:6px">Nenhum usuário cadastrado.</p>';
      } catch (err) {
        box.innerHTML = `<div class="login-error">${escapeHtml(err.message)}</div>`;
      }
    };

    const onPathChanged = (rawPath) => {
      const norm = normalizeModalPath(rawPath);
      $('subSharePathInput').value = norm;
      const rootSeg = norm.split('/').filter(Boolean)[0];
      if (rootSeg && $('subRootSelect')) $('subRootSelect').value = rootSeg;
      loadSubfolderOptions(norm === '/' ? '/' + shareNames[0] : norm);
      loadSubdirMatrix(norm);
    };

    $('subRootSelect').onchange = () => onPathChanged('/' + $('subRootSelect').value);
    $('subChildSelect').onchange = () => {
      if ($('subChildSelect').value) onPathChanged($('subChildSelect').value);
    };
    $('btnSubUp').onclick = () => {
      const segs = normalizeModalPath($('subSharePathInput').value).split('/').filter(Boolean);
      if (segs.length > 1) {
        segs.pop();
        onPathChanged('/' + segs.join('/'));
      }
    };
    $('btnSubRefresh').onclick = () => onPathChanged($('subSharePathInput').value);

    let pathTimer = null;
    $('subSharePathInput').addEventListener('input', () => {
      clearTimeout(pathTimer);
      pathTimer = setTimeout(() => {
        const norm = normalizeModalPath($('subSharePathInput').value);
        syncRootHint(norm);
        loadSubdirMatrix(norm);
      }, 350);
    });

    $('subUserSearchInput').addEventListener('input', () => {
      const q = $('subUserSearchInput').value.trim().toLowerCase();
      document.querySelectorAll('[data-sub-row-text]').forEach((row) => {
        row.classList.toggle('hidden', !!q && !row.dataset.subRowText.includes(q));
      });
    });

    $('btnApplyQuickShare').onclick = () => {
      const uid = $('subQuickUserSelect')?.value;
      const mode = $('subQuickModeSelect')?.value || 'rw';
      if (!uid) {
        toast('Nenhum usuário selecionado.', 'err');
        return;
      }
      const sel = document.querySelector(`[data-sub-pu="${CSS.escape(uid)}"]`);
      const row = sel?.closest('.access-row');
      if (sel) {
        sel.value = mode;
        if (row) {
          row.classList.remove('highlight-flash');
          void row.offsetWidth;
          row.classList.add('highlight-flash');
          row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        toast('Permissão aplicada na lista! Clique em Salvar para confirmar.', 'info');
      }
    };

    onPathChanged(curPath);
  }
  window.__deleteShare = (name) => {
    showModal(`Remover Compartilhamento "${name}"`, `
      <p>Deseja remover o compartilhamento <strong>${escapeHtml(name)}</strong> do Samba/QNAP?</p>
      <label class="perm-check" style="margin-top:10px">
        <input type="checkbox" id="chkDeleteShareFiles" /> Também excluir permanentemente a pasta e os arquivos no disco do QNAP
      </label>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Remover',
        cls: 'btn-danger',
        onClick: async () => {
          try {
            await apiFetch('shares', {
              method: 'DELETE',
              json: { name, delete_data: $('chkDeleteShareFiles').checked }
            });
            toast(`Compartilhamento "${name}" removido.`, 'ok');
            closeModal();
            loadSharesView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  };

  function openNewShareModal() {
    showModal('Novo Compartilhamento QNAP (Share)', `
      <div class="form-group">
        <label>Nome do Compartilhamento (Pasta Raiz)</label>
        <input type="text" id="newShareName" placeholder="Ex: Projetos_2026" />
      </div>
      <div class="form-group">
        <label>Descrição / Comentário</label>
        <input type="text" id="newShareComment" value="Pasta criada pelo ServLynx Explorer" />
      </div>
      <p style="font-size:12px;color:var(--text-muted)">
        Isso criará a pasta em <code>/share/CACHEDEV1_DATA/&lt;Nome&gt;</code> e a registrará automaticamente no compartilhamento Samba do QNAP.
      </p>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Criar Compartilhamento',
        cls: 'btn-primary',
        onClick: async () => {
          const name = $('newShareName').value.trim();
          const comment = $('newShareComment').value.trim();
          if (!name) return;
          try {
            await apiFetch('shares', { method: 'POST', json: { name, comment } });
            toast(`Compartilhamento "${name}" criado no QNAP!`, 'ok');
            closeModal();
            if (state.currentSection === 'qnap-shares') loadSharesView();
            else loadDirectory('/');
            loadSharesSidebar();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  }

  // ==================== GERENCIAMENTO DE USUÁRIOS ====================
  function renderQnapUserAccessPills(qu) {
    const map = qu?.share_access || {};
    const entries = Object.entries(map).filter(([, mode]) => mode === 'rw' || mode === 'ro');
    if (!entries.length) {
      return '<span class="access-pill none">Nenhuma pasta configurada</span>';
    }
    return entries.map(([sh, mode]) => (
      `<span class="access-pill ${mode}">${escapeHtml(sh)}: ${mode.toUpperCase()}</span>`
    )).join('');
  }

  async function loadUsersView() {
    $('usersTbody').innerHTML = '<tr><td colspan="7">Carregando usuários...</td></tr>';
    $('qnapUsersTbody').innerHTML = '<tr><td colspan="5">Consultando usuários nativos do QNAP...</td></tr>';
    try {
      const res = await apiFetch('users');
      usersListCache = res.users || [];
      qnapUsersCache = res.qnap_users || [];
      if (Array.isArray(res.shares) && res.shares.length) {
        state.sharesCache = res.shares;
        renderSidebarShares(res.shares);
      }

      $('usersTbody').innerHTML = usersListCache.map((u) => {
        const isMaster = (u.email || '').toLowerCase() === 'edsonmanoel2012@gmail.com';
        const linkedQu = qnapUsersCache.find((q) => u.nas_username && q.username && q.username.toLowerCase() === u.nas_username.toLowerCase());
        const nasTag = u.nas_username
          ? `<div style="font-size:11px;color:var(--text-muted)">🗄️ QNAP: ${escapeHtml(u.nas_username)} ${linkedQu ? '<span style="color:#0f7b0f">✓</span>' : ''}</div>`
          : '';
        const extraContact = [
          (u.notify_email && u.notify_email !== u.email) ? `<div style="font-size:11px;color:var(--text-muted)">📧 ${escapeHtml(u.notify_email)}</div>` : '',
          u.phone ? `<div style="font-size:11px;color:var(--text-muted)">💬 ${escapeHtml(u.phone)}</div>` : ''
        ].join('');

        const sharePills = [];
        if ((u.allowed_shares || []).includes('*') || u.role === 'admin') {
          sharePills.push('<span class="access-pill rw">Todas (*)</span>');
        } else {
          (u.allowed_shares || []).forEach((sn) => {
            const paMode = (u.path_access || {})['/' + sn];
            const qMode = linkedQu?.share_access?.[sn];
            const m = paMode || qMode || (u.permissions?.write ? 'rw' : 'ro');
            const cls = m === 'ro' ? 'ro' : 'rw';
            sharePills.push(`<span class="access-pill ${cls}">${escapeHtml(sn)}: ${m.toUpperCase()}</span>`);
          });
        }
        Object.entries(u.path_access || {}).forEach(([subP, mode]) => {
          if (subP.split('/').filter(Boolean).length < 2) return;
          const cls = mode === 'rw' ? 'rw' : (mode === 'ro' ? 'ro' : 'none');
          const lbl = mode === 'rw' ? 'RW' : (mode === 'ro' ? 'RO' : 'Bloq');
          sharePills.push(`<span class="access-pill ${cls}">📂 ${escapeHtml(subP)}: ${lbl}</span>`);
        });
        const sharesHtml = sharePills.join('') || '<span class="access-pill none">Nenhuma</span>';

        const perms = u.permissions || {};
        const permsTxt = u.role === 'admin' ? 'Acesso Total' : [
          perms.read ? 'Ler' : '',
          perms.write ? 'Escrever' : '',
          perms.delete ? 'Excluir' : '',
          perms.manage_shares ? 'Shares' : '',
          perms.manage_qnap ? 'NAS' : ''
        ].filter(Boolean).join(', ') || 'Somente leitura';

        return `
          <tr>
            <td><strong>${escapeHtml(u.name)}</strong>${nasTag}</td>
            <td><div>${escapeHtml(u.email)}</div>${extraContact}</td>
            <td><span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}">${u.role === 'admin' ? 'Admin' : 'Usuário'}</span></td>
            <td style="max-width:260px;white-space:normal">${sharesHtml}</td>
            <td>${escapeHtml(permsTxt)}</td>
            <td><span class="badge ${u.active ? 'badge-ok' : 'badge-off'}">${u.active ? 'Ativo' : 'Bloqueado'}</span></td>
            <td>
              <div style="display:flex;gap:5px;flex-wrap:wrap">
                <button class="btn-sm" onclick="window.__editUser('${escapeHtml(u.id)}')">🔐 Editar &amp; Acessos</button>
                <button class="btn-sm" onclick="window.__sendUserCredentials('${escapeHtml(u.id)}')" title="Enviar login e senha por E-mail ou WhatsApp">📨 Enviar Acesso</button>
                ${(u.id !== state.user?.id && !isMaster) ? `<button class="btn-danger-sm" onclick="window.__deleteUser('${escapeHtml(u.id)}', '${escapeHtml(u.name)}')">Excluir</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');

      const unlinkedQnap = qnapUsersCache.filter((qu) => !usersListCache.some((u) => u.nas_username && qu.username && u.nas_username.toLowerCase() === qu.username.toLowerCase()));
      $('qnapUsersTbody').innerHTML = unlinkedQnap.map((qu) => `
        <tr>
          <td>
            <strong>👤 ${escapeHtml(qu.username)}</strong>
            ${qu.comment ? `<div style="font-size:11px;color:var(--text-muted)">${escapeHtml(qu.comment)}</div>` : ''}
          </td>
          <td>${escapeHtml(qu.uid)}</td>
          <td><span class="badge ${qu.is_admin ? 'badge-admin' : 'badge-user'}">${escapeHtml(qu.group || 'everyone')}</span></td>
          <td style="max-width:280px;white-space:normal">${renderQnapUserAccessPills(qu)}</td>
          <td>
            <div style="display:flex;gap:5px;flex-wrap:wrap">
              <button class="btn-sm" onclick="window.__editQnapUserAccess('${escapeHtml(qu.username)}')">🔐 Acessos &amp; Pastas</button>
              <button class="btn-sm" onclick="window.__changeQnapPass('${escapeHtml(qu.username)}')">🔑 Senha</button>
              ${qu.username !== 'admin' ? `<button class="btn-danger-sm" onclick="window.__deleteQnapUser('${escapeHtml(qu.username)}')">Remover</button>` : ''}
            </div>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="5" style="color:var(--text-muted)">Todos os usuários já estão unificados na tabela principal acima.</td></tr>';
    } catch (e) {
      $('usersTbody').innerHTML = `<tr><td colspan="7"><div class="login-error">${escapeHtml(e.message)}</div></td></tr>`;
    }
  }

  window.__editQnapUserAccess = async (username) => {
    try {
      await ensureUsersAndSharesLoaded();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    const qu = qnapUsersCache.find((u) => u.username === username) || { username, is_admin: username === 'admin', share_access: {} };
    const shares = state.sharesCache.length ? state.sharesCache : [{ name: 'Public' }, { name: 'Lynx' }, { name: 'Download' }];
    const isSysAdmin = username === 'admin';

    showModal(`🔐 Acessos no QNAP: ${username}`, `
      <label class="perm-check" style="margin-bottom:12px;background:#eef2ff;border-color:#c7d2fe">
        <input type="checkbox" id="quEditAdmin" ${qu.is_admin ? 'checked' : ''} ${isSysAdmin ? 'disabled' : ''} />
        Pertence ao grupo administradores do QNAP (administrators)
      </label>

      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        <strong style="font-size:12.5px">Permissão por Pasta Compartilhada (SMB/QNAP)</strong>
        ${!isSysAdmin ? `
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button type="button" class="btn-sm" data-qu-preset="rw">✅ Tudo RW</button>
            <button type="button" class="btn-sm" data-qu-preset="ro">👁️ Tudo Leitura</button>
            <button type="button" class="btn-sm" data-qu-preset="none">🚫 Bloquear Tudo</button>
          </div>
        ` : ''}
      </div>

      <div class="access-matrix-list">
        ${shares.map((sh) => {
          const cur = computeQnapUserModeForShare(qu, sh);
          return `
            <div class="access-row">
              <div class="access-row-info">
                <span class="access-row-title">🗄️ ${escapeHtml(sh.name)}</span>
                <span class="access-row-sub">${escapeHtml(sh.comment || sh.nas_path || '/share/CACHEDEV1_DATA/' + sh.name)}</span>
              </div>
              ${renderAclSelect(`data-qu-share="${escapeHtml(sh.name)}"`, cur, isSysAdmin)}
            </div>
          `;
        }).join('')}
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: '💾 Salvar Acessos do Usuário QNAP',
        cls: 'btn-primary',
        onClick: async () => {
          const share_access = {};
          document.querySelectorAll('[data-qu-share]').forEach((sel) => {
            share_access[sel.dataset.quShare] = sel.value;
          });
          try {
            await apiFetch('qnap_user', {
              json: {
                op: 'set_access',
                username,
                is_admin: $('quEditAdmin')?.checked,
                share_access
              }
            });
            toast(`Acessos de "${username}" atualizados no QNAP!`, 'ok');
            closeModal();
            loadUsersView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ], true);

    document.querySelectorAll('[data-qu-preset]').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('[data-qu-share]').forEach((sel) => {
          if (!sel.disabled) sel.value = btn.dataset.quPreset;
        });
      };
    });
  };

  function deriveQnapUsernameLocal(email, name) {
    let raw = String(email || '').trim();
    if (raw.includes('@')) raw = raw.split('@')[0];
    if (!raw) raw = String(name || '').trim();
    raw = raw.normalize ? raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : raw;
    let clean = raw.replace(/[.\-\s]+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').replace(/^_+|_+$/g, '');
    if (clean && /^[0-9]/.test(clean)) clean = 'u_' + clean;
    clean = clean.slice(0, 28);
    if (['admin', 'root', 'guest', 'httpdusr'].includes(clean.toLowerCase())) {
      clean = 'usr_' + clean.toLowerCase();
    }
    return clean;
  }

  function generateStrongRandomPassword(len = 8) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  function openUserModal(existing = null) {
    const isEdit = !!existing;
    const isMaster = (existing?.email || '').toLowerCase() === 'edsonmanoel2012@gmail.com';
    const shares = state.sharesCache.length ? state.sharesCache.map((s) => s.name) : ['Public', 'Lynx', 'Download'];
    const allShares = isEdit ? (existing.allowed_shares || []).includes('*') : true;
    const perms = existing?.permissions || { read: true, write: true, delete: false, manage_users: false, manage_shares: false, manage_qnap: false };

    const rawPathAccess = { ...(existing?.path_access || {}) };
    const subdirAccessMap = {};
    const rootShareModeOverride = {};
    Object.entries(rawPathAccess).forEach(([p, m]) => {
      const segs = String(p || '').split('/').filter(Boolean);
      if (segs.length >= 2) subdirAccessMap[p] = m;
      else if (segs.length === 1) rootShareModeOverride[segs[0]] = m;
    });

    showModal(isEdit ? `Editar Usuário & Acessos: ${existing.name}` : 'Criar Novo Usuário (App + QNAP)', `
      <div class="form-group">
        <label>Nome Completo</label>
        <input type="text" id="usrName" value="${escapeHtml(existing?.name || '')}" placeholder="Ex: João Silva" />
      </div>
      <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>Usuário ou E-mail de Acesso</label>
          <input type="text" id="usrEmail" autocomplete="off" value="${escapeHtml(existing?.email || '')}" placeholder="Ex: joao@empresa.com.br" />
        </div>
        <div class="form-group">
          <label>WhatsApp com DDD (Envio / Recuperação)</label>
          <input type="text" id="usrPhone" value="${escapeHtml(existing?.phone || '')}" placeholder="Ex: 5531999999999" />
        </div>
      </div>
      <div class="form-group">
        <label>E-mail para Notificações / Recuperação (opcional se o login já for e-mail)</label>
        <input type="email" id="usrNotifyEmail" autocomplete="off" value="${escapeHtml(existing?.notify_email || '')}" placeholder="Ex: contato@empresa.com.br" />
      </div>
      <div class="form-group">
        <label>${isEdit ? 'Senha de Acesso (altere ou deixe como está para manter)' : 'Senha de Acesso'}</label>
        <div class="pass-gen-row">
          <div class="password-wrap">
            <input type="password" id="usrPass" autocomplete="new-password" value="${escapeHtml(isEdit ? (existing?.plain_password || '') : '')}" placeholder="${isEdit && !existing?.plain_password ? 'Digite uma nova senha ou gere abaixo' : 'Mínimo 4 caracteres'}" />
            <button type="button" id="btnToggleUsrPass" class="btn-eye" title="Mostrar/ocultar senha">👁</button>
          </div>
          <button type="button" id="btnUsrGenPass" class="btn-secondary" title="Gerar senha automática">🎲 Gerar</button>
        </div>
      </div>
      <div class="form-group">
        <label>Usuário no QNAP NAS (criado e sincronizado automaticamente no SMB/QTS)</label>
        <input type="text" id="usrNasName" list="qnapUsersDatalist" value="${escapeHtml(existing?.nas_username || '')}" placeholder="Gerado automaticamente pelo login/nome" />
        <datalist id="qnapUsersDatalist">
          ${qnapUsersCache.map((qu) => `<option value="${escapeHtml(qu.username)}"></option>`).join('')}
        </datalist>
      </div>
      <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>Perfil</label>
          <select id="usrRole" ${isMaster ? 'disabled' : ''}>
            <option value="user" ${existing?.role !== 'admin' ? 'selected' : ''}>Usuário Padrão</option>
            <option value="admin" ${existing?.role === 'admin' ? 'selected' : ''}>Administrador Total</option>
          </select>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label>Status</label>
          <select id="usrActive" ${isMaster ? 'disabled' : ''}>
            <option value="1" ${existing.active ? 'selected' : ''}>Ativo</option>
            <option value="0" ${!existing.active ? 'selected' : ''}>Bloqueado</option>
          </select>
        </div>` : ''}
      </div>

      <div id="usrGranularBox" class="${(existing?.role === 'admin' || isMaster) ? 'hidden' : ''}">
        <div class="form-group">
          <label>Permissões no Sistema</label>
          <div class="perm-grid">
            <label class="perm-check"><input type="checkbox" id="pRead" ${perms.read ? 'checked' : ''} /> Ler / Baixar</label>
            <label class="perm-check"><input type="checkbox" id="pWrite" ${perms.write ? 'checked' : ''} /> Criar / Enviar / Editar</label>
            <label class="perm-check"><input type="checkbox" id="pDelete" ${perms.delete ? 'checked' : ''} /> Excluir / Mover</label>
            <label class="perm-check"><input type="checkbox" id="pShares" ${perms.manage_shares ? 'checked' : ''} /> Criar Shares</label>
            <label class="perm-check"><input type="checkbox" id="pUsers" ${perms.manage_users ? 'checked' : ''} /> Gerenciar Usuários</label>
            <label class="perm-check"><input type="checkbox" id="pQnap" ${perms.manage_qnap ? 'checked' : ''} /> Monitor QNAP</label>
          </div>
        </div>
        <div class="form-group">
          <label>Pastas Raiz do QNAP Permitidas (Portal Web + Disco L: + QNAP SMB)</label>
          <label class="perm-check" style="margin-bottom:6px">
            <input type="checkbox" id="chkAllShares" ${allShares ? 'checked' : ''} /> Liberar todas as pastas principais (*)
          </label>
          <div id="shareChecksWrap" class="perm-grid ${allShares ? 'hidden' : ''}">
            ${shares.map((sn) => {
              const checked = (existing?.allowed_shares || []).includes(sn);
              return `<label class="perm-check"><input type="checkbox" class="chk-share-item" value="${escapeHtml(sn)}" ${checked ? 'checked' : ''} /> ${escapeHtml(sn)}</label>`;
            }).join('')}
          </div>
        </div>

        <div class="form-group">
          <label>Subdiretórios Específicos (libera só a subpasta escolhida sem abrir a pasta raiz inteira)</label>
          <div id="usrSubdirList" class="subdir-rule-list"></div>
          <div class="subdir-add-grid">
            <select id="usrSubRootSel">
              ${shares.map((sn) => `<option value="${escapeHtml(sn)}">${escapeHtml(sn)}</option>`).join('')}
            </select>
            <div>
              <input type="text" id="usrSubRelInput" list="usrSubDatalist" placeholder="Subpasta (ex: Comercial/2026)" />
              <datalist id="usrSubDatalist"></datalist>
            </div>
            <select id="usrSubModeSel">
              <option value="rw">✅ Leitura e Escrita (RW)</option>
              <option value="ro">👁️ Somente Leitura (RO)</option>
              <option value="none">🚫 Bloqueado</option>
            </select>
            <button type="button" id="btnUsrAddSubdir" class="btn-secondary">+ Subpasta</button>
          </div>
        </div>
      </div>

      <label class="perm-check" style="margin-top:8px;background:#eff6ff;border-color:#bfdbfe">
        <input type="checkbox" id="chkSyncQnap" checked /> ${isEdit
          ? 'Sincronizar conta, senha e permissões de pastas automaticamente no QNAP NAS'
          : 'Criar automaticamente este usuário no QNAP NAS (Linux + rede Windows/Samba + pastas permitidas)'}
      </label>
      <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
        <label class="perm-check">
          <input type="checkbox" id="chkSendEmailOnSave" ${!isEdit ? 'checked' : ''} /> 📧 Enviar acesso por E-mail ao salvar
        </label>
        <label class="perm-check">
          <input type="checkbox" id="chkSendWaOnSave" /> 💬 Enviar acesso por WhatsApp ao salvar
        </label>
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: isEdit ? '💾 Salvar Alterações' : 'Criar Usuário no App + QNAP',
        cls: 'btn-primary',
        onClick: async () => {
          const role = isMaster ? 'admin' : $('usrRole').value;
          const allSh = $('chkAllShares')?.checked;
          const selectedShares = allSh ? ['*'] : Array.from(document.querySelectorAll('.chk-share-item:checked')).map((c) => c.value);
          const mergedPathAccess = { ...subdirAccessMap };
          if (!allSh) {
            selectedShares.forEach((sn) => {
              if (rootShareModeOverride[sn]) mergedPathAccess['/' + sn] = rootShareModeOverride[sn];
            });
          }
          const rawPassInput = $('usrPass').value;
          const passToSend = (isEdit && existing?.plain_password && rawPassInput === existing.plain_password) ? '' : rawPassInput;
          const payload = {
            id: existing?.id,
            name: $('usrName').value.trim(),
            email: $('usrEmail').value.trim(),
            phone: $('usrPhone')?.value.trim() || '',
            notify_email: $('usrNotifyEmail')?.value.trim() || '',
            password: passToSend,
            nas_username: $('usrNasName')?.value.trim() || '',
            role,
            active: isMaster ? true : (isEdit ? $('usrActive').value === '1' : true),
            allowed_shares: selectedShares,
            path_access: role === 'admin' ? {} : mergedPathAccess,
            permissions: {
              read: $('pRead')?.checked ?? true,
              write: $('pWrite')?.checked ?? false,
              delete: $('pDelete')?.checked ?? false,
              manage_shares: $('pShares')?.checked ?? false,
              manage_users: $('pUsers')?.checked ?? false,
              manage_qnap: $('pQnap')?.checked ?? false
            },
            sync_to_qnap: $('chkSyncQnap')?.checked ?? true,
            send_email: $('chkSendEmailOnSave')?.checked ?? false,
            send_whatsapp: $('chkSendWaOnSave')?.checked ?? false
          };
          try {
            const res = await apiFetch('users', { method: isEdit ? 'PUT' : 'POST', json: payload });
            if (isEdit && (payload.send_email || payload.send_whatsapp) && res?.user?.id) {
              await apiFetch('send_user_credentials', {
                json: {
                  user_id: res.user.id,
                  send_email: payload.send_email,
                  send_whatsapp: payload.send_whatsapp,
                  email_to: payload.notify_email || (payload.email.includes('@') ? payload.email : ''),
                  whatsapp_to: payload.phone,
                  password_override: rawPassInput || ''
                }
              }).catch((err) => toast('Usuário salvo, mas falha ao enviar acesso: ' + err.message, 'err'));
            }
            if (res?.qnap_sync && res.qnap_sync.ok === false) {
              toast(`Usuário salvo no app, mas aviso no QNAP: ${res.qnap_sync.error || 'falha de sincronização'}`, 'err');
            } else {
              toast(
                isEdit
                  ? `Usuário "${res?.user?.nas_username || payload.name}" atualizado no App e no QNAP!`
                  : `Usuário "${res?.user?.nas_username || payload.name}" criado no App e dentro do QNAP!`,
                'ok'
              );
            }
            closeModal();
            if (state.currentSection === 'qnap-users') loadUsersView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ], true);

    $('btnToggleUsrPass').onclick = () => {
      const inp = $('usrPass');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    };
    $('btnUsrGenPass').onclick = () => {
      const inp = $('usrPass');
      inp.value = generateStrongRandomPassword(8);
      inp.type = 'text';
    };

    const renderUsrSubdirList = () => {
      const wrap = $('usrSubdirList');
      if (!wrap) return;
      const entries = Object.entries(subdirAccessMap);
      if (!entries.length) {
        wrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);padding:4px 6px">Nenhum subdiretório específico adicionado. Use os campos abaixo para liberar apenas uma subpasta.</div>';
        return;
      }
      wrap.innerHTML = entries.map(([sp, mode]) => `
        <div class="subdir-rule-row">
          <div style="font-weight:600;font-size:12px;word-break:break-word">📂 ${escapeHtml(sp)}</div>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="access-select" data-usr-sub-edit="${escapeHtml(sp)}">
              <option value="rw" ${mode === 'rw' ? 'selected' : ''}>✅ Leitura e Escrita (RW)</option>
              <option value="ro" ${mode === 'ro' ? 'selected' : ''}>👁️ Somente Leitura (RO)</option>
              <option value="none" ${mode === 'none' ? 'selected' : ''}>🚫 Bloqueado</option>
            </select>
            <button type="button" class="btn-danger-sm" data-usr-sub-del="${escapeHtml(sp)}" title="Remover regra">✕</button>
          </div>
        </div>
      `).join('');
      wrap.querySelectorAll('[data-usr-sub-edit]').forEach((sel) => {
        sel.onchange = () => { subdirAccessMap[sel.dataset.usrSubEdit] = sel.value; };
      });
      wrap.querySelectorAll('[data-usr-sub-del]').forEach((btn) => {
        btn.onclick = () => { delete subdirAccessMap[btn.dataset.usrSubDel]; renderUsrSubdirList(); };
      });
    };

    const loadUsrSubSuggestions = async () => {
      const root = $('usrSubRootSel')?.value;
      const dl = $('usrSubDatalist');
      if (!root || !dl) return;
      try {
        const r = await apiFetch('files', { query: `path=${encodeURIComponent('/' + root)}` });
        const dirs = (r.items || []).filter((i) => i.is_dir);
        dl.innerHTML = dirs.map((d) => `<option value="${escapeHtml(d.name)}"></option>`).join('');
      } catch {
        dl.innerHTML = '';
      }
    };
    $('usrSubRootSel')?.addEventListener('change', loadUsrSubSuggestions);
    loadUsrSubSuggestions();

    $('btnUsrAddSubdir')?.addEventListener('click', () => {
      const root = $('usrSubRootSel')?.value || shares[0];
      const rel = String($('usrSubRelInput')?.value || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
      if (!rel) {
        toast('Informe o nome ou caminho da subpasta (ex: Comercial).', 'err');
        return;
      }
      const fullSub = '/' + root + '/' + rel;
      subdirAccessMap[fullSub] = $('usrSubModeSel')?.value || 'rw';
      $('usrSubRelInput').value = '';
      renderUsrSubdirList();
    });
    renderUsrSubdirList();

    const nasInp = $('usrNasName');
    const syncNasFromInputs = () => {
      if (!nasInp || nasInp.dataset.manualEdited === '1') return;
      if (isEdit && existing?.nas_username) return;
      nasInp.value = deriveQnapUsernameLocal($('usrEmail')?.value || '', $('usrName')?.value || '');
    };
    nasInp?.addEventListener('input', () => {
      nasInp.dataset.manualEdited = nasInp.value.trim() !== '' ? '1' : '';
    });
    $('usrEmail')?.addEventListener('input', syncNasFromInputs);
    $('usrName')?.addEventListener('input', syncNasFromInputs);
    if (!isEdit) syncNasFromInputs();

    $('usrRole').onchange = () => {
      $('usrGranularBox').classList.toggle('hidden', $('usrRole').value === 'admin');
    };
    $('chkAllShares')?.addEventListener('change', () => {
      $('shareChecksWrap').classList.toggle('hidden', $('chkAllShares').checked);
    });
  }

  window.__editUser = (id) => {
    const u = usersListCache.find((x) => x.id === id);
    if (u) openUserModal(u);
  };

  window.__deleteUser = (id, name) => {
    const u = usersListCache.find((x) => x.id === id);
    const nasU = u?.nas_username || '';
    const canDelQnap = !!nasU && !['admin', 'root', 'guest', 'httpdusr'].includes(nasU.toLowerCase());
    showModal('Excluir Usuário', `
      <p>Deseja remover o usuário <strong>${escapeHtml(name)}</strong> do ServLynx?</p>
      ${canDelQnap ? `
        <label class="perm-check" style="margin-top:10px;background:#fef2f2;border-color:#fecaca">
          <input type="checkbox" id="chkDelQnapUsr" checked /> Remover também a conta vinculada <strong>${escapeHtml(nasU)}</strong> dentro do QNAP NAS
        </label>
      ` : ''}
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Excluir',
        cls: 'btn-danger',
        onClick: async () => {
          try {
            await apiFetch('users', {
              method: 'DELETE',
              json: { id, delete_qnap_user: $('chkDelQnapUsr')?.checked ?? false }
            });
            toast('Usuário removido.', 'ok');
            closeModal();
            loadUsersView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  };

  function openNewQnapUserModal() {
    const shares = state.sharesCache.length ? state.sharesCache : [{ name: 'Public' }, { name: 'Lynx' }, { name: 'Download' }];
    showModal('Criar Usuário Nativo no QNAP (Samba/Linux)', `
      <div class="form-group">
        <label>Nome de usuário no QNAP (apenas letras minúsculas/números)</label>
        <input type="text" id="quName" placeholder="Ex: comercial" />
      </div>
      <div class="form-group">
        <label>Senha do QNAP</label>
        <input type="password" id="quPass" placeholder="Senha forte" />
      </div>
      <label class="perm-check" style="margin-bottom:10px">
        <input type="checkbox" id="quAdmin" /> Adicionar ao grupo administradores do QNAP (administrators)
      </label>
      <div class="form-group" style="margin-bottom:0">
        <label>Acesso inicial às pastas do QNAP (SMB)</label>
        <div class="access-matrix-list">
          ${shares.map((sh) => `
            <div class="access-row">
              <div class="access-row-info">
                <span class="access-row-title">🗄️ ${escapeHtml(sh.name)}</span>
              </div>
              ${renderAclSelect(`data-new-qu-share="${escapeHtml(sh.name)}"`, 'none')}
            </div>
          `).join('')}
        </div>
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Criar no QNAP',
        cls: 'btn-primary',
        onClick: async () => {
          const share_access = {};
          document.querySelectorAll('[data-new-qu-share]').forEach((sel) => {
            if (sel.value !== 'none') share_access[sel.dataset.newQuShare] = sel.value;
          });
          try {
            await apiFetch('qnap_user', {
              json: {
                op: 'create',
                username: $('quName').value.trim(),
                password: $('quPass').value,
                is_admin: $('quAdmin').checked,
                share_access
              }
            });
            toast('Usuário criado no sistema QNAP!', 'ok');
            closeModal();
            loadUsersView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  }

  window.__changeQnapPass = (username) => {
    showModal(`Alterar Senha QNAP: ${username}`, `
      <div class="form-group">
        <label>Nova senha para "${escapeHtml(username)}" no QNAP</label>
        <input type="password" id="quNewPass" placeholder="Nova senha" />
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Alterar Senha',
        cls: 'btn-primary',
        onClick: async () => {
          try {
            await apiFetch('qnap_user', { json: { op: 'password', username, password: $('quNewPass').value } });
            toast(`Senha de "${username}" atualizada no QNAP!`, 'ok');
            closeModal();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  };

  window.__deleteQnapUser = (username) => {
    showModal('Remover Usuário do QNAP', `<p>Remover usuário nativo <strong>${escapeHtml(username)}</strong> do QNAP?</p>`, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Remover',
        cls: 'btn-danger',
        onClick: async () => {
          try {
            await apiFetch('qnap_user', { json: { op: 'delete', username } });
            toast(`Usuário "${username}" removido do QNAP.`, 'ok');
            closeModal();
            loadUsersView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  };

  window.__sendUserCredentials = (userId) => {
    const u = usersListCache.find((x) => x.id === userId);
    if (!u) return;
    const defaultEmail = u.notify_email || (String(u.email || '').includes('@') ? u.email : '');
    const defaultPhone = u.phone || '';
    const savedPass = u.plain_password || '';

    const accessSummary = u.role === 'admin'
      ? ['Todas as pastas (Administrador Total)']
      : [
          ...(Array.isArray(u.allowed_shares) ? u.allowed_shares.map((s) => s === '*' ? 'Todas as pastas (*)' : '/' + s) : []),
          ...Object.entries(u.path_access || {}).map(([p, m]) => `${p} (${m.toUpperCase()})`)
        ];

    showModal(`📨 Enviar Acesso: ${u.name}`, `
      <div class="details-kv" style="margin-top:0;margin-bottom:12px;border:1px solid var(--border);border-radius:8px;padding:8px 12px;background:#f8fafc">
        <div class="details-row"><span>Usuário / Login</span><span>${escapeHtml(u.email)}</span></div>
        <div class="details-row"><span>Usuário QNAP NAS</span><span>${escapeHtml(u.nas_username || '—')}</span></div>
        <div class="details-row"><span>Pastas Liberadas</span><span>${escapeHtml(accessSummary.join(', ') || 'Nenhuma')}</span></div>
      </div>

      <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label for="credEmailTo">E-mail do Destinatário</label>
          <input type="email" id="credEmailTo" value="${escapeHtml(defaultEmail)}" placeholder="ex: usuario@empresa.com.br" />
        </div>
        <div class="form-group">
          <label for="credWhatsappTo">WhatsApp do Destinatário (com DDD)</label>
          <input type="text" id="credWhatsappTo" value="${escapeHtml(defaultPhone)}" placeholder="ex: 5531999999999" />
        </div>
      </div>

      <div class="form-group">
        <label for="credPassword">Senha de Acesso a Enviar ${savedPass ? '(senha atual carregada ✓)' : '(digite ou gere uma senha para sincronizar App + QNAP)'}</label>
        <div class="pass-gen-row">
          <div class="password-wrap">
            <input type="text" id="credPassword" value="${escapeHtml(savedPass)}" placeholder="Digite a senha ou clique em Gerar Nova Senha" />
          </div>
          <button type="button" id="btnCredGenPass" class="btn-secondary">🎲 Gerar Nova Senha</button>
        </div>
      </div>

      <div class="form-group">
        <label for="credCustomNote">Observação Adicional (opcional)</label>
        <input type="text" id="credCustomNote" placeholder="Ex: Use sua senha para acessar pelo computador ou celular" />
      </div>

      <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <label class="perm-check" style="background:#eff6ff;border-color:#bfdbfe">
          <input type="checkbox" id="chkCredEmail" ${defaultEmail.includes('@') ? 'checked' : ''} /> 📧 Enviar por E-mail (suporte@lynxems.com.br)
        </label>
        <label class="perm-check" style="background:#f0fdf4;border-color:#bbf7d0">
          <input type="checkbox" id="chkCredWhatsapp" ${(defaultPhone || !defaultEmail.includes('@')) ? 'checked' : ''} /> 💬 Enviar por WhatsApp (Suporte Lynx)
        </label>
      </div>

      <div class="form-group" style="margin-bottom:0">
        <label>Pré-visualização da Mensagem</label>
        <div id="credPreviewBox" class="cred-preview-box"></div>
      </div>
    `, [
      { text: 'Fechar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: '🚀 Enviar Dados de Acesso Agora',
        cls: 'btn-primary',
        onClick: async () => {
          const send_email = $('chkCredEmail')?.checked ?? false;
          const send_whatsapp = $('chkCredWhatsapp')?.checked ?? false;
          const email_to = $('credEmailTo')?.value.trim() || '';
          const whatsapp_to = $('credWhatsappTo')?.value.trim() || '';
          const passVal = $('credPassword')?.value || '';
          const custom_note = $('credCustomNote')?.value.trim() || '';
          if (!send_email && !send_whatsapp) {
            toast('Marque ao menos um canal (E-mail ou WhatsApp).', 'err');
            return;
          }
          if (!passVal || passVal.length < 4) {
            toast('Informe ou gere uma senha com pelo menos 4 caracteres.', 'err');
            return;
          }
          const password_override = (passVal !== savedPass) ? passVal : '';
          try {
            const res = await apiFetch('send_user_credentials', {
              json: {
                user_id: u.id,
                send_email,
                send_whatsapp,
                email_to,
                whatsapp_to,
                password_override,
                custom_note
              }
            });
            const sent = [];
            if (res.email_result?.ok) sent.push(`E-mail (${res.email_result.to})`);
            if (res.whatsapp_result?.ok) sent.push(`WhatsApp (${res.whatsapp_result.number})`);
            toast(`✅ Credenciais enviadas com sucesso via ${sent.join(' e ')}!`, 'ok');
            if (res.email_result && !res.email_result.ok) toast('Aviso E-mail: ' + res.email_result.error, 'err');
            if (res.whatsapp_result && !res.whatsapp_result.ok) toast('Aviso WhatsApp: ' + res.whatsapp_result.error, 'err');
            closeModal();
            if (state.currentSection === 'qnap-users') loadUsersView();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ], true);

    const updatePreview = () => {
      const pw = $('credPassword')?.value || '<informe_ou_gere_uma_senha>';
      const note = $('credCustomNote')?.value.trim();
      const lines = [
        `🔐 ServLynx Explorer & Disco QNAP — Seus Dados de Acesso`,
        `Olá, ${u.name}!`,
        `🌐 Portal Web: https://servlynx.lynxems.com.br`,
        `💿 Disco WebDAV (L:): https://servlynx.lynxems.com.br/dav.php`,
        `👤 Login: ${u.email}`,
        `🗄️ QNAP NAS: ${u.nas_username || '—'}`,
        `🔑 Senha: ${pw}`,
        `📁 Pastas: ${accessSummary.join(', ') || 'Nenhuma'}`
      ];
      if (note) lines.push(`📝 Obs: ${note}`);
      if ($('credPreviewBox')) $('credPreviewBox').textContent = lines.join('\n');
    };
    $('btnCredGenPass').onclick = () => {
      $('credPassword').value = generateStrongRandomPassword(8);
      updatePreview();
    };
    $('credPassword')?.addEventListener('input', updatePreview);
    $('credCustomNote')?.addEventListener('input', updatePreview);
    updatePreview();
  };

  async function openNotifyConfigModal() {
    showModal('⚙️ Configuração de E-mail (SMTP) & WhatsApp (Evolution API)', '<p>Carregando configurações...</p>', [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal }
    ], true);
    try {
      const res = await apiFetch('notify_config');
      const cfg = res.config || {};
      showModal('⚙️ Configuração de E-mail (SMTP) & WhatsApp (Evolution API)', `
        <div class="card-box mb-16" style="padding:12px">
          <h3 style="margin-bottom:10px;font-size:14px">📧 Servidor de E-mail SMTP (Envio de Acessos &amp; Recuperação)</h3>
          <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Host SMTP</label><input type="text" id="ncSmtpHost" value="${escapeHtml(cfg.smtp_host || 'smtp.hostinger.com')}" /></div>
            <div class="form-group"><label>Porta / Segurança</label><input type="text" id="ncSmtpPort" value="${escapeHtml(String(cfg.smtp_port || 465))}" /></div>
            <div class="form-group"><label>Usuário / E-mail SMTP</label><input type="text" id="ncSmtpUser" value="${escapeHtml(cfg.smtp_user || 'suporte@lynxems.com.br')}" /></div>
            <div class="form-group"><label>Senha do E-mail</label><input type="password" id="ncSmtpPass" value="${escapeHtml(cfg.smtp_pass || '')}" /></div>
          </div>
          <div class="copy-row">
            <input type="email" id="ncTestEmailTo" value="${escapeHtml(cfg.smtp_user || 'suporte@lynxems.com.br')}" placeholder="E-mail para teste" />
            <button type="button" class="btn-secondary" id="btnNcTestEmail">✉️ Testar E-mail</button>
          </div>
        </div>

        <div class="card-box" style="padding:12px">
          <h3 style="margin-bottom:10px;font-size:14px">💬 WhatsApp Evolution API (Instância Suporte Lynx)</h3>
          <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>URL Evolution API</label><input type="text" id="ncEvoUrl" value="${escapeHtml(cfg.evolution_url || 'https://evo.lynxems.com.br')}" /></div>
            <div class="form-group"><label>Instância</label><input type="text" id="ncEvoInst" value="${escapeHtml(cfg.evolution_instance || 'Suporte Lynx')}" /></div>
            <div class="form-group"><label>API Key / Token</label><input type="text" id="ncEvoKey" value="${escapeHtml(cfg.evolution_apikey || '')}" /></div>
            <div class="form-group"><label>Webhook</label><input type="text" id="ncEvoWebhook" value="${escapeHtml(cfg.evolution_webhook || 'https://lynxems.com.br/api/webhook')}" /></div>
          </div>
          <div class="form-group"><label>WhatsApp Padrão do Suporte</label><input type="text" id="ncSupWa" value="${escapeHtml(cfg.support_whatsapp || '553171094030')}" /></div>
          <div class="copy-row">
            <input type="text" id="ncTestWaTo" value="${escapeHtml(cfg.support_whatsapp || '553171094030')}" placeholder="WhatsApp para teste (com DDI+DDD)" />
            <button type="button" class="btn-secondary" id="btnNcTestWa">💬 Testar WhatsApp</button>
          </div>
        </div>
      `, [
        { text: 'Fechar', cls: 'btn-secondary', onClick: closeModal },
        {
          text: '💾 Salvar Configurações',
          cls: 'btn-primary',
          onClick: async () => {
            try {
              await apiFetch('notify_config', {
                json: {
                  op: 'save',
                  smtp_host: $('ncSmtpHost').value.trim(),
                  smtp_port: Number($('ncSmtpPort').value.trim()) || 465,
                  smtp_secure: Number($('ncSmtpPort').value.trim()) === 465 ? 'ssl' : 'tls',
                  smtp_user: $('ncSmtpUser').value.trim(),
                  smtp_pass: $('ncSmtpPass').value,
                  evolution_url: $('ncEvoUrl').value.trim(),
                  evolution_instance: $('ncEvoInst').value.trim(),
                  evolution_apikey: $('ncEvoKey').value.trim(),
                  evolution_webhook: $('ncEvoWebhook').value.trim(),
                  support_whatsapp: $('ncSupWa').value.trim()
                }
              });
              toast('Configurações de E-mail e WhatsApp salvas!', 'ok');
              closeModal();
            } catch (e) { toast(e.message, 'err'); }
          }
        }
      ], true);

      $('btnNcTestEmail').onclick = async () => {
        try {
          toast('Enviando e-mail de teste...', 'info');
          const r = await apiFetch('notify_config', {
            json: { op: 'test_email', test_to: $('ncTestEmailTo').value.trim() }
          });
          toast(`E-mail de teste enviado para ${r.to}!`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      $('btnNcTestWa').onclick = async () => {
        try {
          toast('Enviando mensagem WhatsApp de teste...', 'info');
          const r = await apiFetch('notify_config', {
            json: { op: 'test_whatsapp', test_to: $('ncTestWaTo').value.trim() }
          });
          toast(`WhatsApp de teste enviado para ${r.number}!`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    } catch (e) {
      $('modalBody').innerHTML = `<div class="login-error">${escapeHtml(e.message)}</div>`;
    }
  }

  function openForgotPasswordModal() {
    const prefillLogin = $('loginEmail')?.value.trim() || '';
    showModal('🔑 Esqueci Minha Senha — Recuperar Acesso', `
      <div class="card-box mb-16" style="padding:12px;background:#f8fafc">
        <div style="font-weight:700;font-size:13px;margin-bottom:8px">1. Enviar Código de Recuperação / Dados de Acesso</div>
        <div class="form-group">
          <label for="fpLogin">Usuário, E-mail ou WhatsApp cadastrado</label>
          <input type="text" id="fpLogin" value="${escapeHtml(prefillLogin)}" placeholder="Ex: usuario@empresa.com.br ou 31999999999" />
        </div>
        <div class="two-col-grid" style="grid-template-columns:1fr auto;gap:8px;align-items:end">
          <div class="form-group" style="margin-bottom:0">
            <label for="fpChannel">Canal de Envio</label>
            <select id="fpChannel">
              <option value="both">📧 E-mail e 💬 WhatsApp</option>
              <option value="email">📧 Apenas E-mail</option>
              <option value="whatsapp">💬 Apenas WhatsApp</option>
            </select>
          </div>
          <button type="button" id="btnFpSendCode" class="btn-primary">📨 Enviar Código / Meus Dados</button>
        </div>
        <div id="fpStatusMsg" class="hidden" style="margin-top:10px"></div>
      </div>

      <div class="card-box" style="padding:12px">
        <div style="font-weight:700;font-size:13px;margin-bottom:8px">2. Já recebeu o código? Defina uma Nova Senha</div>
        <div class="form-group">
          <label for="fpCode">Código de 6 dígitos recebido</label>
          <input type="text" id="fpCode" maxlength="10" placeholder="Ex: 123456" />
        </div>
        <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-group" style="margin-bottom:0">
            <label for="fpNewPass">Nova Senha</label>
            <input type="password" id="fpNewPass" autocomplete="new-password" placeholder="Mínimo 4 caracteres" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label for="fpNewPassConfirm">Confirmar Nova Senha</label>
            <input type="password" id="fpNewPassConfirm" autocomplete="new-password" placeholder="Repita a nova senha" />
          </div>
        </div>
      </div>
    `, [
      { text: 'Voltar ao Login', cls: 'btn-secondary', onClick: closeModal },
      {
        text: '🔑 Redefinir Senha Agora',
        cls: 'btn-primary',
        onClick: async () => {
          const login = $('fpLogin').value.trim();
          const code = $('fpCode').value.trim();
          const new_password = $('fpNewPass').value;
          const confirm = $('fpNewPassConfirm').value;
          if (!login || !code) {
            toast('Informe seu usuário e o código de 6 dígitos recebido.', 'err');
            return;
          }
          if (new_password.length < 4) {
            toast('A nova senha deve ter no mínimo 4 caracteres.', 'err');
            return;
          }
          if (new_password !== confirm) {
            toast('A confirmação da nova senha não confere.', 'err');
            return;
          }
          try {
            const r = await apiFetch('reset_password', { json: { login, code, new_password } });
            if ($('loginEmail') && login) $('loginEmail').value = login;
            if ($('loginPassword')) $('loginPassword').value = new_password;
            toast(r.message || 'Senha redefinida! Já preenchemos no login.', 'ok');
            closeModal();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);

    $('btnFpSendCode').onclick = async () => {
      const login = $('fpLogin').value.trim();
      const channel = $('fpChannel').value;
      if (!login) {
        toast('Informe seu usuário, e-mail ou WhatsApp.', 'err');
        return;
      }
      const st = $('fpStatusMsg');
      $('btnFpSendCode').disabled = true;
      $('btnFpSendCode').textContent = 'Enviando...';
      try {
        const res = await apiFetch('forgot_password', { json: { login, channel } });
        st.className = 'cred-ok-box';
        st.textContent = res.message || 'Código enviado com sucesso! Confira seu E-mail ou WhatsApp.';
        toast(res.message || 'Enviado!', 'ok');
      } catch (e) {
        st.className = 'login-error';
        st.textContent = e.message;
        toast(e.message, 'err');
      } finally {
        $('btnFpSendCode').disabled = false;
        $('btnFpSendCode').textContent = '📨 Enviar Código / Meus Dados';
      }
    };
  }

  function openChangePasswordLoginModal() {
    const prefillLogin = $('loginEmail')?.value.trim() || '';
    showModal('🔄 Trocar Senha', `
      <div class="form-group">
        <label for="cpLogin">Usuário ou E-mail</label>
        <input type="text" id="cpLogin" value="${escapeHtml(prefillLogin)}" placeholder="Seu usuário ou e-mail de login" />
      </div>
      <div class="form-group">
        <label for="cpCurrentPass">Senha Atual</label>
        <input type="password" id="cpCurrentPass" autocomplete="current-password" placeholder="Digite sua senha atual" />
      </div>
      <div class="form-group">
        <label for="cpNewPass">Nova Senha</label>
        <input type="password" id="cpNewPass" autocomplete="new-password" placeholder="Mínimo 4 caracteres" />
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label for="cpNewPassConfirm">Confirmar Nova Senha</label>
        <input type="password" id="cpNewPassConfirm" autocomplete="new-password" placeholder="Repita a nova senha" />
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: '💾 Alterar Senha Agora',
        cls: 'btn-primary',
        onClick: async () => {
          const login = $('cpLogin').value.trim();
          const current_password = $('cpCurrentPass').value;
          const new_password = $('cpNewPass').value;
          const confirm = $('cpNewPassConfirm').value;
          if (!login || !current_password) {
            toast('Informe usuário e senha atual.', 'err');
            return;
          }
          if (new_password.length < 4) {
            toast('A nova senha deve ter no mínimo 4 caracteres.', 'err');
            return;
          }
          if (new_password !== confirm) {
            toast('A confirmação da nova senha não confere.', 'err');
            return;
          }
          try {
            const r = await apiFetch('change_password_public', {
              json: { login, current_password, new_password }
            });
            if ($('loginEmail')) $('loginEmail').value = login;
            if ($('loginPassword')) $('loginPassword').value = new_password;
            toast(r.message || 'Senha alterada com sucesso!', 'ok');
            closeModal();
          } catch (e) { toast(e.message, 'err'); }
        }
      }
    ]);
  }

  function openMyAccountModal() {
    const u = state.user || {};
    showModal('Minha Conta — Alterar Login, Contato e Senha', `
      <div class="form-group">
        <label>Nome de Exibição</label>
        <input type="text" id="profName" value="${escapeHtml(u.name || '')}" required />
      </div>
      <div class="form-group">
        <label>Usuário ou E-mail de Login</label>
        <input type="text" id="profEmail" value="${escapeHtml(u.email || u.username || '')}" required />
      </div>
      <div class="two-col-grid" style="grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group">
          <label>Meu WhatsApp (para recuperação)</label>
          <input type="text" id="profPhone" value="${escapeHtml(u.phone || '')}" placeholder="Ex: 5531999999999" />
        </div>
        <div class="form-group">
          <label>E-mail de Recuperação</label>
          <input type="email" id="profNotifyEmail" value="${escapeHtml(u.notify_email || '')}" placeholder="Ex: meu@email.com" />
        </div>
      </div>
      <div class="form-group">
        <label>Nova Senha (deixe em branco se quiser manter a atual)</label>
        <input type="password" id="profNewPass" placeholder="Mínimo 4 caracteres" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label>Confirmar Nova Senha</label>
        <input type="password" id="profNewPassConfirm" placeholder="Repita a nova senha" autocomplete="new-password" />
      </div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
      <div class="form-group">
        <label>Senha Atual (obrigatória para confirmar alterações)</label>
        <input type="password" id="profCurrentPass" placeholder="Digite sua senha atual" autocomplete="current-password" required />
      </div>
    `, [
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal },
      {
        text: 'Salvar Alterações',
        cls: 'btn-primary',
        onClick: async () => {
          const name = $('profName').value.trim();
          const email = $('profEmail').value.trim();
          const phone = $('profPhone')?.value.trim() || '';
          const notify_email = $('profNotifyEmail')?.value.trim() || '';
          const newPass = $('profNewPass').value;
          const confirmPass = $('profNewPassConfirm').value;
          const currentPass = $('profCurrentPass').value;
          if (!name || !email) {
            toast('Preencha o nome e o login/e-mail.', 'err');
            return;
          }
          if (newPass && newPass.length < 4) {
            toast('A nova senha deve ter no mínimo 4 caracteres.', 'err');
            return;
          }
          if (newPass !== confirmPass) {
            toast('A confirmação da nova senha não confere.', 'err');
            return;
          }
          if (!currentPass) {
            toast('Informe sua senha atual para confirmar.', 'err');
            return;
          }
          try {
            const res = await apiFetch('update_profile', {
              json: {
                name,
                email,
                phone,
                notify_email,
                new_password: newPass,
                current_password: currentPass
              }
            });
            state.user = res.user;
            $('topUserName').textContent = res.user.name || res.user.email;
            $('userAvatar').textContent = (res.user.name || res.user.email || 'U')[0].toUpperCase();
            toast('Perfil e senha atualizados com sucesso!', 'ok');
            closeModal();
            if (state.currentSection === 'qnap-users') loadUsersView();
          } catch (e) {
            toast(e.message, 'err');
          }
        }
      }
    ]);
  }

  // ==================== CONEXÃO QNAP & MODO DISCO / PWA ====================
  async function connectToQnapNow(updateModal = false) {
    const cBtn = $('btnConnectQnap');
    if (cBtn) cBtn.classList.add('connecting');
    try {
      const res = await apiFetch('connect_qnap');
      updateBridgeBadge(res.bridge_online !== false);
      if (res.status) {
        state.qnapStatus = res.status;
        applyDiskSummaryToUI(res.status);
      }
      if (res.shares && res.shares.length) {
        state.sharesCache = res.shares;
        renderSidebarShares(res.shares);
      }
      if (state.currentSection === 'explorer' && currentPath() === '/' && !state.searchActive) {
        loadDirectory('/');
      }
      if (updateModal && $('connectQnapStatusBox')) {
        const d = res.status?.disk;
        $('connectQnapStatusBox').innerHTML = `
          <div class="details-kv" style="margin-top:0;border:none">
            <div class="details-row"><span>Status da Conexão</span><span><span class="badge badge-ok">Conectado Online ✅</span></span></div>
            <div class="details-row"><span>Latência / Resposta</span><span>${res.latency_ms} ms</span></div>
            <div class="details-row"><span>NAS</span><span>QNAP ${escapeHtml(res.status?.model || 'TS-231P')} (${escapeHtml(res.status?.hostname || 'NAS09534B')})</span></div>
            <div class="details-row"><span>Pastas Disponíveis</span><span>${res.shares_count ?? (res.shares?.length || 0)} pasta(s) compartilhada(s)</span></div>
            <div class="details-row"><span>Espaço Livre no Disco</span><span>${escapeHtml(d ? `${d.avail_human} livres de ${d.total_human}` : '--')}</span></div>
          </div>
        `;
      }
      toast(`QNAP conectado (${res.latency_ms} ms)!`, 'ok');
      return res;
    } catch (e) {
      updateBridgeBadge(false);
      if (updateModal && $('connectQnapStatusBox')) {
        $('connectQnapStatusBox').innerHTML = `<div class="login-error">${escapeHtml(e.message)}</div>`;
      }
      toast('Falha ao conectar ao QNAP: ' + e.message, 'err');
      return null;
    } finally {
      if (cBtn) cBtn.classList.remove('connecting');
    }
  }

  function openConnectQnapModal() {
    showModal('🔌 Conectar ao QNAP NAS', `
      <div id="connectQnapStatusBox" class="drive-option-card">
        <p style="margin:0">⏳ Estabelecendo conexão e sincronizando pastas com o QNAP...</p>
      </div>
      <div class="drive-option-card">
        <h4>Acesso Rápido ao Servidor</h4>
        <p>Use os botões abaixo para abrir as pastas no app, instalar no celular/PC ou montar como Disco Rígido (L:).</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" class="btn-primary" id="cqOpenRootBtn">📂 Abrir Pastas do QNAP</button>
          <button type="button" class="btn-secondary" id="cqOpenDriveBtn">💿 Instalar App / Disco (L:)</button>
          <button type="button" class="btn-secondary" id="cqTestBtn">🔄 Testar Conexão Agora</button>
        </div>
      </div>
      <div class="drive-option-card" style="margin-bottom:0">
        <h4>Rede Local (Wi-Fi / Cabo da Empresa)</h4>
        <div class="copy-row">
          <input type="text" readonly value="\\\\192.168.15.44" id="cqLocalUnc" />
          <button type="button" class="btn-sm" id="cqCopyUnc">Copiar</button>
        </div>
        <div class="copy-row">
          <input type="text" readonly value="http://192.168.15.44:8080" id="cqQtsUrl" />
          <button type="button" class="btn-sm" id="cqOpenQts">Abrir QTS</button>
        </div>
      </div>
    `, [{ text: 'Fechar', cls: 'btn-secondary', onClick: closeModal }]);

    $('cqOpenRootBtn').onclick = () => { closeModal(); navigateTo('/'); };
    $('cqOpenDriveBtn').onclick = () => { closeModal(); openDriveModal(); };
    $('cqTestBtn').onclick = () => connectToQnapNow(true);
    $('cqCopyUnc').onclick = () => copyTextToClipboard('\\\\192.168.15.44', 'Endereço de rede local copiado!');
    $('cqOpenQts').onclick = () => window.open('http://192.168.15.44:8080', '_blank');

    connectToQnapNow(true);
  }

  function buildDavUrl(relPath) {
    const clean = (relPath || '/').split('/').filter(Boolean);
    if (!clean.length) return `${window.location.origin}/dav/`;
    return `${window.location.origin}/dav/${clean.map(encodeURIComponent).join('/')}`;
  }

  function getMappedDrivesMap() {
    try {
      const raw = JSON.parse(localStorage.getItem('servlynx_mapped_drives') || '{}');
      return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch {
      return {};
    }
  }

  function saveMappedDriveEntry(letter, relPath) {
    const map = getMappedDrivesMap();
    if (relPath === null) {
      delete map[letter];
    } else {
      map[letter] = relPath || '/';
    }
    try {
      localStorage.setItem('servlynx_mapped_drives', JSON.stringify(map));
    } catch {}
  }

  function findMappedDriveForPath(relPath) {
    const norm = '/' + String(relPath || '/').split('/').filter(Boolean).join('/');
    const map = getMappedDrivesMap();
    let best = null;
    Object.keys(map).forEach((ltr) => {
      if (!/^[E-Z]$/i.test(ltr)) return;
      const pfx = '/' + String(map[ltr] || '/').split('/').filter(Boolean).join('/');
      const matched = (pfx === '/')
        || norm.toLowerCase() === pfx.toLowerCase()
        || norm.toLowerCase().startsWith(pfx.toLowerCase() + '/');
      if (matched && (!best || pfx.length > best.prefix.length)) {
        best = { letter: ltr.toUpperCase(), prefix: pfx };
      }
    });
    return best;
  }

  function triggerServLynxProtocol(relPath, letter = '') {
    const qs = new URLSearchParams({ path: relPath || '/' });
    if (letter && /^[E-Z]$/i.test(letter)) qs.set('letter', letter.toUpperCase());
    const uri = `servlynx://open?${qs.toString()}`;
    const a = document.createElement('a');
    a.href = uri;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function openItemInLocalDrive(item) {
    if (!item || !item.path) return;
    const match = findMappedDriveForPath(item.path);
    if (match) {
      triggerServLynxProtocol(item.path, match.letter);
      toast(`Abrindo "${item.name}" direto no PC pela unidade ${match.letter}: (sem baixar)...`, 'ok');
      return;
    }
    const parentFolder = item.is_dir
      ? item.path
      : (('/' + item.path.split('/').filter(Boolean).slice(0, -1).join('/')) || '/');
    const savedLtr = (localStorage.getItem('servlynx_drive_letter') || '').toUpperCase();
    showModal('💻 Abrir Direto no PC pelo Drive (Sem Baixar)', `
      <p style="margin-top:0">Você pode abrir <strong>${escapeHtml(item.name)}</strong> diretamente no programa padrão do seu Windows (Word, Excel, AutoCAD, PDF, etc.) pela letra de rede mapeada, sem baixar cópias.</p>
      <div class="drive-steps-box" style="margin-top:8px">
        Se você já instalou o Drive do ServLynx nesta máquina, clique em <strong>Abrir no PC Agora</strong>. Caso ainda não tenha mapeado a pasta <code>${escapeHtml(parentFolder)}</code>, clique em <strong>Instalar Drive Desta Pasta</strong>.
      </div>
    `, [
      {
        text: '🔌 Abrir no PC Agora (Drive já instalado)',
        cls: 'btn-primary',
        onClick: () => {
          closeModal();
          triggerServLynxProtocol(item.path, /^[E-Z]$/.test(savedLtr) ? savedLtr : '');
          toast(`Enviando solicitação de abertura para o Drive local (${item.name})...`, 'ok');
        }
      },
      {
        text: '💿 Instalar Drive Desta Pasta',
        cls: 'btn-secondary',
        onClick: () => {
          closeModal();
          openDriveModal(parentFolder);
        }
      },
      { text: 'Cancelar', cls: 'btn-secondary', onClick: closeModal }
    ]);
  }

  function defaultDriveLabel(relPath) {
    const clean = (relPath || '/').split('/').filter(Boolean);
    if (!clean.length) return 'ServLynx NAS';
    return `ServLynx - ${clean[clean.length - 1]}`;
  }

  function openDriveModal(explicitPath = null) {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
    const userEmail = state.user?.email || state.user?.username || '';
    const cp = currentPath() || '/';
    const startPath = (typeof explicitPath === 'string' && explicitPath.trim()) ? explicitPath.trim() : cp;

    const pathCandidates = [];
    const seenPaths = new Set();
    const pushPathOpt = (p, lbl) => {
      if (!p || seenPaths.has(p)) return;
      seenPaths.add(p);
      pathCandidates.push({ path: p, label: lbl });
    };
    if (startPath !== '/') pushPathOpt(startPath, `📁 Pasta selecionada: ${startPath}`);
    if (cp !== '/' && cp !== startPath) pushPathOpt(cp, `📂 Pasta atual: ${cp}`);
    pushPathOpt('/', '🗄️ Todas as pastas liberadas (Raiz ServLynx)');
    (state.sharesCache || []).forEach((s) => {
      if (s?.name) pushPathOpt(`/${s.name}`, `🗂️ /${s.name}`);
    });
    if (!seenPaths.size) pushPathOpt('/Public', '🗂️ /Public');

    const savedLetterRaw = (localStorage.getItem('servlynx_drive_letter') || 'L').toUpperCase();
    const savedLetter = /^[E-Z]$/.test(savedLetterRaw) ? savedLetterRaw : 'L';
    const letters = 'EFGHIJKLMNOPQRSTUVWXYZ'.split('');

    showModal('💿 Instalar Drive de Rede no Windows & App', `
      <div class="drive-option-card">
        <h4>1. Instalar Pasta como Drive Local no Windows (Abrir e Salvar em Qualquer Programa)</h4>
        <div class="drive-feature-chips">
          <span class="drive-feature-chip">✓ WebClient + 4 GB + Pastas Grandes</span>
          <span class="drive-feature-chip">✓ Word / Excel / AutoCAD / PDF</span>
          <span class="drive-feature-chip">✓ Reconexão ao ligar o PC</span>
          <span class="drive-feature-chip">✓ Chave exclusiva sem expor senha</span>
          <span class="drive-feature-chip">✓ Abrir direto do navegador no PC (sem baixar)</span>
        </div>
        <p>Escolha a pasta do QNAP e uma letra livre no Windows (ex: <strong>S:</strong>, <strong>X:</strong>, <strong>Y:</strong>, <strong>Z:</strong>). O instalador configura automaticamente o Windows e conecta a unidade.</p>

        <div class="form-group" style="margin-bottom:8px">
          <label for="drvPathSel">Pasta ou Subdiretório de Destino</label>
          <select id="drvPathSel">
            ${pathCandidates.map((o) => `<option value="${escapeHtml(o.path)}" ${o.path === startPath ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </div>

        <div class="drive-grid-2">
          <div class="form-group" style="margin-bottom:0">
            <label for="drvLetterSel">Letra do Drive Livre no Windows</label>
            <select id="drvLetterSel">
              ${letters.map((lt) => `<option value="${lt}" ${lt === savedLetter ? 'selected' : ''}>Unidade ${lt}: ${lt === 'L' ? '(Padrão — escolha outra se já estiver em uso)' : ''}</option>`).join('')}
            </select>
            <small style="display:block;margin-top:3px;font-size:11px;color:var(--text-muted)">Escolha uma letra livre no seu PC (ex: S:, X:, Y:, Z:).</small>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label for="drvModeSel">Modo de Conexão</label>
            <select id="drvModeSel">
              <option value="webdav" selected>🌐 WebDAV Seguro HTTPS (Qualquer lugar)</option>
              <option value="smb">🏢 Rede Local QNAP SMB (Somente empresa)</option>
            </select>
          </div>
        </div>

        <div class="form-group" style="margin-bottom:8px">
          <label for="drvLabelInput">Nome do Drive no "Este Computador"</label>
          <input type="text" id="drvLabelInput" maxlength="48" value="${escapeHtml(defaultDriveLabel(startPath))}" placeholder="Ex: ServLynx - Comercial" />
        </div>

        <label class="perm-check" style="margin-bottom:6px;display:flex;align-items:center;gap:8px;font-size:12.5px">
          <input type="checkbox" id="chkDrvAutoStart" checked />
          <span>Reconectar drive automaticamente ao ligar o Windows (Recomendado)</span>
        </label>

        <label class="perm-check" style="margin-bottom:10px;display:flex;align-items:center;gap:8px;font-size:12.5px">
          <input type="checkbox" id="chkDrvDesktopShortcut" checked />
          <span>Criar atalho também na Área de Trabalho do Windows</span>
        </label>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn-primary" id="btnDlBatInstaller">📥 Baixar Instalador do Drive (${savedLetter}:)</button>
          <button type="button" class="btn-secondary" id="btnDlUnmountBat">🔌 Baixar Desinstalador (${savedLetter}:)</button>
          <button type="button" class="btn-secondary" id="btnWatchDriveTutorial">🎬 Assistir Vídeo Tutorial</button>
        </div>

        <div class="drive-steps-box">
          <strong>Como instalar em 3 passos (1 única vez por computador):</strong>
          <ol>
            <li>Clique em <strong>Baixar Instalador do Drive</strong> acima e execute com <strong>duplo clique normal</strong> (não precisa usar "Executar como administrador").</li>
            <li>Se o Windows exibir SmartScreen ou UAC para ajustar o WebDAV (4 GB / timeout), clique em <em>"Mais informações" → "Executar assim mesmo"</em> e <em>Sim</em>.</li>
            <li>Pronto! O drive <strong id="drvLtrStep">${savedLetter}:</strong> abre no Explorer, reconecta ao ligar o PC e aparece em <strong>Abrir / Salvar como</strong> de qualquer programa.</li>
          </ol>
        </div>

        <details class="drive-ps-details">
          <summary>⚡ Instalação alternativa via PowerShell (se o navegador bloquear .bat)</summary>
          <p style="margin:6px 0">Copie o comando abaixo, cole no PowerShell do Windows (Win+R → <code>powershell</code>) e aperte Enter:</p>
          <div class="copy-row">
            <input type="text" readonly id="drvPsOneLiner" value="" />
            <button type="button" class="btn-sm" id="btnCopyPsOneLiner">Copiar Comando</button>
          </div>
        </details>
      </div>

      <div class="drive-option-card">
        <h4>2. Endereço WebDAV Direto (Celular / Mac / Assistente Manual do Windows)</h4>
        <p>Você também pode copiar o endereço WebDAV desta pasta para o app <strong>Arquivos</strong> (iPhone), Solid Explorer (Android), Finder (Mac) ou "Conectar a uma unidade de rede" do Windows:</p>
        <label style="font-size:11.5px;font-weight:600">Endereço WebDAV da Pasta Selecionada:</label>
        <div class="copy-row">
          <input type="text" readonly value="${escapeHtml(buildDavUrl(startPath))}" id="drvDavUrl" />
          <button type="button" class="btn-sm" id="btnCopyDav">Copiar</button>
        </div>
        <label style="font-size:11.5px;font-weight:600;margin-top:8px;display:block">Seu Usuário / Login:</label>
        <div class="copy-row">
          <input type="text" readonly value="${escapeHtml(userEmail)}" id="drvUser" />
          <button type="button" class="btn-sm" id="btnCopyUser">Copiar</button>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn-sm" id="btnRotateDavKey">🔑 Gerar Nova Chave WebDAV (.bat)</button>
          <span style="font-size:11.5px;color:var(--text-muted)">O conector <code>.bat</code> já usa uma chave exclusiva (nunca expõe sua senha principal).</span>
        </div>
        <div id="drvRotatedKeyWrap" class="drive-key-box hidden">
          <div><strong>Nova Chave WebDAV gerada:</strong> <span style="font-size:11px">(baixe um novo .bat se você tinha mapeado antes)</span></div>
          <div class="copy-row" style="margin-top:5px">
            <input type="text" readonly id="drvRotatedKeyVal" value="" />
            <button type="button" class="btn-sm" id="btnCopyDavKey">Copiar Chave</button>
          </div>
        </div>
      </div>

      <div class="drive-option-card" style="margin-bottom:0">
        <h4>3. Instalar como Aplicativo no Celular ou PC (PWA)</h4>
        <p>${isStandalone
          ? 'O ServLynx Drive já está instalado e rodando como aplicativo neste dispositivo!'
          : 'Instale o ServLynx como um app próprio na Tela Inicial do celular ou Área de Trabalho do computador (sem barra de navegador).'}</p>
        <button type="button" class="btn-primary" id="btnPwaInstall">${state.deferredInstallPrompt ? '📲 Instalar Aplicativo Agora' : (isIos ? '📲 Como Instalar no iPhone / iPad' : '📲 Instalar Aplicativo')}</button>
        <div id="pwaInstallHint" class="hidden" style="margin-top:8px;font-size:12px;color:#0f172a;background:#fff;padding:8px 10px;border-radius:6px;border:1px solid var(--border)"></div>
      </div>
    `, [{ text: 'Fechar', cls: 'btn-secondary', onClick: closeModal }], true);

    let labelEdited = false;
    const buildInstallerUrl = (actionType, formatType = 'bat') => {
      const selPath = $('drvPathSel')?.value || '/';
      const ltr = $('drvLetterSel')?.value || 'L';
      const mode = $('drvModeSel')?.value || 'webdav';
      const lbl = ($('drvLabelInput')?.value || '').trim() || defaultDriveLabel(selPath);
      const desk = $('chkDrvDesktopShortcut')?.checked ? '1' : '0';
      const auto = $('chkDrvAutoStart')?.checked ? '1' : '0';
      const qs = new URLSearchParams({
        route: 'drive_installer',
        action: actionType,
        format: formatType,
        path: selPath,
        letter: ltr,
        mode,
        label: lbl,
        desktop_shortcut: desk,
        autostart: auto,
        token: state.token || ''
      });
      return `${window.location.origin}/api.php?${qs.toString()}`;
    };

    const syncDrivePreview = () => {
      const selPath = $('drvPathSel')?.value || '/';
      const ltr = $('drvLetterSel')?.value || 'L';
      localStorage.setItem('servlynx_drive_letter', ltr);
      if (!labelEdited && $('drvLabelInput')) {
        $('drvLabelInput').value = defaultDriveLabel(selPath);
      }
      if ($('drvDavUrl')) $('drvDavUrl').value = buildDavUrl(selPath);
      if ($('btnDlBatInstaller')) $('btnDlBatInstaller').textContent = `📥 Baixar Instalador do Drive (${ltr}:)`;
      if ($('btnDlUnmountBat')) $('btnDlUnmountBat').textContent = `🔌 Baixar Desinstalador (${ltr}:)`;
      if ($('drvLtrStep')) $('drvLtrStep').textContent = `${ltr}:`;
      if ($('drvPsOneLiner')) {
        const psUrl = buildInstallerUrl('mount', 'ps1');
        $('drvPsOneLiner').value = `powershell -ExecutionPolicy Bypass -Command "irm '${psUrl}' | iex"`;
      }
    };

    $('drvPathSel').onchange = syncDrivePreview;
    $('drvLetterSel').onchange = syncDrivePreview;
    $('drvModeSel').onchange = syncDrivePreview;
    $('chkDrvDesktopShortcut').onchange = syncDrivePreview;
    $('chkDrvAutoStart').onchange = syncDrivePreview;
    $('drvLabelInput').oninput = () => { labelEdited = true; syncDrivePreview(); };
    syncDrivePreview();

    $('btnCopyDav').onclick = () => copyTextToClipboard($('drvDavUrl').value, 'URL WebDAV copiada!');
    $('btnCopyUser').onclick = () => copyTextToClipboard(userEmail, 'Usuário copiado!');
    if ($('btnCopyPsOneLiner')) {
      $('btnCopyPsOneLiner').onclick = () => copyTextToClipboard($('drvPsOneLiner').value, 'Comando PowerShell copiado!');
    }

    $('btnRotateDavKey').onclick = async () => {
      const btn = $('btnRotateDavKey');
      btn.disabled = true;
      btn.textContent = 'Gerando...';
      try {
        const res = await apiFetch('rotate_dav_key', { method: 'POST', json: {} });
        $('drvRotatedKeyVal').value = res.dav_key || '';
        $('drvRotatedKeyWrap').classList.remove('hidden');
        toast('Nova chave WebDAV gerada com sucesso!', 'ok');
      } catch (err) {
        toast(err.message || 'Erro ao gerar nova chave.', 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔑 Gerar Nova Chave WebDAV (.bat)';
      }
    };
    if ($('btnCopyDavKey')) {
      $('btnCopyDavKey').onclick = () => copyTextToClipboard($('drvRotatedKeyVal').value, 'Chave WebDAV copiada!');
    }

    const triggerBatDownload = (actionType) => {
      const selPath = $('drvPathSel')?.value || '/';
      const ltr = $('drvLetterSel')?.value || 'L';
      saveMappedDriveEntry(ltr, actionType === 'unmount' ? null : selPath);
      const url = buildInstallerUrl(actionType, 'bat');
      const a = document.createElement('a');
      a.href = url;
      a.download = actionType === 'unmount' ? `Desinstalar_Drive_${ltr}.bat` : `Instalar_Drive_ServLynx_${ltr}.bat`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast(
        actionType === 'unmount'
          ? `Desinstalador do drive ${ltr}: baixado! Execute para remover.`
          : `Instalador do drive ${ltr}: baixado! Execute o arquivo .bat no Windows.`,
        'ok'
      );
    };

    $('btnDlBatInstaller').onclick = () => triggerBatDownload('mount');
    $('btnDlUnmountBat').onclick = () => triggerBatDownload('unmount');
    if ($('btnWatchDriveTutorial')) $('btnWatchDriveTutorial').onclick = () => openDriveTutorialVideoModal();

    $('btnPwaInstall').onclick = async () => {
      if (state.deferredInstallPrompt) {
        state.deferredInstallPrompt.prompt();
        const choice = await state.deferredInstallPrompt.userChoice;
        state.deferredInstallPrompt = null;
        if (choice?.outcome === 'accepted') {
          toast('Aplicativo instalado!', 'ok');
          closeModal();
        }
        return;
      }
      const hint = $('pwaInstallHint');
      if (!hint) return;
      hint.classList.remove('hidden');
      if (isIos) {
        hint.innerHTML = 'No <strong>Safari (iPhone/iPad)</strong>: toque no botão <strong>Compartilhar (⬆️)</strong> na barra inferior e escolha <strong>"Adicionar à Tela de Início"</strong>.';
      } else {
        hint.innerHTML = 'No <strong>Chrome / Edge (Celular ou PC)</strong>: abra o menu do navegador (<strong>⋮</strong> ou ícone de instalação na barra de endereço) e clique em <strong>"Instalar aplicativo ServLynx Drive"</strong>.';
      }
    };
  }

  function openDriveTutorialVideoModal() {
    const streamUrl = `${API_URL}?route=tutorial_video&token=${encodeURIComponent(state.token || '')}`;
    const dlUrl = `${API_URL}?route=tutorial_video&download=1&token=${encodeURIComponent(state.token || '')}`;
    showModal('🎬 Vídeo Tutorial — Como Instalar o Drive no PC', `
      <div>
        <video id="modalVideoPlayer" class="video-player" controls autoplay playsinline preload="metadata" src="${streamUrl}" style="width:100%;max-height:66vh;border-radius:10px;background:#0f172a"></video>
        <div class="drive-steps-box" style="margin-top:10px">
          <strong>Resumo rápido do processo:</strong>
          Entre na pasta desejada → clique em <strong>💿 Instalar Drive (PC)</strong> → escolha uma letra livre (ex: <code>Y:</code>) → baixe o <code>.bat</code> e dê <strong>duplo clique normal</strong> → confirme o UAC. Depois você abre e salva arquivos pela letra sem baixar cópias!
        </div>
      </div>
    `, [
      {
        text: '💿 Abrir Instalador do Drive',
        cls: 'btn-primary',
        onClick: () => {
          closeModal();
          openDriveModal();
        }
      },
      {
        text: '⬇️ Baixar Vídeo (MP4)',
        cls: 'btn-secondary',
        onClick: () => {
          const a = document.createElement('a');
          a.href = dlUrl;
          a.download = 'Tutorial_Instalar_Drive_ServLynx.mp4';
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast('Baixando Tutorial_Instalar_Drive_ServLynx.mp4...', 'ok');
        }
      },
      { text: 'Fechar', cls: 'btn-secondary', onClick: closeModal }
    ], true);
  }

  // ==================== MODAL & CONTEXT MENU ====================
  function showModal(title, bodyHtml, buttons = [], large = false) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    const footer = $('modalFooter');
    footer.innerHTML = '';
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = b.cls || 'btn-secondary';
      btn.textContent = b.text;
      btn.onclick = b.onClick;
      footer.appendChild(btn);
    });
    $('modalDialog').classList.toggle('modal-lg', !!large);
    $('modalBackdrop').classList.remove('hidden');
  }

  function closeModal() {
    const vid = $('modalVideoPlayer');
    if (vid) { try { vid.pause(); vid.src = ''; } catch {} }
    $('modalBackdrop').classList.add('hidden');
  }

  function showContextMenu(x, y, item) {
    const menu = $('contextMenu');
    menu.classList.remove('hidden');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.left = Math.max(8, Math.min(x, vw - 220)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, vh - 320)) + 'px';

    const sel = getSelectedItems();
    const cp = currentPath();
    const canWrite = cp === '/' ? hasAnyWriteAccess() : canWriteCurrentDir();
    contextMenuTargetDir = (item && item.is_dir) ? item.path : null;
    menu.querySelector('[data-ctx="open"]').disabled = sel.length !== 1;
    const openLocalCtxBtn = menu.querySelector('[data-ctx="open-local"]');
    if (openLocalCtxBtn) openLocalCtxBtn.disabled = sel.length !== 1;
    menu.querySelector('[data-ctx="open-tab"]').disabled = !(sel.length === 1 && sel[0].is_dir);
    menu.querySelector('[data-ctx="download"]').disabled = sel.length !== 1;
    menu.querySelector('[data-ctx="paste"]').disabled = !canWrite;
    menu.querySelector('[data-ctx="rename"]').disabled = $('btnRename').disabled;
    menu.querySelector('[data-ctx="cut"]').disabled = $('btnCut').disabled;
    menu.querySelector('[data-ctx="copy"]').disabled = $('btnCopy').disabled;
    menu.querySelector('[data-ctx="delete"]').disabled = $('btnDelete').disabled;
    const shareCtxBtn = menu.querySelector('[data-ctx="share-dir"]');
    if (shareCtxBtn) {
      shareCtxBtn.classList.toggle('hidden', !canAdminShareDirs());
      shareCtxBtn.disabled = !canAdminShareDirs() || !((item && item.is_dir) || cp !== '/');
    }
    const mapDriveCtxBtn = menu.querySelector('[data-ctx="map-drive"]');
    if (mapDriveCtxBtn) {
      mapDriveCtxBtn.disabled = false;
    }
    menu.querySelector('[data-ctx="properties"]').disabled = sel.length !== 1;
  }

  // ==================== EVENTOS DE UI ====================
  function bindEvents() {
    // Login
    $('toggleLoginPass').onclick = () => {
      const inp = $('loginPassword');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    };
    if ($('btnForgotPassLogin')) $('btnForgotPassLogin').onclick = openForgotPasswordModal;
    if ($('btnChangePassLogin')) $('btnChangePassLogin').onclick = openChangePasswordLoginModal;

    $('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      $('loginError').classList.add('hidden');
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      const btn = $('loginSubmit');
      btn.disabled = true;
      btn.textContent = 'Entrando...';
      try {
        const res = await apiFetch('login', { json: { email, password } });
        state.token = res.token;
        localStorage.setItem('servlynx_token', res.token);
        enterApp(res.user, res.bridge_online);
        toast(`Bem-vindo, ${res.user.name}!`, 'ok');
      } catch (err) {
        $('loginError').textContent = err.message;
        $('loginError').classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Entrar no ServLynx';
      }
    };

    $('btnLogout').onclick = async () => {
      try { await apiFetch('logout', { method: 'POST' }); } catch {}
      handleForceLogout();
    };
    $('userChip').onclick = openMyAccountModal;
    $('btnMyAccount').onclick = openMyAccountModal;
    $('btnSideMyAccount').onclick = () => {
      toggleSidebar(false);
      openMyAccountModal();
    };

    // Botões Conectar ao QNAP & Instalar/Drive
    $('btnConnectQnap').onclick = openConnectQnapModal;
    $('topBridgeBadge').onclick = openConnectQnapModal;
    $('btnOpenDriveModal').onclick = () => openDriveModal();
    if ($('btnTopTutorialVideo')) $('btnTopTutorialVideo').onclick = () => openDriveTutorialVideoModal();
    $('btnSideConnectQnap').onclick = () => { toggleSidebar(false); openConnectQnapModal(); };
    $('btnSideDrive').onclick = () => { toggleSidebar(false); openDriveModal(); };
    if ($('btnSideTutorialVideo')) $('btnSideTutorialVideo').onclick = () => { toggleSidebar(false); openDriveTutorialVideoModal(); };
    $('btnSideUpload').onclick = () => { toggleSidebar(false); openUploadModal(); };
    $('btnHeroConnect').onclick = openConnectQnapModal;
    $('btnHeroUpload').onclick = () => openUploadModal();
    $('btnHeroInstallDrive').onclick = () => openDriveModal();
    if ($('btnTopAdminPanel')) $('btnTopAdminPanel').onclick = () => switchSection('qnap-users');
    if ($('btnHeroAdminPanel')) $('btnHeroAdminPanel').onclick = () => switchSection('qnap-users');
    document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
      btn.onclick = () => {
        const t = btn.dataset.adminTab;
        switchSection(t === 'explorer' ? 'explorer' : t);
      };
    });

    // Dropdowns
    $('btnNewMenu').onclick = (e) => {
      e.stopPropagation();
      $('viewDropdown').classList.add('hidden');
      $('newDropdown').classList.toggle('hidden');
    };
    $('btnViewMenu').onclick = (e) => {
      e.stopPropagation();
      $('newDropdown').classList.add('hidden');
      $('viewDropdown').classList.toggle('hidden');
    };
    document.addEventListener('click', () => {
      $('newDropdown').classList.add('hidden');
      $('viewDropdown').classList.add('hidden');
      $('contextMenu').classList.add('hidden');
    });

    document.querySelectorAll('[data-new]').forEach((b) => {
      b.onclick = () => {
        const t = b.dataset.new;
        if (t === 'folder') openNewFolderModal();
        if (t === 'file') openNewFileModal();
        if (t === 'share') openNewShareModal();
        if (t === 'subdir-share') openShareForPath(currentPath());
        if (t === 'user') openUserModal();
      };
    });

    document.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => {
        state.viewMode = b.dataset.view;
        localStorage.setItem('servlynx_view', state.viewMode);
        document.querySelectorAll('.st-vbtn').forEach((sb) => sb.classList.toggle('active', sb.dataset.view === state.viewMode));
        renderFiles();
      };
    });

    $('chkShowHidden').onchange = () => {
      state.showHidden = $('chkShowHidden').checked;
      loadDirectory(currentPath());
    };

    // Ribbon actions
    $('btnOpenItem').onclick = () => { const s = getSelectedItems(); if (s[0]) openItem(s[0]); };
    if ($('btnOpenLocalDrive')) {
      $('btnOpenLocalDrive').onclick = () => { const s = getSelectedItems(); if (s[0]) openItemInLocalDrive(s[0]); };
    }
    $('btnCopy').onclick = () => {
      state.clipboard = { mode: 'copy', items: getSelectedItems().map((i) => i.path) };
      updateToolbarButtons();
      toast(`${state.clipboard.items.length} item(ns) copiado(s).`);
    };
    $('btnCut').onclick = () => {
      state.clipboard = { mode: 'cut', items: getSelectedItems().map((i) => i.path) };
      updateToolbarButtons();
      toast(`${state.clipboard.items.length} item(ns) recortado(s).`);
    };
    $('btnPaste').onclick = () => doPaste(currentPath());
    $('btnRename').onclick = openRenameModal;
    $('btnDelete').onclick = doDeleteSelected;
    $('btnDownload').onclick = () => { const s = getSelectedItems(); if (s[0]) downloadItem(s[0]); };
    $('btnProperties').onclick = openPropertiesModal;
    if ($('btnShareDir')) {
      $('btnShareDir').onclick = () => {
        const sel = getSelectedItems();
        openShareForPath((sel.length === 1 && sel[0].is_dir) ? sel[0].path : currentPath());
      };
    }
    if ($('btnMapDriveCmd')) {
      $('btnMapDriveCmd').onclick = () => {
        const sel = getSelectedItems();
        openDriveModal((sel.length === 1 && sel[0].is_dir) ? sel[0].path : currentPath());
      };
    }
    $('btnUpload').onclick = () => openUploadModal();
    const onInputPicked = async (e) => {
      const inputEl = e.target;
      const picked = Array.from(inputEl.files || []);
      if (!picked.length) {
        directPasteTargetDest = null;
        return;
      }
      const pasteDest = directPasteTargetDest;
      directPasteTargetDest = null;
      try {
        if (pasteDest) {
          closeModal();
          await handleFileUpload(picked, pasteDest);
          return;
        }
        const entries = inputEl === $('folderUploadInput')
          ? picked.map((f) => ({ file: f, name: f.name, size: Number(f.size || 0), relDir: getFileRelDir(f) }))
          : await prepareUploadEntries(picked);
        const dirsSet = new Set();
        entries.forEach((p) => { if (p.relDir) addCumulativeDirs(p.relDir, dirsSet); });
        appendPendingUploadFiles(entries, Array.from(dirsSet).sort((a, b) => a.split('/').length - b.split('/').length));
      } finally {
        inputEl.value = '';
      }
    };
    $('fileUploadInput').onchange = onInputPicked;
    $('photoUploadInput').onchange = onInputPicked;
    $('cameraUploadInput').onchange = onInputPicked;
    $('folderUploadInput').onchange = onInputPicked;

    // Player de Musica Persistente
    const audioEl = $('globalAudio');
    const syncAudioPlayBtn = () => {
      const playing = !audioEl.paused && !audioEl.ended;
      $('audioDisc')?.classList.toggle('playing', playing);
      if ($('btnAudioPlayPause')) $('btnAudioPlayPause').textContent = playing ? '⏸' : '▶';
    };
    audioEl.addEventListener('play', syncAudioPlayBtn);
    audioEl.addEventListener('pause', syncAudioPlayBtn);
    audioEl.addEventListener('ended', () => {
      syncAudioPlayBtn();
      if (state.audio.playlist.length > 1) stepAudioTrack(1);
    });
    $('btnAudioPlayPause').onclick = () => {
      if (audioEl.paused) audioEl.play().catch(() => {});
      else audioEl.pause();
    };
    $('btnAudioPrev').onclick = () => stepAudioTrack(-1);
    $('btnAudioNext').onclick = () => stepAudioTrack(1);
    $('btnAudioList').onclick = openAudioPlaylistModal;
    $('btnAudioClose').onclick = () => {
      audioEl.pause();
      audioEl.src = '';
      $('audioPlayerBar').classList.add('hidden');
    };

    // Mobile Bottom Navigation Bar
    $('mbNavHome').onclick = () => navigateTo('/');
    $('mbNavConnect').onclick = openConnectQnapModal;
    $('mbNavUpload').onclick = () => openUploadModal();
    $('mbNavView').onclick = () => {
      state.viewMode = state.viewMode === 'grid' ? 'details' : 'grid';
      localStorage.setItem('servlynx_view', state.viewMode);
      renderFiles();
      toast(state.viewMode === 'grid' ? 'Visualização em Grade (Miniaturas)' : 'Visualização em Lista', 'info');
    };
    $('mbNavMenu').onclick = () => toggleSidebar();
    if ($('mbNavAdmin')) $('mbNavAdmin').onclick = () => switchSection('qnap-users');
    $('sidebarBackdrop').onclick = () => toggleSidebar(false);

    // Painel Detalhes
    $('btnTogglePreview').onclick = () => {
      state.detailsOpen = !state.detailsOpen;
      $('detailsPane').classList.toggle('hidden', !state.detailsOpen);
      if (state.detailsOpen) renderDetailsPane();
    };
    $('btnCloseDetails').onclick = () => {
      state.detailsOpen = false;
      $('detailsPane').classList.add('hidden');
    };

    // Navegação
    $('btnBack').onclick = () => {
      const tab = activeTab();
      if (tab.historyIdx > 0) {
        tab.historyIdx--;
        tab.path = tab.history[tab.historyIdx];
        renderTabs();
        loadDirectory(tab.path);
      }
    };
    $('btnForward').onclick = () => {
      const tab = activeTab();
      if (tab.historyIdx < tab.history.length - 1) {
        tab.historyIdx++;
        tab.path = tab.history[tab.historyIdx];
        renderTabs();
        loadDirectory(tab.path);
      }
    };
    $('btnUp').onclick = () => {
      const cp = currentPath();
      if (cp === '/') return;
      const parts = cp.split('/').filter(Boolean);
      parts.pop();
      navigateTo('/' + parts.join('/'));
    };
    $('btnRefresh').onclick = () => loadDirectory(currentPath());
    $('btnNewTab').onclick = () => addTab('/');

    // Barra de endereço editável
    $('addressBar').onclick = () => {
      $('breadcrumbs').classList.add('hidden');
      $('addressInput').classList.remove('hidden');
      $('addressInput').focus();
      $('addressInput').select();
    };
    const exitAddrEdit = (commit) => {
      $('addressInput').classList.add('hidden');
      $('breadcrumbs').classList.remove('hidden');
      if (commit) navigateTo($('addressInput').value);
    };
    $('addressInput').onkeydown = (e) => {
      if (e.key === 'Enter') exitAddrEdit(true);
      if (e.key === 'Escape') exitAddrEdit(false);
    };
    $('addressInput').onblur = () => exitAddrEdit(false);

    // Pesquisa
    $('searchInput').onkeydown = (e) => {
      if (e.key === 'Enter') doSearch($('searchInput').value);
    };
    $('searchInput').oninput = () => {
      $('btnClearSearch').classList.toggle('hidden', !$('searchInput').value);
    };
    $('btnClearSearch').onclick = () => {
      $('searchInput').value = '';
      $('btnClearSearch').classList.add('hidden');
      if (state.searchActive) loadDirectory(currentPath());
    };
    $('btnExitSearch').onclick = () => loadDirectory(currentPath());

    // Sidebar nav
    document.querySelectorAll('.sidebar .side-item[data-nav]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.nav === 'explorer') navigateTo(btn.dataset.path || '/');
        else switchSection(btn.dataset.nav);
      };
    });
    $('btnMobileMenu').onclick = () => toggleSidebar();

    // Desmarcar ao clicar no vazio
    $('mainPane').addEventListener('click', () => {
      if (state.currentSection !== 'explorer') return;
      state.selectedPaths.clear();
      syncSelectionUI();
    });

    // Botão direito no vazio
    $('mainPane').addEventListener('contextmenu', (e) => {
      if (state.currentSection !== 'explorer') return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, null);
    });

    // Context menu actions
    $('contextMenu').querySelectorAll('[data-ctx]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.ctx;
        const sel = getSelectedItems();
        if (act === 'open' && sel[0]) openItem(sel[0]);
        if (act === 'open-local' && sel[0]) openItemInLocalDrive(sel[0]);
        if (act === 'open-tab' && sel[0] && sel[0].is_dir) addTab(sel[0].path);
        if (act === 'download' && sel[0]) downloadItem(sel[0]);
        if (act === 'cut') $('btnCut').click();
        if (act === 'copy') $('btnCopy').click();
        if (act === 'paste') doPaste(contextMenuTargetDir || currentPath());
        if (act === 'rename') openRenameModal();
        if (act === 'delete') doDeleteSelected();
        if (act === 'share-dir') openShareForPath((sel.length === 1 && sel[0].is_dir) ? sel[0].path : currentPath());
        if (act === 'map-drive') openDriveModal((sel.length === 1 && sel[0].is_dir) ? sel[0].path : currentPath());
        if (act === 'properties') openPropertiesModal();
      };
    });

    // Drop target na barra de endereço & Acesso Rápido
    bindFolderDropTarget($('addressBar'), () => currentPath());
    document.querySelectorAll('.sidebar .side-item[data-nav="explorer"][data-path]').forEach((btn) => {
      if (btn.dataset.path && btn.dataset.path !== '/') {
        bindFolderDropTarget(btn, () => btn.dataset.path);
      }
    });

    // Drag & Drop Upload e Movimentação Interna no #mainPane
    let dragCounter = 0;
    const mp = $('mainPane');
    mp.addEventListener('dragenter', (e) => {
      if (state.currentSection !== 'explorer') return;
      const types = Array.from(e.dataTransfer?.types || []);
      if (types.includes('Files') || types.includes('application/x-servlynx-paths')) {
        dragCounter++;
        const destTxt = currentPath() === '/' ? 'Escolher pasta no QNAP' : currentPath();
        $('dropTargetLabel').textContent = types.includes('application/x-servlynx-paths')
          ? `Solte sobre uma pasta para mover/copiar (destino atual: ${destTxt})`
          : `Destino: ${destTxt}`;
        $('dropOverlay').classList.remove('hidden');
      }
    });
    mp.addEventListener('dragover', (e) => {
      if (state.currentSection === 'explorer') e.preventDefault();
    });
    mp.addEventListener('dragleave', () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) $('dropOverlay').classList.add('hidden');
    });
    mp.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      $('dropOverlay').classList.add('hidden');
      if (state.currentSection !== 'explorer') return;
      const types = Array.from(e.dataTransfer?.types || []);
      const op = types.includes('application/x-servlynx-paths') && e.ctrlKey ? 'copy' : 'move';
      await handleDropEventPayload(e, currentPath(), op);
    });

    // Admin views buttons
    $('btnRefreshMonitor').onclick = loadMonitorView;
    $('btnQnapBeep').onclick = async () => {
      try {
        await apiFetch('qnap_action', { json: { action: 'beep' } });
        toast('Sinal sonoro (bip) enviado para o QNAP!', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    $('btnQnapRestartSamba').onclick = async () => {
      try {
        toast('Reiniciando serviço SMB/Samba no QNAP...');
        await apiFetch('qnap_action', { json: { action: 'restart_smb' } });
        toast('Samba reiniciado com sucesso!', 'ok');
        loadMonitorView();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('btnOpenNewShare').onclick = openNewShareModal;
    if ($('btnOpenNewSubdirShare')) $('btnOpenNewSubdirShare').onclick = () => openSubdirAccessModal('');
    $('btnOpenNewUser').onclick = () => openUserModal(null);
    if ($('btnOpenNotifyConfig')) $('btnOpenNotifyConfig').onclick = openNotifyConfigModal;
    $('btnOpenNewQnapUser').onclick = openNewQnapUserModal;

    // Modal close
    $('modalClose').onclick = closeModal;
    $('modalBackdrop').onclick = (e) => {
      if (e.target === $('modalBackdrop')) closeModal();
    };

    // Atalhos de Teclado Windows Explorer & Lightbox
    document.addEventListener('keydown', (e) => {
      if (!$('modalBackdrop').classList.contains('hidden')) {
        if (e.key === 'Escape') closeModal();
        if ($('lightboxStage')) {
          if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
          if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
        }
        return;
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (state.currentSection !== 'explorer') return;

      if (e.key === 'F5') { e.preventDefault(); loadDirectory(currentPath()); }
      if (e.key === 'F2' && !$('btnRename').disabled) { e.preventDefault(); openRenameModal(); }
      if (e.key === 'Delete' && !$('btnDelete').disabled) { e.preventDefault(); doDeleteSelected(); }
      if (e.key === 'Backspace') { e.preventDefault(); $('btnUp').click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !$('btnCopy').disabled) { e.preventDefault(); $('btnCopy').click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && !$('btnCut').disabled) { e.preventDefault(); $('btnCut').click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        state.items.forEach((i) => state.selectedPaths.add(i.path));
        syncSelectionUI();
      }
    });

    // Colar Global (Ctrl+V do Windows Explorer ou Área de Transferência ServLynx)
    window.addEventListener('paste', async (e) => {
      if (!state.token || state.currentSection !== 'explorer') return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

      const modalOpen = !$('modalBackdrop').classList.contains('hidden');
      const isPasteHelperModal = modalOpen && !!$('pasteDestFolder');
      if (modalOpen && !isPasteHelperModal) return;

      // IMPORTANTE: coletar entries e files antes de qualquer await
      const rawEntries = Array.from(e.clipboardData?.items || [])
        .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
      const fallbackFiles = Array.from(e.clipboardData?.files || []);

      if (rawEntries.length || fallbackFiles.length) {
        e.preventDefault();
        const chosenDest = isPasteHelperModal ? ($('pasteDestFolder')?.value || currentPath()) : currentPath();
        if (isPasteHelperModal) closeModal();
        await handleExternalTransfer(rawEntries, fallbackFiles, chosenDest);
        return;
      }

      if (!modalOpen && (canWriteCurrentDir() || hasAnyWriteAccess())) {
        e.preventDefault();
        await doPaste(currentPath());
      }
    });
  }

  // Inicializa
  bindEvents();
  initSession();
})();
