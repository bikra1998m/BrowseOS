"use strict";

const assert = require("assert");
const { create } = require("../public/save-coordinator.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

(async () => {
  let captures = 0;
  let persists = 0;
  const stateReady = deferred();
  const coordinator = create({
    capture() { captures++; return stateReady.promise; },
    async persist(state) {
      persists++;
      assert.equal(state, "state-1");
    },
  });

  const auto = coordinator.save("auto");
  const manual = coordinator.save("manual");
  const exportCapture = coordinator.capture();
  await Promise.resolve();
  assert.equal(captures, 1, "concurrent callers must share one capture");
  stateReady.resolve("state-1");
  assert.deepEqual(await exportCapture, "state-1");
  await Promise.all([auto, manual]);
  assert.equal(persists, 1, "concurrent saves must share one persistence pass");
  await coordinator.idle();
  assert.equal(coordinator.status().saving, false);

  let clock = 1000;
  let timer = null;
  let lifecycleCaptures = 0;
  const scheduled = create({
    now: () => clock,
    intervalMs: 500,
    lifecycleMinAgeMs: 200,
    setTimer(fn, delay) { timer = { fn, delay }; return timer; },
    clearTimer() { timer = null; },
    capture() { lifecycleCaptures++; return new ArrayBuffer(1); },
    persist() {},
  });

  scheduled.start();
  assert.equal(timer.delay, 500);
  clock += 100;
  assert.equal((await scheduled.lifecycle()).skipped, true);
  assert.equal(lifecycleCaptures, 0);

  clock += 150;
  await scheduled.lifecycle();
  assert.equal(lifecycleCaptures, 1);

  await timer.fn();
  assert.equal(lifecycleCaptures, 2);
  assert.equal(timer.delay, 500, "autosave should reschedule only after completion");

  scheduled.stop();
  assert.equal(timer, null);

  console.log("save coordinator checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
