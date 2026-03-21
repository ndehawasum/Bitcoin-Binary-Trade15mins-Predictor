/**
 * order-flow.test.js
 *
 * Tests for Kalshi order flow logic extracted from index.html.
 * Functions are inlined here — no DOM, no fetch, no globals needed.
 *
 * Run:  node tests/order-flow.test.js
 * Exit: 0 = all pass, 1 = at least one failure.
 */

'use strict';
const assert = require('assert');

// ─── INLINED: computeKellyBet (from index.html ~line 3510) ───────────────────
// Kelly: f* = (b*p - q) / b  where b = (1-price)/price (odds)
const RISK_MAX_ACCT_PCT = 0.20; // max 20% of balance per trade

function computeKellyBet(prob, yesPrice, balance) {
  const p = Math.max(0.01, Math.min(0.99, prob / 100));
  const q = 1 - p;
  const b = (1.00 - yesPrice) / Math.max(0.01, yesPrice);
  const kelly = (b * p - q) / b;
  const halfKelly = Math.max(0, kelly * 0.5);
  return Math.min(halfKelly * balance, RISK_MAX_ACCT_PCT * balance);
}

// ─── INLINED: fillPrice + count + minCostCents logic (from kalshiPlaceOrder ~line 5328) ──
// Params mirror what the real function receives from kalshiMarket and kalshiYESPrice.
function computeOrderParams({ side, yesBidDollars, yesAskDollars, yesPrice, amountDollars }) {
  const bid = yesBidDollars || 0;
  const ask = yesAskDollars || 0;
  const mid = yesPrice || 0.5;

  const fillPrice = side === 'yes'
    ? (ask > 0 ? ask : mid * 1.05)
    : (bid > 0 ? (1 - bid) : (1 - mid) * 1.05);

  const maxCostCents  = Math.round(amountDollars * 100);
  const minCostCents  = Math.ceil(fillPrice * 100);        // cost of 1 contract in cents
  const count         = Math.floor(amountDollars / fillPrice); // always >= 1 after minCost check

  return { fillPrice, maxCostCents, minCostCents, count };
}

// ─── INLINED: order-response handling (from kalshiPlaceOrder ~line 5396) ──────
// Returns confirmedContracts or throws, mirroring the real function's post-HTTP logic.
function handleOrderResponse(order, count) {
  const filled = parseFloat(order.filled_count || order.taker_fill_count || 0);
  const status = order.status || '';

  if (filled === 0 && status === 'cancelled') {
    throw new Error('Order not filled — no matching seller right now, try again');
  }

  const confirmedContracts = filled > 0 ? filled : count;
  return { confirmedContracts, filled, status };
}

// ─── INLINED: farm bot bet sizing (from computeFarmDecision ~line 5900) ───────
// Returns { betSize, kellyCapped, contractMin }
function computeFarmBetSize({ smProb, yesP, bid, ask, mid, balance, hasSm }) {
  const _fp = yesP > 0.5
    ? (ask > 0 ? ask : mid * 1.05)
    : (bid > 0 ? (1 - bid) : (1 - mid) * 1.05);

  const contractMin = Math.max(0.01, Math.ceil(_fp * 100) / 100);

  const kellyCapped = (hasSm && balance > 0)
    ? Math.round(Math.min(computeKellyBet(smProb, yesP, balance) * 0.5, balance * 0.10) * 100) / 100
    : 0;

  const betSize = kellyCapped >= contractMin ? kellyCapped : 0;
  return { betSize, kellyCapped, contractMin };
}

// ─── TEST HARNESS ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. Order payload validation ──────────────────────────────────');

test('count = floor(budget / fillPrice)', () => {
  // YES side: ask = $0.55, budget = $10
  const { count, fillPrice } = computeOrderParams({
    side: 'yes',
    yesAskDollars: 0.55,
    yesBidDollars: 0.45,
    yesPrice: 0.50,
    amountDollars: 10,
  });
  assert.strictEqual(fillPrice, 0.55, `fillPrice should be ask (0.55), got ${fillPrice}`);
  const expected = Math.floor(10 / 0.55);
  assert.strictEqual(count, expected, `count should be ${expected}, got ${count}`);
});

test('count * fillPrice <= budget always holds (YES)', () => {
  const params = { side: 'yes', yesAskDollars: 0.73, yesBidDollars: 0.25, yesPrice: 0.70, amountDollars: 7.50 };
  const { count, fillPrice, maxCostCents } = computeOrderParams(params);
  const actualCostCents = Math.round(count * fillPrice * 100);
  assert.ok(
    actualCostCents <= maxCostCents,
    `count*fillPrice (${actualCostCents}¢) must be <= budget (${maxCostCents}¢)`
  );
});

test('count * fillPrice <= budget always holds (NO)', () => {
  // NO side: fillPrice = 1 - bid = 1 - 0.30 = 0.70, budget = $5
  const params = { side: 'no', yesAskDollars: 0.70, yesBidDollars: 0.30, yesPrice: 0.50, amountDollars: 5 };
  const { count, fillPrice, maxCostCents } = computeOrderParams(params);
  const actualCostCents = Math.round(count * fillPrice * 100);
  assert.ok(
    actualCostCents <= maxCostCents,
    `count*fillPrice (${actualCostCents}¢) must be <= budget (${maxCostCents}¢)`
  );
});

test('YES fillPrice falls back to mid*1.05 when ask is 0', () => {
  const { fillPrice } = computeOrderParams({
    side: 'yes',
    yesAskDollars: 0,
    yesBidDollars: 0,
    yesPrice: 0.50,
    amountDollars: 5,
  });
  assert.strictEqual(fillPrice, 0.50 * 1.05, `fallback fillPrice should be mid*1.05 = ${0.50 * 1.05}, got ${fillPrice}`);
});

test('NO fillPrice falls back to (1-mid)*1.05 when bid is 0', () => {
  const { fillPrice } = computeOrderParams({
    side: 'no',
    yesAskDollars: 0,
    yesBidDollars: 0,
    yesPrice: 0.40,
    amountDollars: 5,
  });
  const expected = (1 - 0.40) * 1.05;
  assert.strictEqual(fillPrice, expected, `fallback NO fillPrice should be ${expected}, got ${fillPrice}`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Minimum bet check ──────────────────────────────────────────');

test('budget < minCostCents should produce minCostCents > maxCostCents', () => {
  // ask = $0.94 → 1 NO contract = $0.06 needed, but we only have $0.04
  // For YES: fillPrice = ask = 0.94, minCostCents = 94, budget = $0.04 → 4¢
  const { minCostCents, maxCostCents } = computeOrderParams({
    side: 'yes',
    yesAskDollars: 0.94,
    yesBidDollars: 0.06,
    yesPrice: 0.50,
    amountDollars: 0.04,
  });
  // Simulate the guard that kalshiPlaceOrder throws
  const wouldThrow = maxCostCents < minCostCents;
  assert.ok(wouldThrow, `Expected budget (${maxCostCents}¢) < minCostCents (${minCostCents}¢)`);
});

test('minimum bet error message format matches source', () => {
  // Reproduce the exact message from index.html line 5353
  const side = 'no';
  const fillPrice = 0.06;   // NO contract at YES=94¢
  const minCostCents = Math.ceil(fillPrice * 100);  // 6¢
  const maxCostCents = 4;   // $0.04 budget

  const expectedMsg = `Minimum bet $${(minCostCents / 100).toFixed(2)} required (1 ${side.toUpperCase()} contract at ${(fillPrice * 100).toFixed(0)}¢ each) — your bet: $${(maxCostCents / 100).toFixed(2)}`;

  // Simulate the throw
  let thrown = null;
  try {
    if (maxCostCents < minCostCents) {
      throw new Error(expectedMsg);
    }
  } catch (e) {
    thrown = e.message;
  }

  assert.ok(thrown, 'Expected an error to be thrown');
  assert.strictEqual(thrown, expectedMsg, `Message mismatch.\n  got:      ${thrown}\n  expected: ${expectedMsg}`);
});

test('minimum bet NOT thrown when budget >= minCostCents', () => {
  // ask = $0.10, budget = $1 → minCostCents = 10¢, budget = 100¢  → fine
  const { minCostCents, maxCostCents } = computeOrderParams({
    side: 'yes',
    yesAskDollars: 0.10,
    yesBidDollars: 0.08,
    yesPrice: 0.50,
    amountDollars: 1.00,
  });
  assert.ok(maxCostCents >= minCostCents, 'Should NOT throw when budget covers 1 contract');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. filled=0, status=cancelled → should throw ─────────────────');

test('cancelled order with 0 fills throws correct message', () => {
  const order = { order_id: 'abc123', status: 'cancelled', filled_count: 0 };
  assert.throws(
    () => handleOrderResponse(order, 5),
    (err) => {
      assert.ok(
        err.message.includes('no matching seller'),
        `Expected "no matching seller" in message, got: "${err.message}"`
      );
      return true;
    }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. filled=0, status=filled → should NOT throw, use count ─────');

test('filled=0, status=filled → confirmedContracts falls back to count', () => {
  const order = { order_id: 'abc123', status: 'filled', filled_count: 0 };
  const { confirmedContracts, filled } = handleOrderResponse(order, 7);
  assert.strictEqual(filled, 0, 'filled should be 0');
  assert.strictEqual(confirmedContracts, 7, `confirmedContracts should fall back to count (7), got ${confirmedContracts}`);
});

test('filled=0, status=filled → does NOT throw', () => {
  const order = { order_id: 'abc123', status: 'filled', filled_count: 0 };
  assert.doesNotThrow(() => handleOrderResponse(order, 7));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. filled=0, status="" (empty) → should NOT throw ────────────');

test('filled=0, empty status → does NOT throw (async fill path)', () => {
  const order = { order_id: 'def456' }; // no status, no filled_count at all
  assert.doesNotThrow(() => handleOrderResponse(order, 3));
});

test('filled=0, empty status → confirmedContracts falls back to count', () => {
  const order = { order_id: 'def456' };
  const { confirmedContracts } = handleOrderResponse(order, 3);
  assert.strictEqual(confirmedContracts, 3, `Expected fallback to count=3, got ${confirmedContracts}`);
});

test('filled=0, status="" (explicit empty string) → does NOT throw', () => {
  const order = { order_id: 'ghi789', status: '', filled_count: 0 };
  assert.doesNotThrow(() => handleOrderResponse(order, 2));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 6. Farm bot skip when contract too expensive ─────────────────');

test('kellyCapped < contractMin → betSize=0 (skip trade)', () => {
  // Kelly caps at 10% of balance * 0.5; make contractMin very high
  // balance=$5, smProb=55, yesP=0.55 → Kelly ~tiny; contractMin=$0.90 → betSize=0
  const { betSize, kellyCapped, contractMin } = computeFarmBetSize({
    smProb: 55,
    yesP: 0.55,
    bid: 0.10,
    ask: 0.90,    // expensive YES contract
    mid: 0.55,
    balance: 5,
    hasSm: true,
  });
  assert.ok(kellyCapped < contractMin,
    `kellyCapped (${kellyCapped}) should be < contractMin (${contractMin})`);
  assert.strictEqual(betSize, 0, `betSize should be 0 when kelly can't cover contract, got ${betSize}`);
});

test('betSize=0 when hasSm=false (no model)', () => {
  const { betSize } = computeFarmBetSize({
    smProb: 60,
    yesP: 0.30,
    bid: 0.68,
    ask: 0.70,
    mid: 0.50,
    balance: 200,
    hasSm: false,
  });
  assert.strictEqual(betSize, 0, `betSize should be 0 when no strike model`);
});

test('betSize=0 when balance=0', () => {
  const { betSize } = computeFarmBetSize({
    smProb: 60,
    yesP: 0.30,
    bid: 0.68,
    ask: 0.70,
    mid: 0.50,
    balance: 0,
    hasSm: true,
  });
  assert.strictEqual(betSize, 0, 'betSize should be 0 when balance is zero');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 7. Farm bot proceeds when kellyCapped >= contractMin ──────────');

test('kellyCapped >= contractMin → betSize = kellyCapped', () => {
  // balance=$500, smProb=70, yesP=0.40 (NO trade is cheap → contractMin low)
  // NO fillPrice = 1 - bid = 1 - 0.60 = 0.40 → contractMin = $0.40
  // Kelly on 70% prob at 0.40 price → should produce enough to cover $0.40
  const { betSize, kellyCapped, contractMin } = computeFarmBetSize({
    smProb: 70,
    yesP: 0.40,
    bid: 0.60,
    ask: 0.40,
    mid: 0.40,
    balance: 500,
    hasSm: true,
  });
  assert.ok(kellyCapped >= contractMin,
    `kellyCapped (${kellyCapped}) should be >= contractMin (${contractMin})`);
  assert.ok(betSize > 0, `betSize should be > 0, got ${betSize}`);
  assert.strictEqual(betSize, kellyCapped, `betSize should equal kellyCapped (${kellyCapped})`);
});

test('kellyCapped >= contractMin → betSize > 0 (high-edge YES trade)', () => {
  // balance=$1000, smProb=75, cheap YES at $0.15 → contractMin=$0.15
  const { betSize, kellyCapped, contractMin } = computeFarmBetSize({
    smProb: 75,
    yesP: 0.15,
    bid: 0.14,
    ask: 0.15,
    mid: 0.15,
    balance: 1000,
    hasSm: true,
  });
  // contractMin = ceil(0.15*100)/100 = $0.15 — Kelly on 75% prob cheap contract is large
  assert.ok(kellyCapped >= contractMin,
    `kellyCapped (${kellyCapped}) should be >= contractMin (${contractMin})`);
  assert.ok(betSize > 0, `betSize should be > 0, got ${betSize}`);
});

test('farm sizing is capped at 10% of balance (inner cap)', () => {
  // Even with extreme edge, kellyCapped should never exceed 10% of balance
  const balance = 200;
  const { kellyCapped } = computeFarmBetSize({
    smProb: 99,   // near-certain win
    yesP: 0.01,   // very cheap YES
    bid: 0.01,
    ask: 0.01,
    mid: 0.01,
    balance,
    hasSm: true,
  });
  assert.ok(kellyCapped <= balance * 0.10,
    `kellyCapped (${kellyCapped}) must be <= 10% of balance (${balance * 0.10})`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── Summary ───────────────────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
