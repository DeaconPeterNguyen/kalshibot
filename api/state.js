/**
 * Vercel Serverless: GET /api/state
 *
 * Returns the latest bot state from Supabase.
 */
const supabase = require('../lib/supabase');

module.exports = async (req, res) => {
  await supabase.initialize();

  const state = await supabase.loadState();
  if (state) {
    res.json(state);
  } else {
    res.json({ error: 'No state available', hint: 'Bot may not be running yet' });
  }
};
