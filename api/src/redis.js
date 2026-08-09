import { RedisMemoryServer } from "redis-memory-server";
import Redis from "ioredis";

let redis = null;
let bootPromise = null;

export function connectRedis() {
  if (!bootPromise) {
    bootPromise = (async () => {
      const port = Number(process.env.WAYFINDER_REDIS_PORT || 6379);

      // Reuse an already-running Redis if one is listening on the port.
      const probe = new Redis({
        host: "127.0.0.1",
        port,
        connectTimeout: 600,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      probe.on("error", () => {}); // expected when no server is listening yet
      try {
        await probe.ping();
        await probe.quit();
        redis = new Redis({ host: "127.0.0.1", port, maxRetriesPerRequest: 2 });
        console.log(`[redis] connected to existing server on ${port}`);
        return redis;
      } catch (e) {
        // no server yet: boot an embedded real Redis binary pinned to the port
        // the analysis worker expects.
      }
      const server = new RedisMemoryServer({ instance: { port } });
      await server.getPort(); // resolves once the binary is up
      redis = new Redis({ host: "127.0.0.1", port, maxRetriesPerRequest: 2 });
      redis.on("error", () => {});
      console.log(`[redis] embedded redis up on ${port}`);
      return redis;
    })();
  }
  return bootPromise;
}
