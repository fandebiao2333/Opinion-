const POLYMARKET_EVENT_API = 'https://gamma-api.polymarket.com/events';

// GitHub Raw URL - 映射配置文件地址
// 格式：https://raw.githubusercontent.com/用户名/仓库名/分支名/路径/mapping.json
const MAPPING_GITHUB_URL = 'https://raw.githubusercontent.com/fandebiao2333/Opinion-/main/src/config/mapping.json';

const STATUS_MESSAGES = {
  NO_MAPPING: 'Polymarket 上暂无该事件映射，请稍后再试。',
  EVENT_NOT_FOUND: 'Polymarket 暂未找到对应事件，可能已下架或更换链接。',
  NO_MARKETS: '该事件暂未开放市场数据。',
  MARKET_NOT_FOUND: '未找到配置中指定的子市场，请检查 outcomeKey 设置。'
};

const mappingPromise = loadMapping();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'FETCH_POLYMARKET_PRICE') {
    return;
  }

  handlePriceLookup(message.title)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => {
      console.error('[Opinion↔Polymarket] 查询失败:', error);
      sendResponse({ ok: false, error: error.message ?? String(error) });
    });

  return true;
});

async function loadMapping() {
  // 优先从 GitHub Raw URL 加载
  try {
    const response = await fetch(MAPPING_GITHUB_URL, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      console.log('[Opinion↔Polymarket] 从 GitHub 加载映射配置成功');
      return data;
    }
  } catch (error) {
    console.warn('[Opinion↔Polymarket] 从 GitHub 加载映射配置失败，尝试使用本地备份:', error);
  }

  // 如果远程加载失败，使用本地备份
  try {
    const localUrl = chrome.runtime.getURL('src/config/mapping.json');
    const response = await fetch(localUrl);
    if (response.ok) {
      const data = await response.json();
      console.log('[Opinion↔Polymarket] 使用本地映射配置');
      return data;
    }
  } catch (error) {
    console.error('[Opinion↔Polymarket] 本地映射配置加载失败:', error);
  }

  throw new Error('无法加载映射配置文件，请检查网络连接或联系开发者');
}

async function handlePriceLookup(rawTitle) {
  const title = String(rawTitle ?? '').trim();
  if (!title) {
    throw new Error('请提供有效的事件标题');
  }

  const mapping = await mappingPromise;
  const entry = resolveMappingEntry(mapping, title);
  if (!entry) {
    return buildEmptyResult(title, 'NO_MAPPING');
  }

  const event = await fetchEventBySlug(entry.slug);
  if (!event) {
    return buildEmptyResult(title, 'EVENT_NOT_FOUND');
  }

  const markets = Array.isArray(event.markets)
    ? event.markets.map((market) => normalizeMarket(market)).filter(Boolean)
    : [];

  if (!markets.length) {
    return buildEmptyResult(title, 'NO_MARKETS');
  }

  // 如果有 outcomeKey，只返回匹配的市场；否则返回所有市场
  let filteredMarkets = markets;
  let targetMarket = null;
  
  if (entry.outcomeKey) {
    targetMarket = pickTargetMarket(markets, entry.outcomeKey);
    if (!targetMarket) {
      return buildEmptyResult(title, 'MARKET_NOT_FOUND');
    }
    // 只返回匹配的市场
    filteredMarkets = [targetMarket];
  } else {
    // 如果没有 outcomeKey，按金额排序
    filteredMarkets = sortMarketsByAmount(filteredMarkets);
  }

  return {
    query: title,
    fetchedAt: Date.now(),
    status: 'OK',
    resolvedSlug: entry.slug,
    matches: [buildMatch(event, filteredMarkets, targetMarket, entry.outcomeKey)]
  };
}

async function fetchEventBySlug(slug) {
  const encodedSlug = encodeURIComponent(slug);
  const url = `${POLYMARKET_EVENT_API}?slug=${encodedSlug}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Polymarket API 返回 ${response.status}`);
  }

  const payload = await response.json();
  const events = extractEvents(payload);
  return events[0] ?? null;
}

function extractEvents(payload) {
  if (Array.isArray(payload?.events)) {
    return payload.events;
  }
  if (Array.isArray(payload?.value)) {
    return payload.value;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function resolveMappingEntry(mapping, title) {
  const rawEntry = mapping[title];
  if (!rawEntry) {
    return null;
  }
  if (typeof rawEntry === 'string') {
    return { slug: rawEntry, outcomeKey: null };
  }
  if (typeof rawEntry === 'object' && rawEntry.slug) {
    return {
      slug: rawEntry.slug,
      outcomeKey: rawEntry.outcomeKey ?? null
    };
  }
  return null;
}

function buildEmptyResult(query, status) {
  return {
    query,
    fetchedAt: Date.now(),
    status,
    message: STATUS_MESSAGES[status] ?? '查询失败，请稍后再试。',
    matches: []
  };
}

function buildMatch(event, markets, targetMarket, outcomeKey) {
  return {
    eventId: event.id,
    slug: event.slug,
    url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
    title: event.title,
    score: 1,
    bestMarket: targetMarket,
    markets,
    targetMarketId: targetMarket?.id ?? null,
    outcomeKey
  };
}

function normalizeMarket(market) {
  // 过滤掉非活跃的市场
  if (market.active === false) {
    return null;
  }

  // 过滤掉流动性为 0 的市场
  const liquidity = Number(market.liquidity ?? market.liquidityNum ?? 0);
  if (liquidity === 0) {
    return null;
  }

  const outcomes = parseMaybeJsonArray(market.outcomes);
  const bestAsk = typeof market.bestAsk === 'number' && Number.isFinite(market.bestAsk) ? market.bestAsk : null;
  const bestBid = typeof market.bestBid === 'number' && Number.isFinite(market.bestBid) ? market.bestBid : null;
  
  // 如果没有 bestAsk/bestBid，回退到 outcomePrices
  const fallbackPrices = parseMaybeJsonArray(market.outcomePrices).map(Number);
  const useBestAsk = bestAsk !== null;

  if (!outcomes.length) {
    return null;
  }

  const normalizedOutcomes = outcomes.map((label, index) => {
    let price = 0;
    
    if (useBestAsk) {
      // 使用 bestAsk 和 bestBid
      const labelLower = String(label).toLowerCase();
      if (labelLower === 'yes') {
        // Yes 的价格使用 bestAsk（买入 Yes 的价格）
        price = bestAsk;
      } else if (labelLower === 'no') {
        // No 的价格使用 1 - bestBid
        if (bestBid !== null) {
          price = 1 - bestBid;
        } else {
          // 如果没有 bestBid，回退到 outcomePrices
          price = fallbackPrices[index] ?? 0;
        }
      } else {
        // 其他 outcome，如果有对应的价格则使用，否则回退
        price = fallbackPrices[index] ?? 0;
      }
    } else {
      // 回退到 outcomePrices
      price = Number.isFinite(fallbackPrices[index]) ? fallbackPrices[index] : 0;
    }
    
    return {
      label,
      price: Number.isFinite(price) ? price : 0
    };
  });

  return {
    id: market.id,
    question: market.question,
    slug: market.slug,
    url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
    outcomes: normalizedOutcomes,
    liquidity: Number(market.liquidity ?? market.liquidityNum ?? 0),
    groupItemTitle: market.groupItemTitle ?? null,
    bestBid: bestBid,
    bestAsk: bestAsk,
    lastTradePrice: typeof market.lastTradePrice === 'number' ? market.lastTradePrice : null
  };
}

function pickTargetMarket(markets, outcomeKey) {
  if (!markets.length) {
    return null;
  }
  if (!outcomeKey) {
    return selectBestMarket(markets);
  }

  const normalizedKey = normalizeKey(outcomeKey);
  return (
    markets.find((market) => normalizeKey(market.groupItemTitle) === normalizedKey) ||
    markets.find((market) => normalizeKey(market.question) === normalizedKey) ||
    markets.find((market) => normalizeKey(market.slug) === normalizedKey)
  );
}

function selectBestMarket(markets) {
  if (!markets.length) {
    return null;
  }
  return [...markets].sort((a, b) => b.liquidity - a.liquidity)[0];
}

function parseMaybeJsonArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function extractAmountFromTitle(title) {
  if (!title) {
    return null;
  }
  // 匹配 $数字B 或 $数字M 等格式，如 $1B, $2B, $10B, $1M
  const match = String(title).match(/\$?(\d+(?:\.\d+)?)([BMK])?/i);
  if (!match) {
    return null;
  }
  const number = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  let multiplier = 1;
  if (unit === 'B') {
    multiplier = 1000000000; // 十亿
  } else if (unit === 'M') {
    multiplier = 1000000; // 百万
  } else if (unit === 'K') {
    multiplier = 1000; // 千
  }
  return number * multiplier;
}

function sortMarketsByAmount(markets) {
  return [...markets].sort((a, b) => {
    const amountA = extractAmountFromTitle(a.groupItemTitle);
    const amountB = extractAmountFromTitle(b.groupItemTitle);
    
    // 如果两个都有金额，按金额排序
    if (amountA !== null && amountB !== null) {
      return amountA - amountB;
    }
    // 如果只有一个有金额，有金额的排在前面
    if (amountA !== null) {
      return -1;
    }
    if (amountB !== null) {
      return 1;
    }
    // 如果都没有金额，保持原顺序
    return 0;
  });
}
