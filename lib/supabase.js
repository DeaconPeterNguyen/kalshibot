/**
 * Supabase Client — Persistent storage for state, analytics, and ML features.
 *
 * Replaces SQLite (better-sqlite3) for serverless/Vercel deployment.
 * Tables:
 *   - bot_state       : Persisted bot state (JSON blob, single row)
 *   - signals          : Signal generation events (ML training data)
 *   - orders           : Order lifecycle tracking
 *   - market_snapshots : Market state at key moments
 *   - ml_features      : Extracted features for ML model training
 *   - ml_predictions   : Model predictions and outcomes (for feedback loop)
 *   - embeddings       : RAG vector embeddings for trade context retrieval
 */

let createClient;
try {
  createClient = require('@supabase/supabase-js').createClient;
} catch {
  // Supabase not installed — provide stub for local dev
  createClient = null;
}

class SupabaseStore {
  constructor() {
    this.client = null;
    this.enabled = false;
  }

  async initialize() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !key || !createClient) {
      console.log('[Supabase] Not configured — using local file storage fallback');
      return;
    }

    this.client = createClient(url, key);
    this.enabled = true;
    console.log('[Supabase] Connected');

    // Warm the schema cache so the first real query doesn't throw
    // "Could not find the table in the schema cache".
    await this.warmSchema();
  }

  /**
   * Warm the Supabase schema cache by hitting each table.
   * Without this, the first real query throws "Could not find the table
   * in the schema cache" even though the table exists in the database.
   */
  async warmSchema() {
    if (!this.enabled) return;
    const tables = [
      'bot_state', 'signals', 'orders', 'market_snapshots',
      'ml_features', 'ml_predictions', 'embeddings',
    ];
    for (const t of tables) {
      try {
        const { error } = await this.client.from(t).select('*').limit(1);
        if (error && error.code !== 'PGRST200') {
          console.warn(`[Supabase] warmSchema: ${t}: ${error.message}`);
        }
      } catch (e) {
        console.warn(`[Supabase] warmSchema ${t} skipped: ${e.message}`);
      }
    }
  }

  // ===== Bot State =====

  async saveState(stateJson) {
    if (!this.enabled) return;
    const { error } = await this.client
      .from('bot_state')
      .upsert({ id: 1, state: stateJson, updated_at: new Date().toISOString() });
    if (error) console.error('[Supabase] saveState error:', error.message);
  }

  async loadState() {
    if (!this.enabled) return null;
    const { data, error } = await this.client
      .from('bot_state')
      .select('state')
      .eq('id', 1)
      .single();
    if (error || !data) return null;
    return data.state;
  }

  // ===== Signal Logging (ML Training Data) =====

  async logSignal(signal) {
    if (!this.enabled) return null;
    const record = {
      ts: new Date().toISOString(),
      type: signal.type,
      ticker: signal.ticker,
      side: signal.side,
      price_cents: signal.priceCents,
      edge: signal.edge,
      model_prob: signal.modelProb,
      contracts: signal.contracts,
      reason: signal.reason,
      executed: signal.executed ?? true,
      blocked_reason: signal.blockedReason || null,
    };
    const { data, error } = await this.client.from('signals').insert(record).select('id').single();
    if (error) { console.error('[Supabase] logSignal error:', error.message); return null; }
    return data?.id;
  }

  async updateSignalOutcome(signalId, outcome) {
    if (!this.enabled || !signalId) return;
    const { error } = await this.client
      .from('signals')
      .update({
        outcome_won: outcome.won,
        outcome_pnl: outcome.pnl,
        settled_at: new Date().toISOString(),
      })
      .eq('id', signalId);
    if (error) console.error('[Supabase] updateSignalOutcome error:', error.message);
  }

  // ===== Order Logging =====

  async logOrder(order) {
    if (!this.enabled) return;
    const { error } = await this.client.from('orders').insert({
      ts: new Date().toISOString(),
      order_id: order.order_id,
      client_order_id: order.client_order_id,
      signal_id: order.signal_id || null,
      ticker: order.ticker,
      side: order.side,
      action: order.action,
      price_cents: order.price_cents,
      count: order.count,
      status: order.status,
      fill_count: order.fill_count || 0,
      taker_fill_cost: order.taker_fill_cost || 0,
      taker_fees: order.taker_fees || 0,
      close_time: order.close_time,
    });
    if (error) console.error('[Supabase] logOrder error:', error.message);
  }

  // ===== Market Snapshots =====

  async logMarketSnapshot(snapshot) {
    if (!this.enabled) return;
    const { error } = await this.client.from('market_snapshots').insert({
      ts: new Date().toISOString(),
      ticker: snapshot.ticker,
      yes_bid: snapshot.yesBid,
      yes_ask: snapshot.yesAsk,
      no_bid: snapshot.noBid,
      no_ask: snapshot.noAsk,
      btc_price: snapshot.btcPrice,
      time_remaining_s: snapshot.timeRemainingS,
      context: snapshot.context,
    });
    if (error) console.error('[Supabase] logMarketSnapshot error:', error.message);
  }

  // ===== ML Features (for model training) =====

  async logFeatures(features) {
    if (!this.enabled) return;
    const { error } = await this.client.from('ml_features').insert({
      ts: new Date().toISOString(),
      ticker: features.ticker,
      signal_type: features.signalType,
      features: features.vector, // JSONB array of numeric features
      label: features.label,     // 1 = won, 0 = lost, null = pending
      signal_id: features.signalId,
    });
    if (error) console.error('[Supabase] logFeatures error:', error.message);
  }

  async getTrainingData(limit = 10000) {
    if (!this.enabled) return [];
    const { data, error } = await this.client
      .from('ml_features')
      .select('features, label')
      .not('label', 'is', null)
      .order('ts', { ascending: false })
      .limit(limit);
    if (error) { console.error('[Supabase] getTrainingData error:', error.message); return []; }
    return data || [];
  }

  // ===== ML Predictions =====

  async logPrediction(prediction) {
    if (!this.enabled) return;
    const { error } = await this.client.from('ml_predictions').insert({
      ts: new Date().toISOString(),
      signal_id: prediction.signalId,
      model_version: prediction.modelVersion,
      confidence: prediction.confidence,
      predicted_outcome: prediction.predictedOutcome,
      features_hash: prediction.featuresHash,
    });
    if (error) console.error('[Supabase] logPrediction error:', error.message);
  }

  // ===== RAG Embeddings =====

  async storeEmbedding(text, embedding, metadata = {}) {
    if (!this.enabled) return;
    const { error } = await this.client.from('embeddings').insert({
      content: text,
      embedding, // pgvector expects an array of floats
      metadata,
      created_at: new Date().toISOString(),
    });
    if (error) console.error('[Supabase] storeEmbedding error:', error.message);
  }

  async searchSimilar(queryEmbedding, limit = 5) {
    if (!this.enabled) return [];
    // Uses pgvector similarity search via Supabase RPC
    const { data, error } = await this.client.rpc('match_embeddings', {
      query_embedding: queryEmbedding,
      match_count: limit,
    });
    if (error) { console.error('[Supabase] searchSimilar error:', error.message); return []; }
    return data || [];
  }

  // ===== Recent Signals for RAG Context =====

  async getRecentSignals(ticker, hours = 24) {
    if (!this.enabled) return [];
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const { data, error } = await this.client
      .from('signals')
      .select('*')
      .gte('ts', since)
      .order('ts', { ascending: false })
      .limit(50);
    if (error) return [];
    return data || [];
  }

  async getStrategyPerformance(days = 7) {
    if (!this.enabled) return {};
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await this.client
      .from('signals')
      .select('type, outcome_won, outcome_pnl, edge')
      .gte('ts', since)
      .not('outcome_won', 'is', null);
    if (error) return {};

    const stats = {};
    for (const s of (data || [])) {
      if (!stats[s.type]) stats[s.type] = { wins: 0, losses: 0, pnl: 0, totalEdge: 0, count: 0 };
      const st = stats[s.type];
      st.count++;
      if (s.outcome_won) st.wins++; else st.losses++;
      st.pnl += s.outcome_pnl || 0;
      st.totalEdge += s.edge || 0;
    }
    return stats;
  }
}

// Supabase SQL migrations for initial setup
SupabaseStore.MIGRATIONS = `
-- Bot state (single row, JSON blob)
CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signals (ML training data)
CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  price_cents INTEGER,
  edge REAL,
  model_prob REAL,
  contracts INTEGER,
  reason TEXT,
  executed BOOLEAN DEFAULT TRUE,
  blocked_reason TEXT,
  outcome_won BOOLEAN,
  outcome_pnl REAL,
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_id TEXT UNIQUE,
  client_order_id TEXT,
  signal_id BIGINT REFERENCES signals(id),
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  action TEXT NOT NULL,
  price_cents INTEGER,
  count INTEGER,
  status TEXT,
  fill_count INTEGER DEFAULT 0,
  taker_fill_cost INTEGER DEFAULT 0,
  taker_fees INTEGER DEFAULT 0,
  close_time BIGINT
);

-- Market snapshots
CREATE TABLE IF NOT EXISTS market_snapshots (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker TEXT NOT NULL,
  yes_bid REAL,
  yes_ask REAL,
  no_bid REAL,
  no_ask REAL,
  btc_price REAL,
  time_remaining_s REAL,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON market_snapshots(ticker);

-- ML features (for model training)
CREATE TABLE IF NOT EXISTS ml_features (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker TEXT,
  signal_type TEXT,
  features JSONB NOT NULL,
  label INTEGER,
  signal_id BIGINT REFERENCES signals(id)
);
CREATE INDEX IF NOT EXISTS idx_ml_features_label ON ml_features(label);

-- ML predictions (feedback loop)
CREATE TABLE IF NOT EXISTS ml_predictions (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_id BIGINT REFERENCES signals(id),
  model_version TEXT,
  confidence REAL,
  predicted_outcome INTEGER,
  features_hash TEXT
);

-- RAG embeddings (pgvector)
-- Requires: CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS embeddings (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Similarity search function
CREATE OR REPLACE FUNCTION match_embeddings(query_embedding vector(1536), match_count INT DEFAULT 5)
RETURNS TABLE(id BIGINT, content TEXT, metadata JSONB, similarity REAL)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, e.content, e.metadata,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM embeddings e
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
`;

// Singleton
const store = new SupabaseStore();
module.exports = store;
