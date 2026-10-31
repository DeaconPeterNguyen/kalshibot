const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

/**
 * Parse a Kalshi price value into a finite decimal (0-1), or null.
 * Handles both decimal-dollar strings ("0.1100") and integer cents (11).
 */
function parsePrice(value) {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a raw Kalshi market record into the shape the bot consumes
 * (decimal probabilities + cent fields), regardless of which API field
 * naming convention the response uses.
 *
 * Kalshi renamed its price fields: modern responses carry `yes_bid_dollars`
 * / `yes_ask_dollars` / `no_bid_dollars` / `no_ask_dollars` / `last_price_dollars`
 * (decimal strings), while older responses used bare `yes_bid` / `yes_ask` /
 * `no_bid` / `no_ask` / `last_price` (integer cents). Reading the old names
 * from a new response returns undefined, which propagates as NaN into the
 * UI and every strategy calculation — so both forms must be supported.
 *
 * @returns {Object|null} normalized market, or null for an unusable record
 */
function normalizeKalshiMarket(m) {
  if (!m || typeof m !== 'object') return null;

  const yesBidDollars = parsePrice(m.yes_bid_dollars);
  const yesAskDollars = parsePrice(m.yes_ask_dollars);
  const noBidDollars = parsePrice(m.no_bid_dollars);
  const noAskDollars = parsePrice(m.no_ask_dollars);
  const lastPriceDollars = parsePrice(m.last_price_dollars);

  // Dollar fields win when present; fall back to legacy cent fields / 100.
  const yesBid = yesBidDollars != null ? yesBidDollars
    : (m.yes_bid != null ? m.yes_bid / 100 : null);
  const yesAsk = yesAskDollars != null ? yesAskDollars
    : (m.yes_ask != null ? m.yes_ask / 100 : null);
  const noBid = noBidDollars != null ? noBidDollars
    : (m.no_bid != null ? m.no_bid / 100 : null);
  const noAsk = noAskDollars != null ? noAskDollars
    : (m.no_ask != null ? m.no_ask / 100 : null);
  const lastPrice = lastPriceDollars != null ? lastPriceDollars
    : (m.last_price != null ? m.last_price / 100 : null);

  return {
    ticker: m.ticker,
    status: m.status,
    result: m.result,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    lastPrice,
    // Cents for the UI and DB snapshot — derive from whichever source we had.
    yesBidCents: yesBidDollars != null ? Math.round(yesBidDollars * 100) : m.yes_bid,
    yesAskCents: yesAskDollars != null ? Math.round(yesAskDollars * 100) : m.yes_ask,
    noBidCents: noBidDollars != null ? Math.round(noBidDollars * 100) : m.no_bid,
    noAskCents: noAskDollars != null ? Math.round(noAskDollars * 100) : m.no_ask,
    openTime: m.open_time ? new Date(m.open_time).getTime() : null,
    closeTime: m.close_time ? new Date(m.close_time).getTime() : null,
  };
}

class KalshiClient {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.privateKeyPem = null;
    // Per Kalshi docs, the official production REST hostname is
    // external-api.kalshi.com (trade-api/v2/*). api.elections.kalshi.com is
    // the consumer site and 404s on every trade-api path.
    this.baseUrl = config.KALSHI_API_BASE || 'https://external-api.kalshi.com';
  }

  loadPrivateKey() {
    if (!this.privateKeyPem) {
      // Support base64-encoded key from env var (for Vercel/serverless)
      if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
        this.privateKeyPem = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
      } else {
        const keyPath = this.config.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem';
        if (!fs.existsSync(keyPath)) {
          throw new Error(`Private key not found: ${keyPath}. Set KALSHI_PRIVATE_KEY_BASE64 env var for serverless deployments.`);
        }
        this.privateKeyPem = fs.readFileSync(keyPath, 'utf8');
      }
    }
    return this.privateKeyPem;
  }

  generateAuth(method, apiPath) {
    const pem = this.loadPrivateKey();
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
        'KALSHI-ACCESS-KEY': this.config.KALSHI_API_KEY,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      },
    };
  }

  async get(apiPath) {
    const auth = this.generateAuth('GET', apiPath);
    return this._requestWithRetry('GET', apiPath, auth, null);
  }

  async post(apiPath, body) {
    const auth = this.generateAuth('POST', apiPath);
    return this._requestWithRetry('POST', apiPath, auth, body);
  }

  async delete(apiPath) {
    const auth = this.generateAuth('DELETE', apiPath);
    return this._requestWithRetry('DELETE', apiPath, auth, null);
  }

  /**
   * Execute an authenticated request with exponential-backoff retry on
   * 429 (rate limited) responses. Kalshi throttles order placement, so a
   * burst of 3 orders for the same ticker in ~3 seconds triggers this.
   */
  async _requestWithRetry(method, apiPath, auth, body, attempt = 0) {
    const url = `${this.baseUrl}${apiPath}`;
    const baseDelay = 1000; // 1s, doubles each retry
    const maxDelay = 30000;  // cap at 30s
    const maxAttempts = 4;

    try {
      const opts = { ...auth, timeout: 8000 };
      if (method === 'GET') return await axios.get(url, opts);
      if (method === 'POST') return await axios.post(url, body, opts);
      if (method === 'DELETE') return await axios.delete(url, opts);
      throw new Error(`Unknown method: ${method}`);
    } catch (err) {
      const status = err.response && err.response.status;
      const isRateLimit = status === 429;
      const isRetryable = isRateLimit || (status >= 500 && status < 600);

      if (isRetryable && attempt < maxAttempts) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const code = isRateLimit ? 'rate-limited' : `status ${status}`;
        console.warn(`[KalshiClient] ${code} on ${method} ${apiPath}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
        await new Promise(r => setTimeout(r, delay));
        return this._requestWithRetry(method, apiPath, auth, body, attempt + 1);
      }
      throw err;
    }
  }

  async fetchBalance() {
    try {
      const resp = await this.get('/trade-api/v2/portfolio/balance');
      const totalCents = resp.data.balance;
      const reservedCents = resp.data.payout || 0;

      const balance = {
        total: totalCents / 100,
        available: (totalCents - reservedCents) / 100,
        reserved: reservedCents / 100,
      };

      this.state.updateBalance(balance);
      this.state.updateKalshiConnection(true);
      return balance;
    } catch (error) {
      this.state.updateKalshiConnection(false);
      throw error;
    }
  }

  async discoverMarkets(seriesTicker) {
    const apiPath = `/trade-api/v2/markets?series_ticker=${seriesTicker}&limit=20&status=open`;
    const resp = await this.get(apiPath);
    return resp.data.markets || [];
  }

  async fetchMarket(ticker) {
    try {
      const resp = await this.get(`/trade-api/v2/markets/${ticker}`);
      const normalized = normalizeKalshiMarket(resp.data.market);
      if (!normalized) {
        const err = new Error(`Unusable market record for ${ticker}`);
        err.response = resp;
        throw err;
      }
      return normalized;
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async placeOrder(orderData) {
    // Kalshi deprecated the V1 order endpoint (/trade-api/v2/portfolio/orders)
    // with a 410 "deprecated_v1_order_endpoint" error. The V2 order endpoint is
    // /trade-api/v2/orders and uses `contract_type` ("yes"/"no") instead of
    // `side` + `yes_price`/`no_price`, and `price` (integer cents) for limits.
    const v2Data = this._toV2Order(orderData);
    const url = `${this.baseUrl}/trade-api/v2/portfolio/events/orders`;
    //const url = `${this.baseUrl}/trade-api/v2/orders`;
    console.log(`[KalshiClient] POST ${url} body=`, JSON.stringify(v2Data));
    const resp = await this.post('/trade-api/v2/portfolio/events/orders', v2Data);
    // /portfolio/events/orders returns the order object at the top level
    // (with keys like order_id, fill_count, etc.), not wrapped in data.order.
    if (!resp?.data) {
      console.warn('[KalshiClient] placeOrder: no order in response', resp?.data);
      return null;
    }
    return resp.data;
  }

  async getOrder(orderId) {
    // The single-order GET lives at /portfolio/orders/{id}, NOT
    // /portfolio/events/orders/{id} — the events path 404s on every read,
    // which broke OrderManager polling and settlement checks.
    const resp = await this.get(`/trade-api/v2/portfolio/orders/${orderId}`);
    const order = resp.data.order;
    // Normalize V2 field names (fill_count_fp -> fill_count, etc.)
    return this._normalizeOrder(order);
  }

  _normalizeOrder(order) {
    if (!order) return order;
    // Cost fields: V2 API returns dollar strings (e.g. "13.7500").
    // The engine expects cents (integers) for these fields, so multiply by 100.
    const toCents = (dollarStr) => dollarStr != null
      ? Math.round(parseFloat(dollarStr) * 100)
      : null;
    return {
      ...order,
      fill_count: order.fill_count_fp != null ? parseFloat(order.fill_count_fp) : order.fill_count,
      remaining_count: order.remaining_count_fp != null ? parseFloat(order.remaining_count_fp) : order.remaining_count,
      initial_count: order.initial_count_fp != null ? parseFloat(order.initial_count_fp) : order.initial_count,
      taker_fill_cost: toCents(order.taker_fill_cost_dollars),
      taker_fees: toCents(order.taker_fees_dollars),
      maker_fill_cost: toCents(order.maker_fill_cost_dollars),
      maker_fees: toCents(order.maker_fees_dollars),
    };
  }

  async cancelOrder(orderId) {
    // V2 cancel endpoint is DELETE /portfolio/events/orders/{order_id}
    // (same base path as POST /portfolio/events/orders for order creation).
    // The V1 path /portfolio/orders/{id} returns 410 deprecated_v1_order_endpoint.
    const resp = await this.delete(`/trade-api/v2/portfolio/events/orders/${orderId}`);
    return resp.data;
  }

  /**
   * Translate the bot's order shape to Kalshi's V2 order API body.
   *
   * V1: { ticker, action, side, count, type, yes_price?, no_price? }
   * V2: { ticker, action, contract_type, count, type, price? }
   */
  _toV2Order(orderData) {
    // Kalshi V2 order semantics:
    //   - side "bid"  = buy  YES contracts
    //   - side "ask"  = sell YES contracts = buy NO contracts at (1 - price)
    //   - price is ALWAYS in YES-dollars (0-1), never cents
    //   - The V2 schema has NO `type` or `contract_type` fields — those are
    //     V1 concepts. Sending them causes Kalshi to reject or misinterpret
    //     the order.
    const isBuyYes = orderData.action === 'buy' && orderData.side === 'yes';
    const isBuyNo = orderData.action === 'buy' && orderData.side === 'no';
    const isSellYes = orderData.action === 'sell' && orderData.side === 'yes';
    const isSellNo = orderData.action === 'sell' && orderData.side === 'no';

    let v2Side;
    let priceCents;
    if (isBuyYes) {
      v2Side = 'bid';
      priceCents = orderData.priceCents != null ? orderData.priceCents
        : orderData.yes_price != null ? orderData.yes_price
        : orderData.price;
    } else if (isBuyNo) {
      // Buying NO = selling YES at (1 - noAsk)
      v2Side = 'ask';
      const noPriceCents = orderData.priceCents != null ? orderData.priceCents
        : orderData.no_price != null ? orderData.no_price
        : orderData.price;
      // Convert NO-cents price to YES-dollars: 1 - noPrice
      const noPrice = noPriceCents != null ? Number(noPriceCents) / 100 : null;
      priceCents = noPrice != null ? (1 - noPrice) * 100 : null;
    } else if (isSellYes) {
      v2Side = 'ask';
      priceCents = orderData.priceCents != null ? orderData.priceCents
        : orderData.yes_price != null ? orderData.yes_price
        : orderData.price;
    } else if (isSellNo) {
      // Selling NO = buying YES
      v2Side = 'bid';
      const noPriceCents = orderData.priceCents != null ? orderData.priceCents
        : orderData.no_price != null ? orderData.no_price
        : orderData.price;
      const noPrice = noPriceCents != null ? Number(noPriceCents) / 100 : null;
      priceCents = noPrice != null ? (1 - noPrice) * 100 : null;
    } else {
      throw new Error(`Unknown order: action=${orderData.action}, side=${orderData.side}`);
    }

    const v2 = {
      ticker: orderData.ticker,
      side: v2Side,
      count: String(orderData.count),
      client_order_id: orderData.client_order_id,
      // Kalshi requires these on every order. self_trade_prevention_type is
      // 'taker_at_cross' (cancel our taker, stop) or 'maker' (cancel the
      // resting maker, our taker keeps filling) — 'maker' is what we want
      // as the entering side. time_in_force: 'immediate_or_cancel' for market
      // (partial fills OK, remainder cancelled — FoK kills the whole order
      // when the book can't fully match), 'good_till_canceled' for limit.
      self_trade_prevention_type: orderData.self_trade_prevention_type || 'maker',
      time_in_force: orderData.time_in_force
        || (orderData.type === 'market' ? 'immediate_or_cancel' : 'good_till_canceled'),
      // Force auto-routing by ticker to the exchange that has the market
      // and available balance. The Kalshi API splits balance across
      // exchange_index 0-3; omitting exchange_index or setting -1 triggers
      // auto-routing. Without this, orders default to exchange 0 which may
      // have insufficient balance even when aggregate balance is sufficient.
      exchange_index: -1,
    };

    // V2 requires `price` on every order, in fixed-point dollars (e.g. "0.61"),
    // not cents. Our callers pass cents (priceCents), so convert; if a value
    // above 100 is passed it is assumed to already be a dollar decimal.
    if (priceCents != null) {
      const n = Number(priceCents);
      if (Number.isFinite(n)) {
        v2.price = (n > 100 ? n : n / 100).toFixed(4);
      }
    }

    return v2;
  }

  // Fetch actual positions from Kalshi (for reconciliation on startup)
  async fetchPositions(seriesTicker) {
    try {
      // Fetch ALL unsettled positions (ticker filter requires exact market ticker, not series)
      const apiPath = `/trade-api/v2/portfolio/positions?settlement_status=unsettled&limit=200`;
      const resp = await this.get(apiPath);
      const all = resp.data.market_positions || [];
      // Filter client-side to our series only
      return all.filter(p => p.ticker && p.ticker.startsWith(seriesTicker));
    } catch (error) {
      console.error('[Kalshi] Failed to fetch positions:', error.message);
      return [];
    }
  }

  // Sell existing position (for take-profit before settlement)
  async sellPosition(ticker, side, count, priceCents) {
    const orderData = {
      ticker,
      action: 'sell',
      side,
      count,
      type: 'market',
      client_order_id: `sell-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      priceCents: priceCents,
    };

    return this.placeOrder(orderData);
  }

  // Transfer balance between exchange shards (Kalshi V2).
  // Required before placing orders on an exchange that has 0 balance
  // but hosts the market.
  async transferBalance(amountCents, sourceShard = 0, destShard = 2) {
    const body = {
      source: 'event_contract',
      destination: 'event_contract',
      amount: amountCents * 100, // centicents (cents * 100)
      source_exchange_shard: sourceShard,
      destination_exchange_shard: destShard,
    };
    const resp = await this.post('/trade-api/v2/portfolio/intra_exchange_instance_transfer', body);
    return resp.data;
  }
}

module.exports = KalshiClient;
module.exports.normalizeKalshiMarket = normalizeKalshiMarket;
module.exports.parsePrice = parsePrice;
