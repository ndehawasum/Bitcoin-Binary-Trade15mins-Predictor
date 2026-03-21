/**
 * unit.test.js
 * Pure-function unit tests for the Kalshi P&L / Kelly sizing engine.
 * No external test framework — uses Node's built-in `assert` module.
 * Run: node tests/unit.test.js
 * Exit code 0 = all tests passed, 1 = at least one failure.
 */

'use strict';

const assert = require('assert');

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE — copied verbatim from index.html (search anchors preserved below)
// ─────────────────────────────────────────────────────────────────────────────

// RISK_MAX_ACCT_PCT constant (index.html line ~1332)
const RISK_MAX_ACCT_PCT = 0.20;

// function computeKellyBet (index.html line ~3510)
function computeKellyBet(prob, yesPrice, balance) {
  // Kelly: f* = (b*p - q) / b  where b = (1-price)/price (odds)
  // For binary: b = (1.00 - yesPrice)/yesPrice
  const p = Math.max(0.01, Math.min(0.99, prob / 100));
  const q = 1 - p;
  const b = (1.00 - yesPrice) / Math.max(0.01, yesPrice);
  const kelly = (b * p - q) / b;
  const halfKelly = Math.max(0, kelly * 0.5); // use half-kelly for safety
  // Cap at RISK_MAX_ACCT_PCT of account
  return Math.min(halfKelly * balance, RISK_MAX_ACCT_PCT * balance);
}

// function kalshiContracts (index.html line ~2640)
function kalshiContracts(amount, yesPrice, bet = 'UP') {
  // UP bet  → buying YES contracts, each costs yesPrice
  // DOWN bet → buying NO contracts, each costs (1 - yesPrice)
  const contractPrice = bet === 'DOWN' ? Math.max(0.01, 1 - yesPrice) : Math.max(0.01, yesPrice);
  return amount / contractPrice;
}

// function kalshiMaxPayout (index.html line ~2678)
function kalshiMaxPayout(contracts) {
  return contracts * 1.00;
}

// function kalshiPotentialProfit (index.html line ~2681)
function kalshiPotentialProfit(amount, yesPrice, bet = 'UP') {
  const contracts = kalshiContracts(amount, yesPrice, bet);
  return kalshiMaxPayout(contracts) - amount;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * @param {string} name  — human-readable test description
 * @param {Function} fn  — test body; throw or use assert to signal failure
 */
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

/** Floating-point equality within a tolerance. */
function assertNear(actual, expected, tol = 1e-9, msg = '') {
  const diff = Math.abs(actual - expected);
  if (diff > tol) {
    throw new Error(
      `${msg ? msg + ' — ' : ''}expected ~${expected}, got ${actual} (diff=${diff})`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computeKellyBet tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── computeKellyBet ─────────────────────────────────────────────');

test('zero probability → 0 bet (prob=0 clamps to 0.01, kelly negative → halfKelly=0)', () => {
  // p clamped to 0.01, q=0.99, b=(0.5/0.5)=1 → kelly=(1*0.01-0.99)/1 = -0.98 → halfKelly=0
  const result = computeKellyBet(0, 0.5, 200);
  assert.strictEqual(result, 0, `Expected 0, got ${result}`);
});

test('100% probability → capped at RISK_MAX_ACCT_PCT (prob=100 clamps to 0.99)', () => {
  // p=0.99, q=0.01, b=(0.5/0.5)=1 → kelly=(0.99-0.01)/1=0.98 → halfKelly=0.49
  // halfKelly*200 = 98, cap = 0.20*200 = 40 → result = 40
  const balance = 200;
  const result = computeKellyBet(100, 0.5, balance);
  assertNear(result, RISK_MAX_ACCT_PCT * balance, 1e-9, '100% prob should be capped');
});

test('normal 60% probability at yesPrice=0.50 → positive, capped correctly', () => {
  // p=0.60, q=0.40, b=1 → kelly=(0.60-0.40)/1=0.20 → halfKelly=0.10
  // halfKelly*200=20, cap=0.20*200=40 → result=20
  const result = computeKellyBet(60, 0.5, 200);
  assertNear(result, 20, 1e-9, '60% prob normal kelly');
});

test('negative kelly when prob < implied probability → returns 0', () => {
  // yesPrice=0.70, b=(0.30/0.70)≈0.4286, p=0.40, q=0.60
  // kelly=(0.4286*0.40-0.60)/0.4286 = (0.1714-0.60)/0.4286 = -0.428.../0.4286 < 0
  const result = computeKellyBet(40, 0.70, 1000);
  assert.strictEqual(result, 0, `Negative kelly should return 0, got ${result}`);
});

test('balance cap: large halfKelly*balance exceeds RISK_MAX_ACCT_PCT*balance', () => {
  // prob=95 → p=0.95, yesPrice=0.10 → b=0.90/0.10=9
  // kelly=(9*0.95-0.05)/9=(8.55-0.05)/9=8.50/9≈0.9444
  // halfKelly≈0.4722, halfKelly*balance=472.2, cap=0.20*1000=200 → result=200
  const result = computeKellyBet(95, 0.10, 1000);
  assertNear(result, RISK_MAX_ACCT_PCT * 1000, 1e-6, 'Should be capped at 20% of balance');
});

test('zero balance → bet is always 0', () => {
  const result = computeKellyBet(70, 0.4, 0);
  assert.strictEqual(result, 0, `Zero balance should produce zero bet, got ${result}`);
});

test('exactly 50% prob at fair price (0.50) → 0 bet (kelly=0)', () => {
  // p=0.50, q=0.50, b=1 → kelly=(1*0.50-0.50)/1=0 → halfKelly=0 → bet=0
  const result = computeKellyBet(50, 0.5, 500);
  assert.strictEqual(result, 0, `Fair odds at 50% prob → no edge → 0 bet, got ${result}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// kalshiContracts tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── kalshiContracts ─────────────────────────────────────────────');

test('UP bet: amount/yesPrice when yesPrice=0.50 → 2 contracts per $1', () => {
  const result = kalshiContracts(10, 0.5, 'UP');
  assertNear(result, 20, 1e-9, 'UP bet at 0.50 should yield 20 contracts for $10');
});

test('DOWN bet: amount/(1-yesPrice) when yesPrice=0.40 → price=0.60', () => {
  // contractPrice = 1 - 0.40 = 0.60 → contracts = 30/0.60 = 50
  const result = kalshiContracts(30, 0.40, 'DOWN');
  assertNear(result, 50, 1e-9, 'DOWN bet at yesPrice=0.40 (noPrice=0.60) → 50 contracts for $30');
});

test('default bet is UP when omitted', () => {
  const explicit = kalshiContracts(10, 0.5, 'UP');
  const defaulted = kalshiContracts(10, 0.5);
  assert.strictEqual(explicit, defaulted, 'Default bet=UP should equal explicit UP');
});

test('zero amount → 0 contracts', () => {
  const result = kalshiContracts(0, 0.5, 'UP');
  assert.strictEqual(result, 0, `Zero amount → 0 contracts, got ${result}`);
});

test('large amount: $10,000 UP at yesPrice=0.25 → 40,000 contracts', () => {
  const result = kalshiContracts(10000, 0.25, 'UP');
  assertNear(result, 40000, 1e-9, 'Large UP bet at 0.25 should yield 40,000 contracts');
});

test('DOWN bet yesPrice=0.99 → noPrice clamped; contracts = amount/0.01', () => {
  // 1-0.99=0.01, Math.max(0.01, 0.01)=0.01 → 5/0.01=500
  const result = kalshiContracts(5, 0.99, 'DOWN');
  assertNear(result, 500, 1e-9, 'DOWN at yesPrice=0.99 → noPrice=0.01 (floor) → 500 contracts');
});

test('UP bet yesPrice=0 → floor to 0.01; contracts = amount/0.01', () => {
  // Math.max(0.01, 0) = 0.01 → 5/0.01 = 500
  const result = kalshiContracts(5, 0, 'UP');
  assertNear(result, 500, 1e-9, 'UP at yesPrice=0 → floor 0.01 → 500 contracts');
});

// ─────────────────────────────────────────────────────────────────────────────
// kalshiMaxPayout tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── kalshiMaxPayout ─────────────────────────────────────────────');

test('payout equals number of contracts (each pays $1.00)', () => {
  assertNear(kalshiMaxPayout(100), 100, 1e-9);
  assertNear(kalshiMaxPayout(0), 0, 1e-9);
  assertNear(kalshiMaxPayout(3.7), 3.7, 1e-9);
});

test('payout for fractional contracts rounds correctly', () => {
  assertNear(kalshiMaxPayout(12.5), 12.5, 1e-9, 'Fractional contracts pay fractional dollars');
});

test('large contract count scales linearly', () => {
  assertNear(kalshiMaxPayout(1_000_000), 1_000_000, 1e-9, 'One million contracts = $1M payout');
});

// ─────────────────────────────────────────────────────────────────────────────
// kalshiPotentialProfit tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── kalshiPotentialProfit ───────────────────────────────────────');

test('UP profit at yesPrice=0.50: $10 in → payout $20 → profit $10', () => {
  // contracts = 10/0.50 = 20, payout = 20, profit = 20-10 = 10
  assertNear(kalshiPotentialProfit(10, 0.5, 'UP'), 10, 1e-9);
});

test('UP profit at yesPrice=0.25: $5 in → payout $20 → profit $15', () => {
  // contracts = 5/0.25 = 20, payout = 20, profit = 20-5 = 15
  assertNear(kalshiPotentialProfit(5, 0.25, 'UP'), 15, 1e-9);
});

test('DOWN profit at yesPrice=0.60: noPrice=0.40, $4 in → payout $10 → profit $6', () => {
  // contracts = 4/0.40 = 10, payout = 10, profit = 10-4 = 6
  assertNear(kalshiPotentialProfit(4, 0.60, 'DOWN'), 6, 1e-9);
});

test('zero amount → zero profit', () => {
  assertNear(kalshiPotentialProfit(0, 0.5, 'UP'), 0, 1e-9);
});

test('yesPrice=0.01 (near-certain UP): $1 in → ~$99 profit', () => {
  // contracts = 1/0.01 = 100, payout = 100, profit = 99
  assertNear(kalshiPotentialProfit(1, 0.01, 'UP'), 99, 1e-9);
});

test('profit is always non-negative for valid prices (0 < yesPrice < 1)', () => {
  const prices = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95];
  for (const p of prices) {
    const profit = kalshiPotentialProfit(10, p, 'UP');
    assert.ok(profit >= 0, `Profit at yesPrice=${p} should be >= 0, got ${profit}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract price floor logic: Math.max(contractMin, kelly) scenarios
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── contractMin floor logic (Math.max(contractMin, kelly)) ──────');

test('kelly >= contractMin → kelly value wins', () => {
  // kelly=50, contractMin=0.05 → Math.max(0.05, 50)=50
  const kelly = 50;
  const contractMin = 0.05;
  assert.strictEqual(Math.max(contractMin, kelly), kelly);
});

test('kelly < contractMin → contractMin wins', () => {
  // kelly=0.03, contractMin=0.05 → Math.max(0.05, 0.03)=0.05
  const kelly = 0.03;
  const contractMin = 0.05;
  assert.strictEqual(Math.max(contractMin, kelly), contractMin);
});

test('kelly === 0 (negative kelly clamped) → contractMin always wins', () => {
  const kelly = 0;
  const contractMin = 0.05;
  assert.strictEqual(Math.max(contractMin, kelly), contractMin);
});

test('when betSize < contractMin the bot should skip: betSize = kelly<contractMin ? 0 : kelly', () => {
  // Simulates index.html line ~5917: betSize = kellyCapped >= contractMin ? kellyCapped : 0
  function betSize(kellyCapped, contractMin) {
    return kellyCapped >= contractMin ? kellyCapped : 0;
  }
  assert.strictEqual(betSize(0.03, 0.05), 0,  'Under-minimum kelly → skip (0)');
  assert.strictEqual(betSize(0.05, 0.05), 0.05, 'Exactly at min → place bet');
  assert.strictEqual(betSize(1.00, 0.05), 1.00, 'Above min → place bet');
  assert.strictEqual(betSize(0, 0.05), 0,       'Zero kelly → skip');
});

test('contractMin calculation: Math.max(0.01, Math.ceil(fillPrice*100)/100)', () => {
  // Simulates index.html line ~5910
  function computeContractMin(fillPrice) {
    return Math.max(0.01, Math.ceil(fillPrice * 100) / 100);
  }
  assertNear(computeContractMin(0.50), 0.50, 1e-9,  'Clean price passes through');
  assertNear(computeContractMin(0.501), 0.51, 1e-9, 'Fractional rounds up');
  assertNear(computeContractMin(0.001), 0.01, 1e-9, 'Sub-penny floors to $0.01');
  assertNear(computeContractMin(0),     0.01, 1e-9, 'Zero price floors to $0.01');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
