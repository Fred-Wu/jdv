import { assert, assertEquals } from "./assert.ts";
import { createArrowPageCache } from "../web/arrow_page_cache.js";

const scope = { session: "r-session", view: "v-1", generation: 1 };

Deno.test("Arrow IPC page cache copies payloads and obeys byte and page limits", () => {
  const cache = createArrowPageCache(6, 2);
  const first = new Uint8Array([1, 2, 3]).buffer;
  assert(cache.set("a", first, { page: 0 }, scope));
  new Uint8Array(first)[0] = 9;
  assertEquals([...new Uint8Array(cache.get("a")!.payload)], [1, 2, 3]);
  cache.set("b", new Uint8Array([4, 5, 6]).buffer, { page: 1 }, scope);
  cache.get("a");
  cache.set("c", new Uint8Array([7, 8, 9]).buffer, { page: 2 }, scope);
  assertEquals(cache.keys(), ["a", "c"]);
  assertEquals(cache.bytes, 6);
  assertEquals(cache.size, 2);
});

Deno.test("Arrow IPC page cache evicts oversized entries without retaining them", () => {
  const cache = createArrowPageCache(4, 2);
  assertEquals(
    cache.set("large", new Uint8Array([1, 2, 3, 4, 5]).buffer, {
      page: 0,
    }, scope),
    false,
  );
  assertEquals(cache.get("large"), null);
  assertEquals(cache.bytes, 0);
});

Deno.test("Arrow IPC page cache copies only a typed-array view's payload range", () => {
  const cache = createArrowPageCache(4, 2);
  const backing = new Uint8Array([99, 1, 2, 3, 88]);
  assert(cache.set("slice", backing.subarray(1, 4), { page: 0 }, scope));
  assertEquals(cache.bytes, 3);
  assertEquals(
    [...new Uint8Array(cache.get("slice")!.payload)],
    [1, 2, 3],
  );
});

Deno.test("Arrow IPC page cache releases every generation when a view closes", () => {
  const cache = createArrowPageCache(16, 4);
  cache.set("one", new Uint8Array([1]).buffer, { page: 0 }, scope);
  cache.set("two", new Uint8Array([2]).buffer, { page: 0 }, {
    ...scope,
    generation: 2,
  });
  cache.set("other", new Uint8Array([3]).buffer, { page: 0 }, {
    ...scope,
    view: "v-2",
  });
  cache.deleteView(scope.session, scope.view);
  assertEquals(cache.keys(), ["other"]);
  assertEquals(cache.bytes, 1);
  cache.clear();
  assertEquals(cache.size, 0);
  assertEquals(cache.bytes, 0);
});
