const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isComputeStalled } = require('./static/fleet-utils.js');

test('stale age overrides Active/Running and an old earning=true flag', () => {
  for (const computeStatus of ['Active', 'Running']) {
    assert(isComputeStalled({ computeStatus, heartbeatAgeMin: 840, earning: true }));
    for (const heartbeatAgeMin of [0, 30, 45]) {
      assert(!isComputeStalled({ computeStatus, heartbeatAgeMin }));
    }
    assert(isComputeStalled({ computeStatus, heartbeatAgeMin: 46 }));
  }
});

test('unknown heartbeat and inactive nodes do not become stalled', () => {
  assert(!isComputeStalled({ computeStatus: 'Inactive', heartbeatAgeMin: 840 }));
  assert(!isComputeStalled({ computeActive: true, heartbeatAgeMin: null, earning: null }));
  assert(!isComputeStalled({ computeActive: true, heartbeatAgeMin: 840, heartbeatKnown: false }));
});
