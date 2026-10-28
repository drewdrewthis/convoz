import assert from "node:assert/strict";
import { test } from "node:test";
import { debouncePer } from "@convoz/api-client";

test("debouncePer runs once, ms after the last call of a short burst", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let runs = 0;
  const call = debouncePer(() => void runs++, 200);
  call(1);
  t.mock.timers.tick(100);
  call(1);
  t.mock.timers.tick(199);
  assert.equal(runs, 0);
  t.mock.timers.tick(1);
  assert.equal(runs, 1);
});

test("debouncePer runs about every maxWait while calls keep coming every 100 ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const at: number[] = [];
  const start = Date.now();
  const call = debouncePer(() => void at.push(Date.now() - start), 200, 1000);
  for (let i = 0; i < 30; i++) {
    call(1);
    t.mock.timers.tick(100);
  }
  assert.deepEqual(at, [1000, 2000, 3000]);
});

test("debouncePer runs each key on its own timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ran: number[] = [];
  const call = debouncePer((k: number) => void ran.push(k), 200, 1000);
  for (let i = 0; i < 5; i++) {
    call(1);
    t.mock.timers.tick(100);
  }
  call(2);
  t.mock.timers.tick(200);
  assert.deepEqual(ran, [1, 2]);
});
