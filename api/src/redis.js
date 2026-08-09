import Redis from "ioredis";

let redis = null;
let bootPromise = null;

const REDIS_HOST = process.env.WAYFINDER_REDIS_HOST || "127.0.0.1";
const REDIS_PORT = Number(process.env.WAYFINDER_REDIS_PORT || 6379);
const REDIS_PASSWORD = process.env.WAYFINDER_REDIS_PASSWORD || undefined;

let RedisMemoryServer = null;

async function getRedisMemoryServer() {
  if (!RedisMemoryServer) {
    ({ RedisMemoryServer } = await import("redis-memory-server"));
  }
  return RedisMemoryServer;
}

export function connectRedis() {
  if (!bootPromise) {
    bootPromise = (async () => {
      // Remote/managed Redis (e.g. Zerops Valkey) — never boot the embedded
      // binary, and always send the password. Only the local default host
      // gets the dev-friendly probe/embedded fallback.
      if (REDIS_HOST !== "127.0.0.1" && REDIS_HOST !== "localhost") {
        redis = new Redis({
          host: REDIS_HOST,
          port: REDIS_PORT,
          password: REDIS_PASSWORD,
          maxRetriesPerRequest: 2,
        });
        redis.on("error", () => {});
        console.log(`[redis] connected to remote server ${REDIS_HOST}:${REDIS_PORT}`);
        return redis;
      }

      // Reuse an already-running Redis if one is listening on the port.
      const probe = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        connectTimeout: 600,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      probe.on("error", () => {}); // expected when no server is listening yet
      try {
        await probe.ping();
        await probe.quit();
        redis = new Redis({
          host: REDIS_HOST,
          port: REDIS_PORT,
          password: REDIS_PASSWORD,
          maxRetriesPerRequest: 2,
        });
        console.log(`[redis] connected to existing server on ${REDIS_PORT}`);
        return redis;
      } catch (e) {
        // no server yet: boot an embedded real Redis binary pinned to the port
        // the analysis worker expects.
      }
      const MemoryServer = await getRedisMemoryServer();
      const server = new MemoryServer({ instance: { port: REDIS_PORT } });
      await server.getPort(); // resolves once the binary is up
      redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 2 });
      redis.on("error", () => {});
      console.log(`[redis] embedded redis up on ${REDIS_PORT}`);
      return redis;
    })();
  }
  return bootPromise;
}
