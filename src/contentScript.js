(() => {
  if (window.__opinionPolymarketLoaded) {
    return;
  }
  window.__opinionPolymarketLoaded = true;

  const TITLE_SELECTORS = [
    'h1.text-h1.font-monospace.line-clamp-2',
    'h1.text-h1.font-monospace',
    'h1.text-h1',
    '[data-testid="market-title"]',
    '[data-testid="question-title"]',
    '[class*="MarketHeader"] h1',
    'main h1',
    'h1'
  ];

  const state = {
    lastAutoTitle: null,
    lastRequestId: 0,
    overlay: null,
    initialized: false,
    sortBy: (() => {
      // 从 localStorage 读取保存的排序选择，默认为 'default'
      try {
        return localStorage.getItem('opinion-poly-sort') || 'default';
      } catch {
        return 'default';
      }
    })(),
    theme: (() => {
      // 从 localStorage 读取保存的主题，如果没有则检测系统偏好
      try {
        const saved = localStorage.getItem('opinion-poly-theme');
        if (saved === 'light' || saved === 'dark') {
          return saved;
        }
        // 检测系统偏好
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          return 'dark';
        }
        return 'light';
      } catch {
        return 'light';
      }
    })()
  };

  function isDetailPage() {
    const url = new URL(window.location.href);
    return url.pathname.includes('/detail') || url.searchParams.has('topicId');
  }

  function cleanup() {
    if (state.overlay?.element) {
      state.overlay.element.setAttribute('data-hidden', 'true');
      state.overlay.element.remove();
      state.overlay = null;
    }
    state.lastAutoTitle = null;
    state.initialized = false;
    if (state.titleCheckTimer) {
      clearTimeout(state.titleCheckTimer);
      state.titleCheckTimer = null;
    }
  }

  function handleRouteChange() {
    if (isDetailPage()) {
      if (!state.initialized) {
        waitForBody(() => {
          // 等待标题元素出现，而不是只等待 body
          waitForTitle(() => {
            setTimeout(() => {
              initialize();
              scheduleTitleCheckWithRetry(0, 5);
            }, 100);
          });
        });
      } else {
        // 已初始化但路由变化，重新检查标题
        state.lastAutoTitle = null;
        scheduleTitleCheck(100);
      }
    } else {
      if (state.initialized) {
        cleanup();
      }
    }
  }

  function scheduleTitleCheckWithRetry(delay, maxRetries) {
    if (state.titleCheckTimer) {
      clearTimeout(state.titleCheckTimer);
    }
    state.titleCheckTimer = setTimeout(() => {
      // 如果还没初始化完成，等待初始化
      if (!state.initialized || !state.overlay) {
        // 如果还有重试次数，继续等待
        if (maxRetries > 0) {
          scheduleTitleCheckWithRetry(300, maxRetries - 1);
        }
        return;
      }
      
      const detected = detectTitle();
      
      if (detected && detected !== state.lastAutoTitle) {
        // 找到标题，停止重试
        state.lastAutoTitle = detected;
        triggerLookup(detected, 'auto');
        return;
      }
      
      // 如果还没找到且还有重试次数，继续重试
      if (maxRetries > 0) {
        scheduleTitleCheckWithRetry(300, maxRetries - 1);
      } else {
        // 重试次数用完，显示提示
        if (!state.lastAutoTitle && state.overlay) {
          state.overlay.setIdle('尚未定位到 Opinion 事件标题，可尝试手动选择文本后按 Alt+P。');
        }
      }
    }, delay);
  }

  // 监听路由变化
  let lastUrl = window.location.href;
  const checkUrlChange = () => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      handleRouteChange();
    }
  };

  // 拦截 pushState 和 replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(history, args);
    setTimeout(checkUrlChange, 50);
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(history, args);
    setTimeout(checkUrlChange, 50);
  };

  window.addEventListener('popstate', () => {
    setTimeout(checkUrlChange, 50);
  });

  // 定期检查 URL 变化（作为兜底）
  setInterval(checkUrlChange, 500);

  // 初始检查
  handleRouteChange();

  function waitForBody(callback) {
    if (document.body) {
      callback();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }

  function waitForTitle(callback, maxWait = 5000) {
    // 先立即检查一次
    if (detectTitle()) {
      callback();
      return;
    }
    
    const startTime = Date.now();
    const observer = new MutationObserver(() => {
      if (detectTitle()) {
        observer.disconnect();
        callback();
        return;
      }
      
      // 超时检查
      if (Date.now() - startTime > maxWait) {
        observer.disconnect();
        callback(); // 超时也执行回调，让重试机制继续工作
      }
    });
    
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function initialize() {
    if (state.initialized) {
      return;
    }
    injectStyles();
    state.overlay = createOverlay();
    
    // 监听系统主题变化
    if (window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleThemeChange = (e) => {
        // 只有在用户没有手动设置主题时才跟随系统
        try {
          const saved = localStorage.getItem('opinion-poly-theme');
          if (!saved || saved === 'auto') {
            const newTheme = e.matches ? 'dark' : 'light';
            state.theme = newTheme;
            if (state.overlay?.element) {
              state.overlay.element.setAttribute('data-theme', newTheme);
              const themeBtn = state.overlay.element.querySelector('button[data-theme-toggle]');
              if (themeBtn) {
                themeBtn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
              }
            }
          }
        } catch (err) {
          console.warn('[Opinion↔Polymarket] 无法读取主题设置:', err);
        }
      };
      // 使用 addEventListener 如果支持，否则使用 addListener
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', handleThemeChange);
      } else {
        mediaQuery.addListener(handleThemeChange);
      }
    }
    setupDomObservers();
    setupKeyboardShortcut();
    // 标题检查已在 handleRouteChange 中处理，这里不需要重复调用
    state.initialized = true;
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #opinion-polymarket-overlay {
        position: fixed;
        bottom: 24px;
        right: 14px;
        z-index: 2147483647;
        font-family: "Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        --bg-primary: rgba(255, 255, 255, 0.98);
        --bg-secondary: #ffffff;
        --bg-tertiary: #f8fafc;
        --bg-footer: rgba(248, 250, 252, 0.5);
        --text-primary: #0f172a;
        --text-secondary: #64748b;
        --text-tertiary: #475467;
        --text-inverse: #fff;
        --border-color: rgba(15, 23, 42, 0.08);
        --border-light: rgba(27, 99, 255, 0.15);
        --border-hover: rgba(27, 99, 255, 0.3);
        --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.05);
        --shadow-md: 0 2px 6px rgba(27, 99, 255, 0.1);
        --shadow-lg: 0 20px 60px rgba(15, 23, 42, 0.15), 0 0 0 1px rgba(15, 23, 42, 0.05);
        --shadow-header: 0 2px 8px rgba(27, 99, 255, 0.2);
        --btn-bg: #fff;
        --btn-border: rgba(27, 99, 255, 0.2);
        --btn-hover-bg: rgba(27, 99, 255, 0.05);
        color: var(--text-primary);
      }

      #opinion-polymarket-overlay[data-theme="dark"] {
        --bg-primary: rgba(15, 23, 42, 0.98);
        --bg-secondary: #1e293b;
        --bg-tertiary: #0f172a;
        --bg-footer: rgba(15, 23, 42, 0.8);
        --text-primary: #f1f5f9;
        --text-secondary: #94a3b8;
        --text-tertiary: #64748b;
        --text-inverse: #fff;
        --border-color: rgba(148, 163, 184, 0.15);
        --border-light: rgba(27, 99, 255, 0.3);
        --border-hover: rgba(27, 99, 255, 0.5);
        --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
        --shadow-md: 0 2px 6px rgba(0, 0, 0, 0.4);
        --shadow-lg: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(148, 163, 184, 0.1);
        --shadow-header: 0 2px 8px rgba(27, 99, 255, 0.3);
        --btn-bg: #1e293b;
        --btn-border: rgba(27, 99, 255, 0.3);
        --btn-hover-bg: rgba(27, 99, 255, 0.15);
      }

      #opinion-polymarket-overlay[data-hidden="true"] {
        display: none;
      }

      #opinion-polymarket-overlay .opi-poly-card {
        width: 300px;
        max-width: calc(100vw - 48px);
        max-height: 700px;
        background: var(--bg-primary);
        border-radius: 16px;
        box-shadow: var(--shadow-lg);
        backdrop-filter: blur(12px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      #opinion-polymarket-overlay[data-collapsed="true"] .opi-poly-card__body,
      #opinion-polymarket-overlay[data-collapsed="true"] .opi-poly-card__footer {
        display: none;
      }

      .opi-poly-card__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 18px;
        background: linear-gradient(135deg, #1b63ff 0%, #5a8bff 50%, #8bb5ff 100%);
        color: var(--text-inverse);
        font-weight: 600;
        font-size: 14px;
        box-shadow: var(--shadow-header);
      }

      .opi-poly-card__header button {
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        font-size: 16px;
        padding: 4px;
        line-height: 1;
        transition: opacity 0.2s ease;
      }

      .opi-poly-card__header button:hover {
        opacity: 0.8;
      }

      .opi-poly-theme-toggle {
        font-size: 14px;
        margin-right: 4px;
        cursor: pointer;
        user-select: none;
      }

      .opi-poly-card__body {
        padding: 16px 18px;
        overflow-y: auto;
        overflow-x: hidden;
        flex: 1;
        min-height: 0;
        max-height: calc(700px - 120px);
      }

      .opi-poly-status {
        font-size: 12px;
        margin: 0 0 10px;
        color: var(--text-secondary);
        line-height: 1.5;
        font-weight: 500;
      }

      .opi-poly-title {
        font-weight: 600;
        font-size: 15px;
        margin: 0 0 14px;
        color: var(--text-primary);
        line-height: 1.4;
      }

      .opi-poly-sort {
        margin: 0 0 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .opi-poly-sort label {
        font-size: 11px;
        color: var(--text-secondary);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        white-space: nowrap;
      }

      .opi-poly-sort-btn {
        padding: 4px 8px;
        border: 1px solid var(--btn-border);
        border-radius: 4px;
        background: var(--btn-bg);
        font-size: 11px;
        color: var(--text-secondary);
        font-weight: 500;
        cursor: pointer;
        outline: none;
        transition: all 0.2s ease;
        text-align: center;
        width: auto;
        min-width: 60px;
      }

      .opi-poly-sort-btn:hover {
        border-color: var(--border-hover);
        background: var(--btn-hover-bg);
      }

      .opi-poly-sort-btn.active {
        background: linear-gradient(135deg, #1b63ff 0%, #5a8bff 100%);
        color: #fff;
        border-color: #1b63ff;
        font-weight: 600;
      }

      .opi-poly-prices {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .opi-poly-market-card {
        margin-bottom: 6px;
        padding: 8px;
        background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
        border-radius: 8px;
        border: 1px solid var(--border-light);
        box-shadow: var(--shadow-sm);
        transition: all 0.2s ease;
        width: 100%;
      }

      .opi-poly-market-card.target {
        border: 2px solid #1b63ff;
        background: linear-gradient(135deg, rgba(27, 99, 255, 0.15) 0%, rgba(27, 99, 255, 0.08) 100%);
        box-shadow: 0 4px 12px rgba(27, 99, 255, 0.15);
      }

      .opi-poly-market-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }

      .opi-poly-market-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-primary);
        letter-spacing: 0.3px;
      }

      .opi-poly-market-card.target .opi-poly-market-title {
        color: #1b63ff;
      }

      .opi-poly-market-outcomes {
        display: flex;
        flex-wrap: nowrap;
        gap: 6px;
      }

      .opi-poly-price {
        flex: 1 1 auto;
        min-width: 0;
        background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
        border-radius: 6px;
        padding: 6px 8px;
        border: 1.5px solid var(--border-light);
        transition: all 0.2s ease;
        box-shadow: var(--shadow-sm);
      }

      .opi-poly-price:hover {
        border-color: var(--border-hover);
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }

      .opi-poly-price {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .opi-poly-price strong {
        display: inline-block;
        font-size: 10px;
        color: var(--text-secondary);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .opi-poly-price span {
        display: inline-block;
        font-size: 16px;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.2;
      }

      .opi-poly-card__footer {
        padding: 12px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border-top: 1px solid var(--border-color);
        background: var(--bg-footer);
      }

      .opi-poly-link {
        color: #1b63ff;
        font-weight: 600;
        text-decoration: none;
        font-size: 13px;
      }

      .opi-poly-link:hover {
        text-decoration: underline;
      }

      .opi-poly-hint {
        font-size: 11px;
        color: var(--text-tertiary);
      }
    `;
    document.head.appendChild(style);
  }

  function createOverlay() {
    const mount = document.createElement('div');
    mount.id = 'opinion-polymarket-overlay';
    mount.innerHTML = `
      <div class="opi-poly-card">
        <div class="opi-poly-card__header">
          <span>Polymarket 价格</span>
          <div>
            <button type="button" class="opi-poly-theme-toggle" data-theme-toggle title="切换主题">🌓</button>
            <button type="button" data-collapse>▾</button>
            <button type="button" data-close>×</button>
          </div>
        </div>
        <div class="opi-poly-card__body">
          <p class="opi-poly-status">等待获取 Opinion 事件标题…</p>
          <p class="opi-poly-title"></p>
          <div class="opi-poly-sort" style="display:none;">
            <label>排序:</label>
            <button type="button" class="opi-poly-sort-btn" data-sort="default">默认</button>
            <button type="button" class="opi-poly-sort-btn" data-sort="yes-desc">Yes 价格 ↓</button>
          </div>
          <div class="opi-poly-prices"></div>
        </div>
        <div class="opi-poly-card__footer">
          <a class="opi-poly-link" href="https://polymarket.com/" target="_blank" rel="noopener noreferrer">打开 Polymarket</a>
          <span class="opi-poly-hint">Alt+P 手动查询</span>
        </div>
      </div>
    `;

    document.body.appendChild(mount);

    const statusEl = mount.querySelector('.opi-poly-status');
    const titleEl = mount.querySelector('.opi-poly-title');
    const priceEl = mount.querySelector('.opi-poly-prices');
    const linkEl = mount.querySelector('.opi-poly-link');
    const collapseBtn = mount.querySelector('button[data-collapse]');
    const closeBtn = mount.querySelector('button[data-close]');
    const themeToggleBtn = mount.querySelector('button[data-theme-toggle]');
    const sortEl = mount.querySelector('.opi-poly-sort');
    const sortBtns = mount.querySelectorAll('button[data-sort]');

    // 应用初始主题
    mount.setAttribute('data-theme', state.theme);
    if (themeToggleBtn) {
      themeToggleBtn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
    }

    collapseBtn?.addEventListener('click', () => {
      const collapsed = mount.getAttribute('data-collapsed') === 'true';
      mount.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
      collapseBtn.textContent = collapsed ? '▾' : '▴';
    });

    closeBtn?.addEventListener('click', () => {
      const hidden = mount.getAttribute('data-hidden') === 'true';
      mount.setAttribute('data-hidden', hidden ? 'false' : 'true');
    });

    // 主题切换按钮
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const newTheme = state.theme === 'dark' ? 'light' : 'dark';
        state.theme = newTheme;
        
        // 保存到 localStorage
        try {
          localStorage.setItem('opinion-poly-theme', newTheme);
        } catch (err) {
          console.warn('[Opinion↔Polymarket] 无法保存主题选择:', err);
        }
        
        // 更新 UI
        mount.setAttribute('data-theme', newTheme);
        themeToggleBtn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
      });
    }

    // 排序按钮点击事件
    sortBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const newSortBy = btn.getAttribute('data-sort');
        state.sortBy = newSortBy;
        
        // 保存到 localStorage
        try {
          localStorage.setItem('opinion-poly-sort', newSortBy);
        } catch (err) {
          console.warn('[Opinion↔Polymarket] 无法保存排序选择:', err);
        }
        
        // 更新按钮激活状态
        sortBtns.forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-sort') === newSortBy);
        });
        
        // 重新渲染市场列表
        if (state.currentMarkets && state.currentMarkets.length > 0) {
          const sorted = sortMarkets(state.currentMarkets, state.sortBy);
          const targetMarketId = state.currentTargetMarketId;
          priceEl.innerHTML = sorted
            .map((market) => renderMarket(market, market.id === targetMarketId))
            .join('');
        }
      });
    });

    return {
      element: mount,
      setLoading(title, source) {
        mount.setAttribute('data-hidden', 'false');
        mount.setAttribute('data-collapsed', 'false');
        statusEl.textContent = `正在根据「${title}」查询 Polymarket 价格${source === 'selection' ? '（来自手动选中）' : ''}…`;
        titleEl.textContent = '';
        priceEl.innerHTML = '';
        sortEl.style.display = 'none';
      },
      setIdle(message) {
        statusEl.textContent = message;
        titleEl.textContent = '';
        priceEl.innerHTML = '';
        sortEl.style.display = 'none';
      },
      setError(message) {
        statusEl.textContent = `查询失败：${message}`;
        titleEl.textContent = '';
        priceEl.innerHTML = '';
        sortEl.style.display = 'none';
      },
      setResult(payload) {
        const status = payload?.status ?? null;
        const matches = payload?.matches ?? [];
        if (status && status !== 'OK') {
          statusEl.textContent = payload?.message ?? 'Polymarket 暂无匹配事件。';
          titleEl.textContent = `Opinion 标题：${payload?.query ?? '未知'}`;
          priceEl.innerHTML = '';
          sortEl.style.display = 'none';
          linkEl.textContent = '打开 Polymarket';
          linkEl.href = 'https://polymarket.com/';
          return;
        }

        if (!matches.length) {
          statusEl.textContent = 'Polymarket 暂无匹配事件，请尝试选中文本后按 Alt+P 再试。';
          titleEl.textContent = `Opinion 标题：${payload?.query ?? '未知'}`;
          priceEl.innerHTML = '';
          sortEl.style.display = 'none';
          linkEl.textContent = '打开 Polymarket';
          linkEl.href = 'https://polymarket.com/';
          return;
        }

        const [best] = matches;
        statusEl.textContent = `Polymarket 事件：`;
        titleEl.textContent = best.title ?? '(未命名)';
        linkEl.textContent = '在 Polymarket 查看';
        linkEl.href = best.url ?? 'https://polymarket.com/';

        const allMarkets = best.markets ?? [];
        if (allMarkets.length) {
          // 保存当前市场和目标市场ID
          state.currentMarkets = allMarkets;
          state.currentTargetMarketId = best.targetMarketId;
          
          // 应用排序
          const sorted = sortMarkets(allMarkets, state.sortBy);
          
          // 显示排序控件（如果有多个市场）
          if (allMarkets.length > 1) {
            sortEl.style.display = 'flex';
            // 更新按钮激活状态
            sortBtns.forEach(btn => {
              btn.classList.toggle('active', btn.getAttribute('data-sort') === state.sortBy);
            });
          } else {
            sortEl.style.display = 'none';
          }
          
          priceEl.innerHTML = sorted
            .map((market) => renderMarket(market, market.id === best.targetMarketId))
            .join('');
        } else {
          priceEl.innerHTML = '<p style="font-size:12px;color:var(--text-tertiary);">暂未找到该事件的价格信息。</p>';
          sortEl.style.display = 'none';
        }
      }
    };
  }

  function renderMarket(market, isTarget) {
    const marketTitle = market.groupItemTitle || market.question || '未命名市场';
    const outcomes = market.outcomes || [];
    const cardClass = isTarget ? 'opi-poly-market-card target' : 'opi-poly-market-card';
    
    return `
      <div class="${cardClass}">
        <div class="opi-poly-market-header">
          <div class="opi-poly-market-title">
            ${marketTitle}
          </div>
        </div>
        <div class="opi-poly-market-outcomes">
          ${outcomes.map((outcome) => renderOutcome(outcome)).join('')}
        </div>
      </div>
    `;
  }

  function renderOutcome(outcome) {
    const label = outcome.label ?? '未知';
    const price = Number(outcome.price ?? 0);
    const cents = `${(price * 100).toFixed(1)}¢`;
    const labelColor = label.toLowerCase() === 'yes' ? '#BBE12E' : label.toLowerCase() === 'no' ? '#4787FE' : '#64748b';
    return `
      <div class="opi-poly-price">
        <strong style="color: ${labelColor};">${label}</strong>
        <span>${cents}</span>
      </div>
    `;
  }

  function setupDomObservers() {
    let debounceTimer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (isDetailPage()) {
          scheduleTitleCheck(0);
        }
      }, 250);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });

    window.addEventListener('popstate', () => {
      if (isDetailPage()) {
        scheduleTitleCheck(0);
      }
    });
    window.addEventListener('hashchange', () => {
      if (isDetailPage()) {
        scheduleTitleCheck(0);
      }
    });
    // 定期检查标题（仅在详情页）
    setInterval(() => {
      if (isDetailPage()) {
        scheduleTitleCheck(0);
      }
    }, 2000);
  }

  function setupKeyboardShortcut() {
    document.addEventListener('keydown', (event) => {
      if (!event.altKey || event.key.toLowerCase() !== 'p') {
        return;
      }
      const selection = String(window.getSelection()?.toString() ?? '').trim();
      if (selection) {
        triggerLookup(selection, 'selection');
      } else if (state.lastAutoTitle) {
        triggerLookup(state.lastAutoTitle, 'shortcut');
      }
    });
  }

  function scheduleTitleCheck(delay) {
    if (state.titleCheckTimer) {
      clearTimeout(state.titleCheckTimer);
    }
    state.titleCheckTimer = setTimeout(() => {
      // 如果还没初始化完成，不执行
      if (!state.initialized || !state.overlay) {
        return;
      }
      
      const detected = detectTitle();
      if (!detected || detected === state.lastAutoTitle) {
        if (!state.lastAutoTitle && state.overlay) {
          state.overlay.setIdle('尚未定位到 Opinion 事件标题，可尝试手动选择文本后按 Alt+P。');
        }
        return;
      }
      state.lastAutoTitle = detected;
      triggerLookup(detected, 'auto');
    }, delay);
  }

  function detectTitle() {
    for (const selector of TITLE_SELECTORS) {
      const element = document.querySelector(selector);
      const text = cleanText(element?.textContent);
      if (isValidTitle(text)) {
        return text;
      }
    }

    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (isValidTitle(ogTitle)) {
      return cleanText(ogTitle);
    }

    const pageTitle = document.title?.split('|')[0];
    if (isValidTitle(pageTitle)) {
      return cleanText(pageTitle);
    }

    return null;
  }

  function cleanText(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
  }

  function isValidTitle(text) {
    return typeof text === 'string' && cleanText(text).length >= 6;
  }

  function triggerLookup(title, source) {
    if (!state.overlay) {
      return;
    }
    const requestId = ++state.lastRequestId;
    state.overlay.setLoading(title, source);
    chrome.runtime.sendMessage(
      {
        type: 'FETCH_POLYMARKET_PRICE',
        title
      },
      (response) => {
        if (requestId !== state.lastRequestId) {
          return; // 结果已过期
        }
        if (chrome.runtime.lastError || !response) {
          state.overlay.setError('无法连接扩展后台');
          return;
        }
        if (!response.ok) {
          state.overlay.setError(response.error ?? '未知错误');
          return;
        }
        state.overlay.setResult(response.payload);
      }
    );
  }

  function sortMarkets(markets, sortBy) {
    if (!markets || markets.length === 0) {
      return markets;
    }

    // 如果是默认排序，直接返回（保持 background.js 中的排序）
    if (sortBy === 'default') {
      return markets;
    }

    const sorted = [...markets];

    switch (sortBy) {
      case 'yes-desc':
        sorted.sort((a, b) => {
          const priceA = getYesPrice(a);
          const priceB = getYesPrice(b);
          return priceB - priceA; // 降序
        });
        break;
      default:
        // 默认情况，保持原顺序
        break;
    }

    return sorted;
  }

  function getYesPrice(market) {
    const outcomes = market.outcomes || [];
    const yesOutcome = outcomes.find(o => o.label?.toLowerCase() === 'yes');
    return Number(yesOutcome?.price ?? 0);
  }
})();

