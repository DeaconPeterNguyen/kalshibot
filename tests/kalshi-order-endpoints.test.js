'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const KalshiClient = require('../bot/kalshi');

// The bot's KalshiClient.get/post/delete are thin axios wrappers, so stubbing
// the instance methods lets us assert the exact URL path and response handling
// without any network access.

function makeClient() {
  const client = new KalshiClient({ KALSHI_API_KEY: 'k', KALSHI_PRIVATE_KEY_PATH: 'k' }, {});
  client.loadPrivateKey = () => 'fake-pem';
  return client;
}

const SAMPLE_ORDER = {
  order_id: '01a18b80-7cc0-780b-93f3-86abd29c55df',
  client_order_id: 'bot-1793341815487-hf8u0e',
  ticker: 'KXBTC15M-26OCT300245-45',
  status: 'canceled',
  fill_count: '0.00',
  remaining_count: '0.00',
  taker_fill_cost: '0.00',
  taker_fees: '0.00',
};

test('getOrder fetches the single-order path /portfolio/orders/{id}', async () => {
  const client = makeClient();
  const calls = [];
  client.get = async (path) => {
    calls.push(path);
    return { data: { order: SAMPLE_ORDER } };
  };

  const order = await client.getOrder('01a18b80-7cc0-780b-93f3-86abd29c55df');

  assert.deepEqual(calls, ['/trade-api/v2/portfolio/orders/01a18b80-7cc0-780b-93f3-86abd29c55df']);
  assert.equal(order.order_id, '01a18b80-7cc0-780b-93f3-86abd29c55df');
  assert.equal(order.status, 'canceled');
});

test('getOrder does NOT use the /portfolio/events/orders/{id} path (404s on reads)', async () => {
  const client = makeClient();
  client.get = async (path) => {
    assert.ok(!path.includes('events/orders'),
      `getOrder must not hit the events path, got ${path}`);
    return { data: { order: SAMPLE_ORDER } };
  };
  await client.getOrder('abc');
});

test('cancelOrder targets the V2 path /portfolio/events/orders/{id}', async () => {
  const client = makeClient();
  const calls = [];
  client.delete = async (path) => {
    calls.push(path);
    return { data: { order_id: 'abc', client_order_id: 'c', reduced_by: '0' } };
  };

  const result = await client.cancelOrder('abc');

  assert.deepEqual(calls, ['/trade-api/v2/portfolio/events/orders/abc']);
  assert.equal(result.order_id, 'abc');
});

test('getOrder uses /portfolio/orders/{id} (V2 GET), cancelOrder uses /portfolio/events/orders/{id} (V2 DELETE)', async () => {
  const client = makeClient();
  let seenGet = null;
  let seenDelete = null;
  client.get = async (path) => { seenGet = path; return { data: { order: SAMPLE_ORDER } }; };
  client.delete = async (path) => { seenDelete = path; return { data: {} }; };

  await client.getOrder('xyz');
  await client.cancelOrder('xyz');

  // GET single order: /portfolio/orders/{id} (same prefix as list)
  assert.ok(seenGet.startsWith('/trade-api/v2/portfolio/orders/'));
  assert.ok(!seenGet.includes('events'));

  // DELETE (cancel): /portfolio/events/orders/{id} (same prefix as create)
  assert.ok(seenDelete.startsWith('/trade-api/v2/portfolio/events/orders/'));
});

test('getOrder normalizes V2 field names (fill_count_fp -> fill_count, taker_fill_cost_dollars -> taker_fill_cost in cents)', async () => {
  const client = makeClient();
  // The real GET /portfolio/orders/{id} returns V2 field names
  const v2Response = {
    order: {
      order_id: 'xyz',
      fill_count_fp: '12.50',
      initial_count_fp: '25.00',
      remaining_count_fp: '12.50',
      taker_fill_cost_dollars: '6.2500',
      taker_fees_dollars: '0.1250',
      status: 'executed',
    }
  };
  client.get = async () => ({ data: v2Response });

  const order = await client.getOrder('xyz');

  // The returned order object should have normalized field names
  assert.equal(order.fill_count, 12.50); // count as float
  assert.equal(order.taker_fill_cost, 625); // cost in CENTS (6.2500 * 100)
  assert.equal(order.taker_fees, 13); // fees in CENTS (0.1250 * 100 = 12.5, rounded to 13)
});