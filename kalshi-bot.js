#!/usr/bin/env node

/**
 * Kalshi Rolling Contracts Trading Bot
 *
 * Automatically trades 15-minute Bitcoin up/down contracts on Kalshi
 * using Polymarket price data as fair value signals.
 *
 * Strategy: Compares Polymarket's 15-min BTC up/down market prices
 * with Kalshi's equivalent contracts. When there's a significant
 * price discrepancy (edge), executes trades on Kalshi.
 *
 * Setup:
 * 1. npm install axios dotenv
 * 2. Create .env file with KALSHI_API_KEY
 * 3. Place kalshi_private_key.pem in project root
 * 4. Run: node kalshi-bot.js
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { normalizeKalshiMarket } = require('./bot/kalshi');

// Configuration
const CONFIG = {
  KALSHI_API_KEY: process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem',
  // Per Kalshi docs, the official production REST hostname is
  // external-api.kalshi.com (trade-api/v2/*). api.elections.kalshi.com is
  // the consumer site and 404s on every trade-api path.
  KALSHI_API_BASE: 'https://external-api.kalshi.com',

  POLYMARKET_GAMMA_API: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_API: 'https://clob.polymarket.com',

  MIN_EDGE: parseFloat(process.env.MIN_EDGE) || 2.0,
  MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE) || 300,
  MAX_POSITIONS_PER_CONTRACT: parseInt(process.env.MAX_POSITIONS_PER_CONTRACT) || 1,
  MAX_TOTAL_OPEN_POSITIONS: parseInt(process.env.MAX_TOTAL_OPEN_POSITIONS) || 10,
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.25,
  TRADING_WINDOW: parseInt(process.env.TRADING_WINDOW) || 10,

  SCAN_INTERVAL: 5000,
  DISCOVERY_INTERVAL: 30000,
  BALANCE_INTERVAL: 15000,
};

// State
const state = {
  balance: { total: 0, available: 0, reserved: 0 },
  activeContracts: [],   // Kalshi markets currently tradeable
  openPositions: [],
  closedPositions: [],
  polymarketCache: {},   // Cache Polymarket lookups to avoid rate limits
  stats: {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalPnL: 0,
    volumeTraded: 0,
  },
};

// Logging
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const colors = {
    INFO: '\x1b[36m',
    SUCCESS: '\x1b[32m',
    ERROR: '\x1b[31m',
    WARN: '\x1b[33m',
  };
  const reset = '\x1b[0m';
  console.log(`${colors[level] || ''}[${timestamp}] [${level}]${reset} ${message}`);
}

// ============================================================
// Kalshi API Authentication (RSA-PSS signing)
// ============================================================
let privateKeyPem = null;

function loadPrivateKey() {
  if (!privateKeyPem) {
    if (!fs.existsSync(CONFIG.KALSHI_PRIVATE_KEY_PATH)) {
      throw new Error(`Private key file not found at: ${CONFIG.KALSHI_PRIVATE_KEY_PATH}`);
    }
    privateKeyPem = fs.readFileSync(CONFIG.KALSHI_PRIVATE_KEY_PATH, 'utf8');
  }
  return privateKeyPem;
}

function generateKalshiAuth(method, apiPath) {
  const pem = loadPrivateKey();
  const timestampMs = Date.now().toString();
  const pathWithoutQuery = apiPath.split('?')[0];
  const message = timestampMs + method + pathWithoutQuery;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign({
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, 'base64');

  return {
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': CONFIG.KALSHI_API_KEY,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
  };
}

async function kalshiGet(apiPath) {
  const auth = generateKalshiAuth('GET', apiPath);
  return axios.get(`${CONFIG.KALSHI_API_BASE}${apiPath}`, auth);
}

async function kalshiPost(apiPath, body) {
  const auth = generateKalshiAuth('POST', apiPath);
  return axios.post(`${CONFIG.KALSHI_API_BASE}${apiPath}`, body, auth);
}

// ============================================================
// Kalshi: Fetch account balance
// ============================================================
async function fetchKalshiBalance() {
  try {
    const response = await kalshiGet('/trade-api/v2/portfolio/balance');
    const totalCents = response.data.balance;
    const reservedCents = response.data.payout || 0;

    state.balance = {
      total: totalCents / 100,
      available: (totalCents - reservedCents) / 100,
      reserved: reservedCents / 100,
    };

    log(`Balance: $${state.balance.total.toFixed(2)} ($${state.balance.available.toFixed(2)} available)`);
    return state.balance;
  } catch (error) {
    const detail = error.response
      ? `${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    log(`Balance error: ${detail}`, 'ERROR');
    return null;
  }
}

// ============================================================
// Kalshi: Discover active KXBTC15M contracts via API
// ============================================================
async function discoverContracts() {
  try {
    const apiPath = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=20&status=open';
    const response = await kalshiGet(apiPath);
    const markets = response.data.markets || [];

    const now = Date.now();
    const newContracts = [];

    for (const market of markets) {
      const normalized = normalizeKalshiMarket(market);
      if (!normalized) continue;

      const openTime = normalized.openTime;
      const closeTime = normalized.closeTime;
      if (!Number.isFinite(closeTime) || closeTime <= now) continue;

      // Skip if already tracked
      if (state.activeContracts.find(c => c.ticker === normalized.ticker)) continue;

      const minutesUntilClose = Math.floor((closeTime - now) / 60000);
      const minutesSinceOpen = Math.floor((now - openTime) / 60000);
      const isInTradingWindow = now >= openTime && minutesSinceOpen <= CONFIG.TRADING_WINDOW;

      newContracts.push({
        ...normalized,
        eventTicker: market.event_ticker,
        title: market.title,
        strikePrice: market.floor_strike,
        minutesUntilClose,
        isInTradingWindow,
      });

      log(`Discovered: ${normalized.ticker} | Strike: $${market.floor_strike?.toFixed(2) || '?'} | YES ${normalized.yesBidCents}/${normalized.yesAskCents} | ${minutesUntilClose}m left`, 'SUCCESS');
    }

    // Merge: keep unexpired, add new
    state.activeContracts = [
      ...state.activeContracts.filter(c => c.closeTime > now),
      ...newContracts,
    ];

    // Refresh trading window status and market prices for existing contracts
    for (const contract of state.activeContracts) {
      const minutesUntilClose = Math.floor((contract.closeTime - now) / 60000);
      const minutesSinceOpen = Math.floor((now - contract.openTime) / 60000);
      contract.minutesUntilClose = minutesUntilClose;
      contract.isInTradingWindow = now >= contract.openTime && minutesSinceOpen <= CONFIG.TRADING_WINDOW;
    }

    const tradeable = state.activeContracts.filter(c => c.isInTradingWindow).length;
    if (state.activeContracts.length > 0) {
      log(`Tracking ${state.activeContracts.length} contracts (${tradeable} in trading window)`);
    }
  } catch (error) {
    const detail = error.response
      ? `${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    log(`Contract discovery error: ${detail}`, 'ERROR');
  }
}

// ============================================================
// Kalshi: Fetch live market data (best bid/ask from market endpoint)
// ============================================================
async function fetchKalshiMarket(ticker) {
  try {
    const apiPath = `/trade-api/v2/markets/${ticker}`;
    const response = await kalshiGet(apiPath);
    const normalized = normalizeKalshiMarket(response.data.market);
    if (!normalized) {
      log(`Unusable market record for ${ticker}`, 'ERROR');
      return null;
    }
    normalized.strikePrice = response.data.market.floor_strike;
    return normalized;
  } catch (error) {
    if (error.response?.status === 404) return null;
    log(`Market fetch error for ${ticker}: ${error.response?.status || error.message}`, 'WARN');
    return null;
  }
}

// ============================================================
// Polymarket: Fetch 15-min BTC up/down price
// ============================================================
function getPolymarketSlug(closeTimeMs) {
  // Polymarket uses the 15-min slot START time as the slug timestamp
  // Kalshi close_time = end of the 15-min window
  // So slot start = close_time - 15 minutes
  const slotStartSec = Math.floor((closeTimeMs - 15 * 60 * 1000) / 1000);
  // Round to nearest 900 seconds (15 min)
  const rounded = Math.floor(slotStartSec / 900) * 900;
  return `btc-updown-15m-${rounded}`;
}

async function fetchPolymarketPrice(contract) {
  const slug = getPolymarketSlug(contract.closeTime);

  // Check cache (valid for 3 seconds)
  const cached = state.polymarketCache[slug];
  if (cached && Date.now() - cached.fetchedAt < 3000) {
    return cached.data;
  }

  try {
    // Step 1: Get event and token IDs from Gamma API
    const eventResp = await axios.get(`${CONFIG.POLYMARKET_GAMMA_API}/events`, {
      params: { slug },
      timeout: 5000,
    });

    if (!eventResp.data || eventResp.data.length === 0) {
      log(`No Polymarket event for slug: ${slug}`, 'WARN');
      return null;
    }

    const event = eventResp.data[0];
    const market = event.markets?.[0];

    if (!market || !market.clobTokenIds) {
      log(`No market data in Polymarket event: ${slug}`, 'WARN');
      return null;
    }

    // clobTokenIds is a JSON string: '["up_token_id", "down_token_id"]'
    const tokenIds = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : market.clobTokenIds;

    const upTokenId = tokenIds[0];  // "Up" token
    const downTokenId = tokenIds[1]; // "Down" token

    // Step 2: Get live price from CLOB API
    const [buyResp, sellResp] = await Promise.all([
      axios.get(`${CONFIG.POLYMARKET_CLOB_API}/price`, {
        params: { token_id: upTokenId, side: 'buy' },
        timeout: 5000,
      }),
      axios.get(`${CONFIG.POLYMARKET_CLOB_API}/price`, {
        params: { token_id: upTokenId, side: 'sell' },
        timeout: 5000,
      }),
    ]);

    const buyPrice = parseFloat(buyResp.data.price);   // Best ask (what you'd pay to buy UP)
    const sellPrice = parseFloat(sellResp.data.price);  // Best bid (what you'd get selling UP)
    const midPrice = (buyPrice + sellPrice) / 2;

    // Also use outcomePrices as a secondary reference
    const outcomePrices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices;
    const gammaUpPrice = parseFloat(outcomePrices?.[0] || midPrice);

    const result = {
      upBuy: buyPrice,     // Cost to buy UP on Polymarket
      upSell: sellPrice,   // Price to sell UP on Polymarket
      upMid: midPrice,     // Midpoint estimate of fair value
      gammaMid: gammaUpPrice,
      volume: parseFloat(market.volume || 0),
      liquidity: parseFloat(market.liquidity || 0),
      slug,
      marketName: market.question,
      active: market.active && !market.closed,
    };

    state.polymarketCache[slug] = { data: result, fetchedAt: Date.now() };
    return result;

  } catch (error) {
    const detail = error.response
      ? `${error.response.status}`
      : error.message;
    log(`Polymarket error (${slug}): ${detail}`, 'ERROR');
    return null;
  }
}

// ============================================================
// Signal Detection
// ============================================================
function calculateKellySize(edge, probability) {
  // Kelly criterion: f* = (bp - q) / b
  // where b = odds, p = win probability, q = 1-p
  if (probability <= 0 || probability >= 1) return 0;
  const b = (1 / (1 - probability)) - 1;
  const q = 1 - probability;
  const kelly = (b * probability - q) / b;
  return Math.max(0, Math.min(kelly * CONFIG.KELLY_FRACTION, 0.25));
}

async function scanForSignals() {
  const signals = [];
  const tradeableContracts = state.activeContracts.filter(c => c.isInTradingWindow);

  if (tradeableContracts.length === 0) return signals;

  for (const contract of tradeableContracts) {
    // Skip if we already have max positions on this contract
    const existingPositions = state.openPositions.filter(p => p.ticker === contract.ticker);
    if (existingPositions.length >= CONFIG.MAX_POSITIONS_PER_CONTRACT) continue;

    try {
      // Fetch live Kalshi market data
      const kalshi = await fetchKalshiMarket(contract.ticker);
      if (!kalshi || kalshi.status !== 'active') continue;

      // Skip if no real bid/ask (market not liquid)
      if (kalshi.yesAskCents === 0 || kalshi.yesBidCents === 0) {
        log(`${contract.ticker}: No bid/ask, skipping`);
        continue;
      }

      // Fetch Polymarket price for this time slot
      const poly = await fetchPolymarketPrice(contract);
      if (!poly || !poly.active) {
        log(`${contract.ticker}: No matching Polymarket market`, 'WARN');
        continue;
      }

      // Use Polymarket midpoint as fair value estimate
      const fairValue = poly.upMid;

      log(`${contract.ticker}: Kalshi YES ${kalshi.yesBid.toFixed(2)}/${kalshi.yesAsk.toFixed(2)} | Poly UP mid=${fairValue.toFixed(3)} | Strike $${kalshi.strikePrice?.toFixed(0) || '?'}`);

      // SIGNAL 1: BUY YES on Kalshi
      // If Polymarket UP price > Kalshi YES ask → Kalshi is cheap, buy YES
      const buyYesEdge = (fairValue - kalshi.yesAsk) * 100;
      if (buyYesEdge > CONFIG.MIN_EDGE) {
        const positionFraction = CONFIG.USE_KELLY_SIZING
          ? calculateKellySize(buyYesEdge / 100, fairValue)
          : 1;
        const positionSize = Math.min(
          positionFraction * state.balance.available,
          CONFIG.MAX_POSITION_SIZE,
          state.balance.available
        );
        const contracts = Math.max(1, Math.floor(positionSize / kalshi.yesAsk));

        signals.push({
          contract,
          type: 'BUY_YES',
          side: 'yes',
          priceCents: kalshi.yesAskCents,
          priceDecimal: kalshi.yesAsk,
          polyPrice: fairValue,
          edge: buyYesEdge,
          contracts,
          positionSize,
        });

        log(`SIGNAL: BUY YES ${contract.ticker} @ ${kalshi.yesAsk.toFixed(2)} | Poly=${fairValue.toFixed(3)} | Edge=${buyYesEdge.toFixed(1)}%`, 'SUCCESS');
      }

      // SIGNAL 2: BUY NO on Kalshi
      // If Polymarket UP price < Kalshi YES bid → Kalshi YES is expensive, buy NO
      const buyNoEdge = (kalshi.yesBid - fairValue) * 100;
      if (buyNoEdge > CONFIG.MIN_EDGE) {
        const positionFraction = CONFIG.USE_KELLY_SIZING
          ? calculateKellySize(buyNoEdge / 100, 1 - fairValue)
          : 1;
        const positionSize = Math.min(
          positionFraction * state.balance.available,
          CONFIG.MAX_POSITION_SIZE,
          state.balance.available
        );
        const contracts = Math.max(1, Math.floor(positionSize / kalshi.noAsk));

        signals.push({
          contract,
          type: 'BUY_NO',
          side: 'no',
          priceCents: kalshi.noAskCents,
          priceDecimal: kalshi.noAsk,
          polyPrice: fairValue,
          edge: buyNoEdge,
          contracts,
          positionSize,
        });

        log(`SIGNAL: BUY NO ${contract.ticker} @ ${kalshi.noAsk.toFixed(2)} | Poly=${fairValue.toFixed(3)} | Edge=${buyNoEdge.toFixed(1)}%`, 'SUCCESS');
      }

    } catch (error) {
      log(`Error scanning ${contract.ticker}: ${error.message}`, 'ERROR');
    }
  }

  if (signals.length > 0) {
    log(`Found ${signals.length} signal(s)`, 'SUCCESS');
  }

  return signals;
}

// ============================================================
// Trade Execution on Kalshi
// ============================================================
async function executeTrade(signal) {
  if (state.openPositions.length >= CONFIG.MAX_TOTAL_OPEN_POSITIONS) {
    log(`Max open positions (${CONFIG.MAX_TOTAL_OPEN_POSITIONS}) reached`, 'WARN');
    return false;
  }

  if (signal.contracts < 1) {
    log(`Position size too small for ${signal.contract.ticker}`, 'WARN');
    return false;
  }

  const costEstimate = signal.priceDecimal * signal.contracts;
  if (costEstimate > state.balance.available) {
    log(`Insufficient balance: need $${costEstimate.toFixed(2)}, have $${state.balance.available.toFixed(2)}`, 'WARN');
    return false;
  }

  try {
    log(`Executing: ${signal.type} ${signal.contract.ticker} x${signal.contracts} @ ${signal.priceCents}c | Edge: ${signal.edge.toFixed(1)}%`, 'INFO');

    const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const orderData = {
      ticker: signal.contract.ticker,
      action: 'buy',
      contract_type: signal.side, // V2 uses contract_type instead of side
      // Kalshi's side is bid/ask: buy-yes or sell-no = bid, buy-no or
      // sell-yes = ask.
      side: signal.side === 'yes' ? 'bid' : 'ask',
      count: String(signal.contracts),
      type: 'market',
      client_order_id: clientOrderId,
      // Kalshi requires these on every order. self_trade_prevention_type is
      // 'taker_at_cross' (cancel our taker, stop) or 'maker' (cancel the
      // resting maker, our taker keeps filling) — 'maker' is what we want
      // as the entering side. time_in_force: 'fill_or_kill' for market,
      // 'good_till_canceled' for limit (use expiration_time for a deadline).
      self_trade_prevention_type: 'maker',
      time_in_force: 'fill_or_kill',
    };

    // Market orders don't take a price parameter

    const response = await kalshiPost('/trade-api/v2/portfolio/events/orders', orderData);
    //const response = await kalshiPost('/trade-api/v2/orders', orderData);
    const order = response.data.order;

    log(`Order placed: ${order.order_id} | Status: ${order.status} | Filled: ${order.fill_count || 0}/${signal.contracts}`, 'SUCCESS');

    // Track position regardless of fill status (resting orders may fill later)
    const position = {
      orderId: order.order_id,
      clientOrderId,
      ticker: signal.contract.ticker,
      type: signal.type,
      side: signal.side,
      contracts: signal.contracts,
      filledContracts: order.fill_count || 0,
      priceCents: signal.priceCents,
      priceDecimal: signal.priceDecimal,
      totalCost: signal.priceDecimal * signal.contracts,
      edge: signal.edge,
      polyPrice: signal.polyPrice,
      entryTime: Date.now(),
      closeTime: signal.contract.closeTime,
      status: order.status, // 'resting' or 'executed'
    };

    state.openPositions.push(position);
    state.stats.volumeTraded += position.totalCost;

    // Schedule settlement check after contract closes (+ 90s buffer for settlement)
    const timeToSettle = signal.contract.closeTime - Date.now() + 90000;
    if (timeToSettle > 0) {
      setTimeout(() => settlePosition(position), timeToSettle);
      log(`Settlement scheduled in ${Math.round(timeToSettle / 1000)}s`, 'INFO');
    }

    await fetchKalshiBalance();
    return true;

  } catch (error) {
    const detail = error.response
      ? `${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    log(`Trade execution error: ${detail}`, 'ERROR');
    return false;
  }
}

// ============================================================
// Settlement
// ============================================================
async function settlePosition(position) {
  try {
    log(`Checking settlement: ${position.ticker} ${position.side.toUpperCase()}`, 'INFO');

    // Check the order status first
    // V2 single-order GET is /portfolio/orders/{id}, NOT /portfolio/events/orders/{id}
    const orderResp = await kalshiGet(`/trade-api/v2/portfolio/orders/${position.orderId}`);
    const order = orderResp.data.order;

    // Update fill count
    position.filledContracts = order.fill_count || 0;

    if (position.filledContracts === 0) {
      log(`Order ${position.orderId} was never filled, removing`, 'WARN');
      state.openPositions = state.openPositions.filter(p => p.orderId !== position.orderId);
      return;
    }

    // Get the market result to determine win/loss
    const marketPath = `/trade-api/v2/markets/${position.ticker}`;
    const fullMarketResp = await kalshiGet(marketPath);
    const market = fullMarketResp.data.market;

    // Remove from open positions
    state.openPositions = state.openPositions.filter(p => p.orderId !== position.orderId);

    // Calculate P&L from market result and order cost
    const costCents = order.taker_fill_cost + (order.taker_fees || 0);
    const costDollars = costCents / 100;
    let won = false;
    let payout = 0;

    if (market.result === 'yes' || market.result === 'no') {
      won = (position.side === market.result);
      payout = won ? position.filledContracts * 1.00 : 0; // $1 per winning contract
    } else {
      // Market not yet settled - try again later
      log(`Market ${position.ticker} not yet settled (status: ${market.status}, result: ${market.result}), retrying in 30s`, 'WARN');
      state.openPositions.push(position); // Re-add to open
      setTimeout(() => settlePosition(position), 30000);
      return;
    }

    const pnl = payout - costDollars;

    state.closedPositions.push({
      ...position,
      won,
      pnl,
      payout,
      cost: costDollars,
      settleTime: Date.now(),
    });

    state.stats.totalTrades++;
    state.stats.wins += won ? 1 : 0;
    state.stats.losses += won ? 0 : 1;
    state.stats.totalPnL += pnl;

    log(`${won ? 'WON' : 'LOST'}: ${position.ticker} ${position.side.toUpperCase()} x${position.filledContracts} | Cost: $${costDollars.toFixed(2)} | Payout: $${payout.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, won ? 'SUCCESS' : 'ERROR');

    await fetchKalshiBalance();
  } catch (error) {
    log(`Settlement error for ${position.ticker}: ${error.message}`, 'ERROR');
  }
}

// ============================================================
// Main Loop
// ============================================================
async function main() {
  log('Starting Kalshi Rolling Contracts Bot', 'SUCCESS');
  log(`Config: MinEdge=${CONFIG.MIN_EDGE}% | MaxPos=$${CONFIG.MAX_POSITION_SIZE} | MaxOpen=${CONFIG.MAX_TOTAL_OPEN_POSITIONS} | Window=${CONFIG.TRADING_WINDOW}m | Kelly=${CONFIG.USE_KELLY_SIZING ? CONFIG.KELLY_FRACTION : 'off'}`);

  // Validate API key
  if (!CONFIG.KALSHI_API_KEY) {
    log('KALSHI_API_KEY must be set in .env file', 'ERROR');
    process.exit(1);
  }

  // Validate private key
  if (!fs.existsSync(CONFIG.KALSHI_PRIVATE_KEY_PATH)) {
    log(`Private key file not found: ${CONFIG.KALSHI_PRIVATE_KEY_PATH}`, 'ERROR');
    process.exit(1);
  }

  // Test Kalshi connection
  log('Testing Kalshi API connection...');
  const balance = await fetchKalshiBalance();
  if (!balance) {
    log('Failed to connect to Kalshi API. Check credentials.', 'ERROR');
    process.exit(1);
  }
  log(`Kalshi connected. Balance: $${balance.total.toFixed(2)} ($${balance.available.toFixed(2)} available)`, 'SUCCESS');

  // Test Polymarket connection
  log('Testing Polymarket API connection...');
  const nowSlot = Math.floor(Date.now() / 1000 / 900) * 900;
  const testSlug = `btc-updown-15m-${nowSlot}`;
  try {
    const testResp = await axios.get(`${CONFIG.POLYMARKET_GAMMA_API}/events`, {
      params: { slug: testSlug },
      timeout: 5000,
    });
    if (testResp.data?.length > 0) {
      log(`Polymarket connected. Found: ${testResp.data[0].title}`, 'SUCCESS');
    } else {
      log(`Polymarket connected but no current 15m BTC market found (slug: ${testSlug}). Will retry.`, 'WARN');
    }
  } catch (error) {
    log(`Polymarket connection warning: ${error.message}. Will retry during scans.`, 'WARN');
  }

  // Initial contract discovery
  await discoverContracts();

  // Set up periodic tasks
  setInterval(discoverContracts, CONFIG.DISCOVERY_INTERVAL);
  setInterval(fetchKalshiBalance, CONFIG.BALANCE_INTERVAL);

  // Main scan loop
  let scanRunning = false;
  setInterval(async () => {
    if (scanRunning) return; // Prevent overlapping scans
    scanRunning = true;

    try {
      const signals = await scanForSignals();

      for (const signal of signals) {
        await executeTrade(signal);
        await new Promise(r => setTimeout(r, 500)); // Rate limit buffer
      }

      // Status report (only every 30s to reduce noise)
      const tradeable = state.activeContracts.filter(c => c.isInTradingWindow).length;
      if (!scanForSignals._lastStatus || Date.now() - scanForSignals._lastStatus > 30000) {
        if (state.openPositions.length > 0 || tradeable > 0) {
          log(`Status: ${state.openPositions.length} open | ${tradeable} tradeable | W/L: ${state.stats.wins}/${state.stats.losses} | P&L: $${state.stats.totalPnL.toFixed(2)}`);
        }
        scanForSignals._lastStatus = Date.now();
      }
    } catch (error) {
      log(`Scan loop error: ${error.message}`, 'ERROR');
    } finally {
      scanRunning = false;
    }
  }, CONFIG.SCAN_INTERVAL);

  log('Bot is running. Press Ctrl+C to stop.', 'SUCCESS');
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...', 'WARN');
  log(`Final Stats: Trades=${state.stats.totalTrades} | W/L=${state.stats.wins}/${state.stats.losses} | P&L=$${state.stats.totalPnL.toFixed(2)} | Volume=$${state.stats.volumeTraded.toFixed(2)}`);
  process.exit(0);
});

main().catch(error => {
  log(`Fatal error: ${error.message}`, 'ERROR');
  process.exit(1);
});
