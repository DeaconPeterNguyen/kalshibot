/**
 * MLSignalScorer Skill
 *
 * Integrates the ML pipeline into the agentic framework.
 * Scores signals with a trained gradient-boosted model and
 * retrieves RAG context from historical trades.
 *
 * Capabilities: score-signal, train-model, get-ml-status
 */

const BaseSkill = require('../../core/base-skill');
const mlPipeline = require('../../../lib/ml-pipeline');
const supabase = require('../../../lib/supabase');

class MLSignalScorer extends BaseSkill {
  constructor() {
    super({
      name: 'ml-signal-scorer',
      description: 'ML-powered signal quality scoring with RAG context retrieval',
      domain: 'analysis',
      capabilities: ['score-signal', 'score-signals', 'train-model', 'get-ml-status'],
      dependencies: ['state-manager'],
    });
  }

  async initialize(context) {
    await super.initialize(context);

    // Initialize Supabase connection (and warm the schema cache)
    await supabase.initialize();

    // Attempt to train from existing data
    if (supabase.enabled) {
      try {
        await mlPipeline.train();
      } catch (err) {
        console.log(`[MLSignalScorer] Initial training skipped: ${err.message}`);
      }
    }
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'score-signal': {
        const signal = task.params?.signal;
        if (!signal) throw new Error('signal required');

        const marketContext = this._buildMarketContext(signal, state);
        const result = await mlPipeline.scoreSignal(signal, marketContext);
        return result;
      }

      case 'score-signals': {
        // Score an array of signals, returning adjusted signals
        const signals = task.params?.signals || [];
        const scored = [];

        for (const signal of signals) {
          const marketContext = this._buildMarketContext(signal, state);
          const score = await mlPipeline.scoreSignal(signal, marketContext);

          scored.push({
            ...signal,
            mlConfidence: score.confidence,
            mlAdjustment: score.adjustment,
            mlBlocked: score.shouldBlock,
            ragContext: score.ragContext,
            // Adjust edge by ML confidence
            adjustedEdge: signal.edge * score.adjustment,
          });
        }

        // Filter out ML-blocked signals
        const approved = scored.filter(s => !s.mlBlocked);
        const blocked = scored.filter(s => s.mlBlocked);

        return { scoredSignals: approved, mlBlocked: blocked };
      }

      case 'train-model': {
        const success = await mlPipeline.train();
        return { trained: success, ...mlPipeline.describe() };
      }

      case 'get-ml-status': {
        return mlPipeline.describe();
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _buildMarketContext(signal, state) {
    const market = state.activeMarkets.find(m => m.ticker === signal.ticker);
    const trend = state.model || {};
    const stats = state.stats || {};

    return {
      btcPrice: state.btcPrice.binance || 0,
      openPrice: state.marketOpenPrices[signal.ticker] || 0,
      timeRemainingMs: market ? market.closeTime - Date.now() : 0,
      totalDurationMs: 900000,
      sigma: trend.volatility || 0.0015,
      trend: trend.trend || 'NEUTRAL',
      trendStrength: trend.trendStrength || 0,
      trendROC: trend.trendROC || 0,
      yesAsk: market?.yesAsk || 0.5,
      noAsk: market?.noAsk || 0.5,
      yesBid: market?.yesBid || 0.5,
      noBid: market?.noBid || 0.5,
      recentWinRate: stats.totalTrades > 0 ? stats.wins / stats.totalTrades : 0.5,
      recentPnL: stats.totalPnL || 0,
      streak: stats.streak || 0,
      balanceAvailable: state.balance.available || 0,
    };
  }
}

module.exports = MLSignalScorer;
