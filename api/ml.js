/**
 * Vercel Serverless: GET /api/ml
 *
 * Returns ML pipeline status and recent predictions.
 */
const mlPipeline = require('../lib/ml-pipeline');
const supabase = require('../lib/supabase');

module.exports = async (req, res) => {
  await supabase.initialize();

  const status = mlPipeline.describe();
  const performance = await supabase.getStrategyPerformance(7);

  res.json({
    ml: status,
    strategyPerformance: performance,
  });
};
