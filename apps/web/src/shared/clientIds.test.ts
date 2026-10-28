import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIdHeaders, randomId, tabIdFrom } from "@convoz/api-client";

const ID = /^[0-9a-f]{8}$/;

/** A sessionStorage stand-in: a Map, or one whose every call throws. */
function storage(throws = false): Storage {
  const m = new Map<string, string>();
  const fail = () => {
    throw new DOMException("refused", "SecurityError");
  };
  return {
    getItem: (k: string) => (throws ? fail() : (m.get(k) ?? null)),
    setItem: (k: string, v: string) => (throws ? fail() : void m.set(k, v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

test("a random id is 8 lowercase hex digits", () => {
  for (let i = 0; i < 50; i++) assert.match(randomId(), ID);
});

test("the tab id is kept in sessionStorage, so a reload reads the same one", () => {
  const s = storage();
  const first = tabIdFrom(() => s);
  assert.match(first, ID);
  assert.equal(tabIdFrom(() => s), first);
});

test("a stored tab id of the wrong shape is replaced", () => {
  const s = storage();
  s.setItem("convoz.tab", "NOT-AN-ID");
  const id = tabIdFrom(() => s);
  assert.match(id, ID);
  assert.equal(s.getItem("convoz.tab"), id);
});

test("a refused sessionStorage still gives a tab id, in memory", () => {
  assert.match(tabIdFrom(() => storage(true)), ID);
  assert.match(
    tabIdFrom(() => {
      throw new DOMException("no storage here", "SecurityError");
    }),
    ID,
  );
});

test("one page load sends one tab id and one load id on every call", () => {
  const a = clientIdHeaders();
  assert.match(a["X-Convoz-Tab"], ID);
  assert.match(a["X-Convoz-Load"], ID);
  assert.deepEqual(clientIdHeaders(), a);
});
