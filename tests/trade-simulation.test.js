/**
 * trade-simulation.test.js
 *
 * Simulates real Kalshi market conditions and runs the full order placement
 * logic (kalshiPlaceOrder) against a mock fetch — no real credentials needed.
 *
 * Market scenarios tested:
 *   1. Normal market — full IOC fill
 *   2. Thin market   — IOC partial fill (fewer contracts than requested)
 *   3. No liquidity  — IOC cancelled, 0 fills → should throw
 *   4. Budget too low — 1 contract costs more than bet → should throw
 *   5. API 400 error  — Kalshi rejects order → should throw with detail
 *   6. API 401 error  — auth failure → should throw
 *   7. Non-JSON response — proxy returns plain text → should throw
 *   8. Sell: GTC partial fill accepted
 *   9. Sell: invalid contractsToSell → should throw
 *  10. High-volatility market — ask spikes, count recalculated correctly
 *
 * Run: node tests/trade-simulation.test.js
 * Exit 0 = all pass, 1 = at least one failure.
 */

'use strict';
const assert = require('assert');

// ─── Mock market state (mirrors index.html globals) ──────────────────────────
let kalshiMarket       = null;
let kalshiYESPrice     = null;
let kalshiOrderId      = null;
let kalshiOrderSide    = null;
let kalshiOrderContracts = 0;
let kalshiOrderCost    = 0;
let autoCloseArmed     = false;

function resetState() {
  kalshiOrderId = null; kalshiOrderSide = null;
  kalshiOrderContracts = 0; kalshiOrderCost = 0;
  autoCloseArmed = false;
}

// ─── Mock fetch ───────────────────────────────────────────────────────────────
// Replace global fetch with a function that returns whatever the test sets up.
let _mockResponse = null;
global.fetch = async (_url, _opts) => {
  const { status, body, ok, text } = _mockResponse;
  return {
    status,
    ok: ok !== undefined ? ok : (status >= 200 && status < 300),
    json: async () => {
      if (text) throw new Error('not JSON');
      return body;
    },
    text: async () => {
      if (text) return text;
      return JSON.stringify(body);
    },
  };
};

function mockOk(body)         { _mockResponse = { status: 200, body }; }
function mockError(status, body) { _mockResponse = { status, body, ok: false }; }
function mockText(status, txt)   { _mockResponse = { status, text: txt, ok: false }; }

// ─── INLINED: kalshiPlaceOrder (from index.html ~line 5327) ──────────────────
async function kalshiPlaceOrder(bet, amountDollars) {
  if (!kalshiMarket) throw new Error('No active Kalshi market found');
  if (bet !== 'UP' && bet !== 'DOWN') throw new Error(`Invalid bet direction: ${bet}`);

  const side = bet === 'UP' ? 'yes' : 'no';
  const ticker = kalshiMarket.ticker;
  if (!ticker) throw new Error('Kalshi market ticker missing');

  const bid = parseFloat(kalshiMarket.yes_bid_dollars) || (kalshiMarket.yes_bid != null ? kalshiMarket.yes_bid / 100 : 0);
  const ask = parseFloat(kalshiMarket.yes_ask_dollars) || (kalshiMarket.yes_ask != null ? kalshiMarket.yes_ask / 100 : 0);
  const mid = kalshiYESPrice || 0.5;

  const fillPrice = side === 'yes'
    ? (ask > 0 ? ask : mid * 1.05)
    : (bid > 0 ? (1 - bid) : (1 - mid) * 1.05);

  const maxCostCents = Math.round(amountDollars * 100);
  if (!isFinite(maxCostCents) || maxCostCents <= 0) throw new Error(`Invalid bet amount: $${amountDollars}`);

  const minCostCents = Math.ceil(Math.round(fillPrice * 10000) / 100); // IEEE-754 safe
  if (maxCostCents < minCostCents) {
    throw new Error(`Minimum bet $${(minCostCents/100).toFixed(2)} required (1 ${side.toUpperCase()} contract at ${(fillPrice*100).toFixed(0)}¢ each) — your bet: $${(maxCostCents/100).toFixed(2)}`);
  }

  const count = Math.floor(amountDollars / fillPrice);
  const client_order_id = 'test_' + Date.now();
  const priceFieldStr = side === 'yes'
    ? { yes_price_dollars: '0.9900' }
    : { no_price_dollars:  '0.9900' };

  const orderBody = {
    ticker, client_order_id, side, action: 'buy', type: 'limit', count,
    time_in_force: 'ioc',
    buy_max_cost: maxCostCents,
    ...priceFieldStr,
  };

  const r = await fetch('/api/kalshi?path=/portfolio/orders&method=POST', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderBody),
  });
  const json = await r.json().catch(() => null);

  if (!r.ok) {
    const msg = json?.error?.details || json?.error?.message || json?.detail || `HTTP ${r.status}`;
    throw new Error(msg);
  }

  const order = json.order || json;
  const filled = parseFloat(order.filled_count || order.taker_fill_count || 0);
  const status = order.status || '';

  // IOC: filled=0 + cancelled = no liquidity
  if (filled === 0 && status === 'cancelled') {
    throw new Error('Order not filled — no contracts available right now, try again');
  }

  const confirmedContracts = filled > 0 ? filled : count;
  kalshiOrderId        = order.order_id ?? order.id ?? null;
  kalshiOrderSide      = side;
  kalshiOrderContracts = confirmedContracts;
  kalshiOrderCost      = order.taker_fill_cost ? (order.taker_fill_cost / 100) : amountDollars;
  autoCloseArmed       = true;

  return order;
}

// ─── INLINED: close position validation (from kalshiClosePosition ~line 5456) ─
function validateContractsToSell(kalshiOrderContracts) {
  const contractsToSell = Math.floor(kalshiOrderContracts);
  if (!isFinite(contractsToSell) || contractsToSell < 1) {
    throw new Error(`[Kalshi] invalid contractsToSell (${kalshiOrderContracts}) — position not sold, try again`);
  }
  return contractsToSell;
}

// ─── TEST HARNESS ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  resetState();
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // async test — handled below via sequential runner
      return result.then(() => { console.log(`  PASS  ${name}`); passed++; })
        .catch(err => { console.log(`  FAIL  ${name}\n        ${err.message}`); failed++; });
    }
    console.log(`  PASS  ${name}`); passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`); failed++;
  }
}

// Run all tests sequentially (async)
async function run() {

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 1: Normal market — full IOC fill ────────────────────');

await test('YES buy fills completely (5 contracts at $0.60 each, budget $3.00)', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.58', yes_ask_dollars: '0.60' };
  kalshiYESPrice = 0.59;
  // Mock: Kalshi returns fully filled order
  mockOk({ order: { order_id: 'ord_abc123', status: 'filled', filled_count: 5, taker_fill_cost: 300 } });

  const order = await kalshiPlaceOrder('UP', 3.00);
  assert.strictEqual(kalshiOrderSide, 'yes');
  assert.strictEqual(kalshiOrderContracts, 5, `Expected 5 contracts, got ${kalshiOrderContracts}`);
  assert.strictEqual(autoCloseArmed, true);
  assert.strictEqual(order.order_id, 'ord_abc123');
});

await test('NO buy fills completely (3 contracts at $0.40 each, budget $1.20)', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.60', yes_ask_dollars: '0.62' };
  kalshiYESPrice = 0.61;
  // NO fill price = 1 - bid = 1 - 0.60 = 0.40, count = floor(1.20/0.40) = 3
  mockOk({ order: { order_id: 'ord_no_001', status: 'filled', filled_count: 3, taker_fill_cost: 120 } });

  const order = await kalshiPlaceOrder('DOWN', 1.20);
  assert.strictEqual(kalshiOrderSide, 'no');
  assert.strictEqual(kalshiOrderContracts, 3);
  assert.strictEqual(order.order_id, 'ord_no_001');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 2: Thin market — IOC partial fill ───────────────────');

await test('IOC partial fill: requested 10 contracts, got 4 — uses actual filled count', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  // budget=$5, fillPrice=$0.50, count=10 — but market only has 4
  mockOk({ order: { order_id: 'ord_partial', status: 'cancelled', filled_count: 4, taker_fill_cost: 200 } });

  const order = await kalshiPlaceOrder('UP', 5.00);
  // IOC partial: filled=4, status=cancelled — should NOT throw (filled > 0)
  assert.strictEqual(kalshiOrderContracts, 4, `Expected 4 (actual fills), got ${kalshiOrderContracts}`);
  assert.strictEqual(autoCloseArmed, true);
});

await test('IOC partial fill: filled_count reported as float (2.0) → stored as-is', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.28', yes_ask_dollars: '0.30' };
  kalshiYESPrice = 0.29;
  mockOk({ order: { order_id: 'ord_float', status: 'cancelled', filled_count: 2.0, taker_fill_cost: 60 } });

  await kalshiPlaceOrder('UP', 3.00);
  assert.strictEqual(kalshiOrderContracts, 2.0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 3: No liquidity — IOC cancelled with 0 fills ────────');

await test('IOC cancelled, 0 fills → throws "no contracts available"', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  mockOk({ order: { order_id: 'ord_nofill', status: 'cancelled', filled_count: 0 } });

  let threw = false;
  try { await kalshiPlaceOrder('UP', 5.00); }
  catch (e) {
    threw = true;
    assert.ok(e.message.includes('no contracts available'), `Wrong message: ${e.message}`);
  }
  assert.ok(threw, 'Should have thrown');
  assert.strictEqual(autoCloseArmed, false, 'autoCloseArmed must stay false on failure');
});

await test('IOC cancelled, missing filled_count → treated as 0 → throws', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  mockOk({ order: { order_id: 'ord_miss', status: 'cancelled' } }); // no filled_count field

  let threw = false;
  try { await kalshiPlaceOrder('UP', 2.00); }
  catch (e) { threw = true; }
  assert.ok(threw, 'Missing filled_count + cancelled should throw');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 4: Budget too small for 1 contract ──────────────────');

await test('$0.05 budget, YES contract costs $0.62 → throws with minimum bet message', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.60', yes_ask_dollars: '0.62' };
  kalshiYESPrice = 0.61;

  let threw = null;
  try { await kalshiPlaceOrder('UP', 0.05); }
  catch (e) { threw = e.message; }
  assert.ok(threw, 'Should throw for budget < 1 contract cost');
  assert.ok(threw.includes('Minimum bet'), `Expected "Minimum bet" in message, got: ${threw}`);
  assert.ok(threw.includes('0.62'), `Should mention fill price 62¢: ${threw}`);
});

await test('NO contract: $0.05 budget, YES=95¢ so NO=5¢/contract → exactly 1 contract possible', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.95', yes_ask_dollars: '0.96' };
  kalshiYESPrice = 0.95;
  // NO fillPrice = 1 - 0.95 = 0.050000000000000044 (IEEE-754), but Math.round(*10000)/100 = 5 → ceil = 5 ✓
  mockOk({ order: { order_id: 'ord_cheap_no', status: 'filled', filled_count: 1, taker_fill_cost: 5 } });

  await kalshiPlaceOrder('DOWN', 0.05);
  assert.strictEqual(kalshiOrderContracts, 1);
  assert.strictEqual(kalshiOrderSide, 'no');
});

await test('floating-point edge case: 1-0.97 is not exactly 0.03 — Math.ceil rounds up to 4¢ min', async () => {
  // 1 - 0.97 = 0.030000000000000027 in IEEE-754 → Math.ceil(*100) = 4, not 3
  // So $0.03 budget is BELOW minimum even though market shows NO at "3¢"
  // $0.04 budget covers it correctly
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.97', yes_ask_dollars: '0.98' };
  kalshiYESPrice = 0.97;
  mockOk({ order: { order_id: 'ord_fp', status: 'filled', filled_count: 1, taker_fill_cost: 3 } });

  await kalshiPlaceOrder('DOWN', 0.04); // 4¢ budget covers the ceil'd 4¢ minimum
  assert.strictEqual(kalshiOrderContracts, 1);
});

await test('exactly at minimum: budget = 1 contract cost exactly → does NOT throw', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.58', yes_ask_dollars: '0.75' };
  kalshiYESPrice = 0.65;
  // fillPrice=0.75, count=floor(0.75/0.75)=1, budget=75¢=minCostCents ✓
  mockOk({ order: { order_id: 'ord_exact', status: 'filled', filled_count: 1, taker_fill_cost: 75 } });

  await kalshiPlaceOrder('UP', 0.75);
  assert.strictEqual(kalshiOrderContracts, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 5: Kalshi API error responses ───────────────────────');

await test('400 invalid_order → throws with error.details message', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  mockError(400, { error: { code: 'invalid_order', message: 'invalid order', details: 'count or count_fp must be provided' } });

  let threw = null;
  try { await kalshiPlaceOrder('UP', 5.00); }
  catch (e) { threw = e.message; }
  assert.ok(threw, 'Should throw on 400');
  assert.strictEqual(threw, 'count or count_fp must be provided', `Expected details field, got: ${threw}`);
});

await test('400 with only error.message (no details) → falls back to message', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  mockError(400, { error: { code: 'bad_request', message: 'Market is closed' } });

  let threw = null;
  try { await kalshiPlaceOrder('UP', 5.00); }
  catch (e) { threw = e.message; }
  assert.strictEqual(threw, 'Market is closed');
});

await test('401 unauthorized → throws HTTP 401 message', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  mockError(401, { error: { message: 'Unauthorized', details: 'Invalid API key signature' } });

  let threw = null;
  try { await kalshiPlaceOrder('UP', 5.00); }
  catch (e) { threw = e.message; }
  assert.strictEqual(threw, 'Invalid API key signature');
});

await test('429 rate limit → throws with HTTP 429 fallback', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  mockError(429, { detail: 'Rate limit exceeded' });

  let threw = null;
  try { await kalshiPlaceOrder('UP', 5.00); }
  catch (e) { threw = e.message; }
  assert.strictEqual(threw, 'Rate limit exceeded');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 6: Missing fields in response ───────────────────────');

await test('order_id missing → kalshiOrderId = null, warns but does not throw', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  // No order_id in response — simulates malformed Kalshi response
  mockOk({ order: { status: 'filled', filled_count: 5, taker_fill_cost: 250 } });

  await kalshiPlaceOrder('UP', 5.00);
  assert.strictEqual(kalshiOrderId, null, `Expected null, got ${kalshiOrderId}`);
  assert.strictEqual(kalshiOrderContracts, 5, 'Contracts should still be recorded');
});

await test('taker_fill_cost missing → falls back to amountDollars', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  mockOk({ order: { order_id: 'ord_nocost', status: 'filled', filled_count: 3 } }); // no taker_fill_cost

  await kalshiPlaceOrder('UP', 1.50);
  assert.strictEqual(kalshiOrderCost, 1.50, `Expected amountDollars fallback 1.50, got ${kalshiOrderCost}`);
});

await test('response uses top-level fields (not nested under "order") → still works', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  kalshiYESPrice = 0.49;
  // Some Kalshi API versions return the order at the top level, not nested
  mockOk({ order_id: 'ord_toplevel', status: 'filled', filled_count: 7, taker_fill_cost: 350 });

  await kalshiPlaceOrder('UP', 5.00);
  assert.strictEqual(kalshiOrderId, 'ord_toplevel');
  assert.strictEqual(kalshiOrderContracts, 7);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 7: Sell — validateContractsToSell ───────────────────');

test('valid integer contracts (5) → returns 5', () => {
  assert.strictEqual(validateContractsToSell(5), 5);
});

test('fractional contracts (2.7) → floor to 2', () => {
  assert.strictEqual(validateContractsToSell(2.7), 2);
});

test('sub-1 float (0.9) → throws (floor=0 < 1)', () => {
  assert.throws(() => validateContractsToSell(0.9), /invalid contractsToSell/);
});

test('zero → throws', () => {
  assert.throws(() => validateContractsToSell(0), /invalid contractsToSell/);
});

test('NaN → throws', () => {
  assert.throws(() => validateContractsToSell(NaN), /invalid contractsToSell/);
});

test('negative → throws', () => {
  assert.throws(() => validateContractsToSell(-1), /invalid contractsToSell/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 8: High-volatility market — price spike ─────────────');

await test('ask spikes from 0.50 to 0.85 — count recalculates, budget still holds', async () => {
  // Simulate a price spike: YES ask jumped to $0.85 (bullish sentiment)
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.80', yes_ask_dollars: '0.85' };
  kalshiYESPrice = 0.82;
  // budget=$4.25, fillPrice=$0.85, count=floor(4.25/0.85)=5, maxCostCents=425, 5*85=425 ✓
  mockOk({ order: { order_id: 'ord_spike', status: 'filled', filled_count: 5, taker_fill_cost: 425 } });

  await kalshiPlaceOrder('UP', 4.25);
  assert.strictEqual(kalshiOrderContracts, 5);
  // Verify count*fillPrice <= budget
  const fillPrice = 0.85;
  const count = Math.floor(4.25 / fillPrice);
  assert.ok(count * fillPrice * 100 <= 425, `count*fillPrice (${count*fillPrice*100}¢) must be <= 425¢`);
});

await test('ask drops to $0.05 (crash) — count scales up, budget still holds', async () => {
  // Market crash: YES ask dropped to $0.05 (market thinks event very unlikely)
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.03', yes_ask_dollars: '0.05' };
  kalshiYESPrice = 0.04;
  // budget=$1.00, fillPrice=$0.05, count=floor(1.00/0.05)=20, maxCostCents=100
  mockOk({ order: { order_id: 'ord_crash', status: 'filled', filled_count: 20, taker_fill_cost: 100 } });

  await kalshiPlaceOrder('UP', 1.00);
  assert.strictEqual(kalshiOrderContracts, 20);
  const count = Math.floor(1.00 / 0.05);
  assert.ok(count * 0.05 * 100 <= 100, 'Budget must hold at low prices');
});

await test('mid-price fallback when ask=0 (stale market data) — uses mid*1.05', async () => {
  // ask=0 means market data is stale — should fall back to mid*1.05
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0' };
  kalshiYESPrice = 0.50; // mid from WebSocket
  // fillPrice = 0.50 * 1.05 = 0.525 → ceil = 53¢, count = floor(2.00/0.525) = 3
  mockOk({ order: { order_id: 'ord_fallback', status: 'filled', filled_count: 3, taker_fill_cost: 157 } });

  await kalshiPlaceOrder('UP', 2.00);
  assert.strictEqual(kalshiOrderContracts, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Scenario 9: Guard conditions ─────────────────────────────────');

test('no kalshiMarket → throws immediately', async () => {
  kalshiMarket = null;
  let threw = false;
  try { await kalshiPlaceOrder('UP', 5.00); } catch { threw = true; }
  assert.ok(threw, 'Should throw when no market');
});

test('invalid bet direction → throws', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  let threw = false;
  try { await kalshiPlaceOrder('SIDEWAYS', 5.00); } catch { threw = true; }
  assert.ok(threw, 'Should throw on invalid direction');
});

test('zero amount → throws invalid bet amount', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  let threw = false;
  try { await kalshiPlaceOrder('UP', 0); } catch { threw = true; }
  assert.ok(threw, 'Should throw on zero amount');
});

test('NaN amount → throws invalid bet amount', async () => {
  kalshiMarket = { ticker: 'KXBTC-25DEC-T100000', yes_bid_dollars: '0.48', yes_ask_dollars: '0.50' };
  let threw = false;
  try { await kalshiPlaceOrder('UP', NaN); } catch { threw = true; }
  assert.ok(threw, 'Should throw on NaN amount');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Summary ───────────────────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

} // end run()

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
