import { fetchWithRetry } from "../_shared/graph.ts";
import { assertEquals, fakeFetch } from "./helpers.ts";

Deno.test("fetchWithRetry backs off exponentially: 500 ms, then 1000 ms", async () => {
  const delays: number[] = [];
  const { fetchFn, calls } = fakeFetch([
    new Response("a", { status: 502 }),
    new Response("b", { status: 429 }),
    new Response("ok", { status: 200 }),
  ]);
  const res = await fetchWithRetry("https://example.test/", {}, {
    fetchFn,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls.length, 3);
  assertEquals(delays, [500, 1000]);
});

Deno.test("fetchWithRetry returns the last 5xx response after the final attempt", async () => {
  const { fetchFn, calls } = fakeFetch([
    new Response("a", { status: 500 }),
    new Response("b", { status: 500 }),
    new Response("c", { status: 500 }),
  ]);
  const res = await fetchWithRetry("https://example.test/", {}, { fetchFn, sleep: () => Promise.resolve() });
  assertEquals(res.status, 500);
  await res.body?.cancel();
  assertEquals(calls.length, 3);
});
