import { client } from "./api.ts";
import { sampled } from "./connection.ts";

/** ping times one round trip to the server; a failed one is simply not a sample (the offline note says why). */
export async function ping(): Promise<void> {
  const start = performance.now();
  try {
    const { response } = await client.GET("/api/ping", { cache: "no-store" });
    if (response.ok) sampled(Math.round(performance.now() - start));
  } catch {
    /* no answer: no sample */
  }
}
