/**
 * OrderExecutor Skill
 *
 * Handles order placement and lifecycle management.
 * Wraps the existing OrderManager for fill tracking and stale order cancellation.
 *
 * Capabilities: execute-signals, place-order, cancel-order, check-order-status
 */

const BaseSkill = require('../../core/base-skill');
const OrderManager = require('../../../bot/order-manager');

class OrderExecutor extends BaseSkill {
  constructor() {
    super({
      name: 'order-executor',
      description: 'Places orders on Kalshi and manages order lifecycle (fills, cancellations)',
      domain: 'trading',
      capabilities: ['execute-signals', 'place-order', 'cancel-order', 'check-order-status'],
      dependencies: ['state-manager', 'kalshi-market-data', 'analytics-recorder', 'risk-manager'],
    });

    this.orderManager = null;
    this.maxPositionSize = 25;
    // Track recently executed tickers to prevent duplicate orders from the
    // same scan cycle (Kalshi rate-limits duplicate orders at 429).
    this._recentExecutions = new Map();
  }

  _isDuplicate(ticker, windowMs = 5000) {
    const last = this._recentExecutions.get(ticker);
    if (last && Date.now() - last < windowMs) return true;
    this._recentExecutions.set(ticker, Date.now());
    return false;
  }

  async initialize(context) {
    await super.initialize(context);

    const stateManager = context.registry.get('state-manager');
    const kalshiSkill = context.registry.get('kalshi-market-data');
    const analyticsSkill = context.registry.get('analytics-recorder');

    this.orderManager = new OrderManager(
      kalshiSkill.getClient(),
      stateManager.botState,
      analyticsSkill.getDB(),
      context.config
    );

    this.maxPositionSize = context.config.MAX_POSITION_SIZE || 25;
  }

  async start() {
    await super.start();
    this.orderManager.start();
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const analyticsSkill = this.context.registry.get('analytics-recorder');
    const riskSkill = this.context.registry.get('risk-manager');

    switch (task.action) {
      case 'execute-signals': {
        const signals = task.params?.approvedSignals || [];
        const results = [];
        let executedCount = 0;
        const maxPerScan = 2;
        let lastTicker = null;

        for (const signal of signals) {
          if (executedCount >= maxPerScan) break;

          // Skip duplicate signals for the same ticker within the same
          // scan window to avoid Kalshi 429 rate limits.
          if (this._isDuplicate(signal.ticker)) {
            console.log(`[OrderExecutor] SKIP DUPLICATE ${signal.ticker} (already executed this scan)`);
            results.push({ signal: signal.ticker, status: 'skipped', reason: 'duplicate_in_scan' });
            continue;
          }

          // Final risk check before execution
          const riskCheck = await riskSkill.execute({
            action: 'check-risk',
            params: { signal },
          });

          if (!riskCheck.success || !riskCheck.approved) {
            console.log(`[OrderExecutor] RISK BLOCKED ${signal.ticker}: ${riskCheck.reason || 'risk_check_failed'}`);
            results.push({ signal: signal.ticker, status: 'blocked', reason: riskCheck.reason || 'risk_check_failed' });
            continue;
          }

          console.log(`[OrderExecutor] RISK APPROVED ${signal.ticker}: ${signal.contracts} contracts @ ${signal.priceCents}c, cost=${riskCheck.cost}`);

          if (lastTicker === signal.ticker) await sleep(100);

          const result = await this._executeSignal(signal, state, kalshiSkill, analyticsSkill);
          results.push(result);
          if (result.status === 'executed') executedCount++;
          lastTicker = signal.ticker;
        }

        return { executedSignals: results, totalExecuted: executedCount };
      }

      case 'place-order': {
        const orderData = task.params?.orderData;
        const order = await kalshiSkill.getClient().placeOrder(orderData);
        return { order };
      }

      case 'cancel-order': {
        const orderId = task.params?.orderId;
        await kalshiSkill.getClient().cancelOrder(orderId);
        return { cancelled: true };
      }

      case 'check-order-status': {
        const orderId = task.params?.orderId;
        const order = await kalshiSkill.getClient().getOrder(orderId);
        return { order };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async _executeSignal(signal, state, kalshiSkill, analyticsSkill) {
    const cost = signal.priceDecimal * signal.contracts;

    // Log signal
    const signalId = analyticsSkill.logSignalDirect(signal, true);

    // Snapshot market state
    const market = state.activeMarkets.find(m => m.ticker === signal.ticker);
    if (market) {
      analyticsSkill.logMarketSnapshotDirect(market, state.btcPrice.binance, 'pre_execution');
    }

    try {
      const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const orderData = {
        ticker: signal.ticker,
        action: 'buy',
        side: signal.side,
        count: signal.contracts,
        type: 'market',
        client_order_id: clientOrderId,
        priceCents: signal.priceCents,
      };

      // Market orders don't take a price parameter

      state.updateIntent({
        status: 'executing',
        message: `Executing ${signal.type}...`,
        action: `BUY ${signal.side.toUpperCase()} ${signal.ticker} x${signal.contracts} @ ${signal.priceCents}c`,
      });

      console.log(`[OrderExecutor] Executing: ${signal.type} ${signal.ticker} ${signal.side} x${signal.contracts} @ ${signal.priceCents}c | Edge: ${signal.edge.toFixed(1)}%`);

      // Ensure balance on the market's exchange shard before placing order
      const client = kalshiSkill.getClient();
      const market = state.activeMarkets.find(m => m.ticker === signal.ticker);
      if (market && market.exchange_index != null) {
        const shard = market.exchange_index;
        const costCents = signal.priceCents * signal.contracts;
        // Check if we have enough balance on that shard
        const bal = await client.get('/trade-api/v2/portfolio/balance');
        const breakdown = bal.data.balance_breakdown || [];
        const shardBalance = breakdown.find(b => b.exchange_index === shard);
        const availableOnShard = shardBalance ? Math.floor(parseFloat(shardBalance.balance) / 100 * 100) : 0; // cents
        if (availableOnShard < costCents) {
          const needCents = costCents - availableOnShard + 100; // add buffer
          console.log(`[OrderExecutor] Transferring ${needCents}¢ to exchange ${shard} for ${signal.ticker}`);
          try {
            await client.transferBalance(needCents, 0, shard);
            // Small delay for transfer to settle
            await new Promise(r => setTimeout(r, 500));
          } catch (transferErr) {
            console.warn(`[OrderExecutor] Balance transfer failed: ${transferErr.message}`);
          }
        }
      }

      let order;
      try {
        order = await kalshiSkill.getClient().placeOrder(orderData);
      } catch (placeErr) {
        const detail = placeErr.response
          ? `${placeErr.response.status} - ${JSON.stringify(placeErr.response.data)}`
          : placeErr.message;
        console.error(`[OrderExecutor] placeOrder THREW for ${signal.ticker}: ${detail}`);
        throw placeErr;
      }

      // DEBUG: log the full Kalshi order response so we can see why it didn't fill
      if (process.env.DEBUG_ORDERS === 'true') {
        // Safe JSON conversion with circular reference handling
        try {
          console.log(`[OrderExecutor] FULL ORDER RESPONSE for ${order?.order_id || 'unknown'}:`, JSON.stringify({ ...order }, null, 2));
        } catch (e) {
          console.log(`[OrderExecutor] FULL ORDER RESPONSE for ${order?.order_id || 'unknown'}: [circular data]`);
        }
      }

      console.log(`[OrderExecutor] Order ${order?.order_id || 'unknown'}: ${order?.status || 'unknown'} | Filled: ${order?.fill_count || 0}/${signal.contracts}`);

      // Log order — only if the API returned a valid order object
      if (order?.order_id) {
        analyticsSkill.logOrderDirect({
          order_id: order.order_id, client_order_id: clientOrderId,
          ticker: signal.ticker, side: signal.side, action: 'buy',
          price_cents: signal.priceCents, count: signal.contracts,
          status: order.status, fill_count: order.fill_count || 0,
          taker_fill_cost: order.taker_fill_cost || 0,
          taker_fees: order.taker_fees || 0, close_time: signal.closeTime,
        }, signalId);
      }

      // Add to pending orders
      const pendingOrder = {
        orderId: order?.order_id || clientOrderId, clientOrderId,
        ticker: signal.ticker, signalType: signal.type,
        side: signal.side, contracts: signal.contracts,
        fillCount: order?.fill_count || 0,
        priceCents: signal.priceCents, priceDecimal: signal.priceDecimal,
        reservedCost: cost, edge: signal.edge, modelProb: signal.modelProb,
        reason: signal.reason, placedAt: Date.now(),
        closeTime: signal.closeTime, orderStatus: order.status,
        isDualSide: signal.isDualSide || false,
      };

      this.orderManager.addPendingOrder(pendingOrder);

      // Deduct cost locally
      state.balance.available -= cost;
      if (state.balance.available < 0) state.balance.available = 0;

      state.stats.volumeTraded += cost;
      state.stats.totalEdge += signal.edge;
      state.stats.avgEdge = state.stats.totalEdge / (state.stats.totalTrades + state.openPositions.length || 1);

      state.logTrade({
        type: 'TRADE', action: 'BUY', side: signal.side,
        ticker: signal.ticker, contracts: signal.contracts,
        price: signal.priceCents, edge: signal.edge,
        signalType: signal.type, reason: signal.reason,
      });

      state.emitStats();

      // Schedule settlement check
      const timeToSettle = signal.closeTime - Date.now() + 60000;
      if (timeToSettle > 0) {
        const positionManager = this.context.registry.get('position-manager');
        setTimeout(() => positionManager.settlePositionById(pendingOrder.orderId), timeToSettle);
      }

      // Refresh balance
      await kalshiSkill.getClient().fetchBalance();

      return { signal: signal.ticker, status: 'executed', orderId: order.order_id };
    } catch (err) {
      const detail = err.response
        ? `${err.response.status} - ${JSON.stringify(err.response.data)}`
        : err.message;
      console.error(`[OrderExecutor] EXECUTION FAILED for ${signal.ticker}: ${detail}`);
      return { signal: signal.ticker, status: 'error', error: detail };
    }
  }

  async stop() {
    if (this.orderManager) this.orderManager.stop();
    await super.stop();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = OrderExecutor;
