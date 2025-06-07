// ==== 时间常量 ====

const FUNNEL_KEY_TTL = 3 * 24 * 60 * 60 + 60; // 3 days + 1 minute
const BLOCK_TIMESTAMPS_WINDOW = 3 * 24 * 60 * 60; // 3 days

// ==== 限流规则 ====

const REQUEST_LIMIT_RULES = [
  { window: 120, limit: 120 }, // 2 minutes, 120 requests, 1 per second
  { window: 300, limit: 180 }, // 5 minutes, 180 requests, 0.6 per second
  { window: 600, limit: 255 }, // 10 minutes, 255 requests, 0.425 per second
  { window: 900, limit: 293 }, // 15 minutes, 293 requests, 0.325 per second
];

// ==== 封禁时长 ====

const BLOCK_DURATIONS = [300, 600, 1800, 3600, 86400]; // 5 minutes, 10 minutes, 30 minutes, 1 hour, 1 day

// ==== Key 构造器 ====

function makeRateLimitKey(ip) {
  return `http://xxcoding.com/${ip}_7`;
}

// ==== 工具函数 ====

function getClientIp(request) {
  return (
    request.headers.get("x-alicdn-security-xff") ||
    request.headers.get("x-forwarded-for") ||
    "unknown-ip"
  );
}

/**
cache data schema:
{
  "requestTimestamps": [1717756800, 1717756801, 1717756802], // 请求时间戳列表，用于频率检查，单位：秒
  "blockedTimestamps": [1717756800, 1717756801, 1717756802], // 封禁时间戳列表，用于封禁检查，单位：秒
  "blockedUntil": 1717756803, // 封禁结束时间戳，用于封禁检查，单位：秒
  "blockedDuration": 300 // 封禁时长，用于封禁检查，单位：秒
}
 */

async function getRateLimitDataFromCache(key) {
  try {
    const resp = await cache.get(key);
    if (!resp) {
      return {
        requestTimestamps: [],
        blockedTimestamps: [],
        blockedUntil: null,
        blockedDuration: null,
      };
    }
    const data = await resp.json();
    return {
      requestTimestamps: Array.isArray(data.requestTimestamps)
        ? data.requestTimestamps
        : [],
      blockedTimestamps: Array.isArray(data.blockedTimestamps)
        ? data.blockedTimestamps
        : [],
      blockedUntil: data.blockedUntil || null,
      blockedDuration: data.blockedDuration || null,
    };
  } catch (_) {
    return {
      requestTimestamps: [],
      blockedTimestamps: [],
      blockedUntil: null,
      blockedDuration: null,
    };
  }
}

async function saveRateLimitDataToCache(key, data, ttl) {
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(data), {
        headers: { "cache-control": `max-age=${ttl}` },
      })
    );
  } catch (_) {}
}

function prune(timestamps, windowSize, now) {
  return timestamps.filter((ts) => ts >= now - windowSize);
}

function getBlockDurationByCount(count) {
  return BLOCK_DURATIONS[Math.min(count - 1, BLOCK_DURATIONS.length - 1)];
}

// ==== 主处理函数 ====

async function handleRequest(request) {
  const ip = getClientIp(request);
  const rateLimitKey = makeRateLimitKey(ip);
  const now = Math.floor(Date.now() / 1000);

  // === 获取限流数据 ===
  let rateLimitData = await getRateLimitDataFromCache(rateLimitKey);

  // === 判断是否在封禁状态 ===
  if (rateLimitData.blockedUntil && now < rateLimitData.blockedUntil) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: [
        //["X-Rate-Limiter-Until", rateLimitData.blockedUntil.toString()],
        //["X-Rate-Limiter-Duration", rateLimitData.blockedDuration.toString()],
        //["X-Rate-Limiter-Debug-Count", rateLimitData.requestTimestamps.length.toString()],
        //["X-Rate-Limiter-Debug-BlockedTimestamps", JSON.stringify(rateLimitData.blockedTimestamps)],
        //["X-Rate-Limiter-Debug-RequestTimestamps", JSON.stringify(rateLimitData.requestTimestamps)]
      ],
    });
  }

  // === 频率检查 ===
  let timestamps = prune(rateLimitData.requestTimestamps, 900, now);

  for (const rule of REQUEST_LIMIT_RULES) {
    if (prune(timestamps, rule.window, now).length >= rule.limit) {
      // block 数据处理
      let blockTimestamps = prune(
        rateLimitData.blockedTimestamps,
        BLOCK_TIMESTAMPS_WINDOW,
        now
      );
      blockTimestamps.push(now);
      blockTimestamps = blockTimestamps.slice(-BLOCK_DURATIONS.length);

      const blockCount = blockTimestamps.length;
      const duration = getBlockDurationByCount(blockCount);

      // 更新数据结构
      rateLimitData.requestTimestamps = timestamps;
      rateLimitData.blockedTimestamps = blockTimestamps;
      rateLimitData.blockedUntil = now + duration;
      rateLimitData.blockedDuration = duration;

      await saveRateLimitDataToCache(rateLimitKey, rateLimitData, FUNNEL_KEY_TTL);

      return new Response("Too Many Requests", {
        status: 429,
        headers: [
          //["X-Rate-Limiter-Until", rateLimitData.blockedUntil.toString()],
          //["X-Rate-Limiter-Duration", rateLimitData.blockedDuration.toString()],
          //["X-Rate-Limiter-Debug-Count", rateLimitData.requestTimestamps.length.toString()],
          //["X-Rate-Limiter-Debug-BlockedTimestamps", JSON.stringify(rateLimitData.blockedTimestamps)],
          //["X-Rate-Limiter-Debug-RequestTimestamps", JSON.stringify(rateLimitData.requestTimestamps)]
        ],
      });
    }
  }

  // === 正常记录请求 ===
  timestamps.push(now);
  rateLimitData.requestTimestamps = timestamps;
  await saveRateLimitDataToCache(rateLimitKey, rateLimitData, FUNNEL_KEY_TTL);

  const response = await fetch(request);
  //response.headers.append("X-Rate-Limiter-Count", timestamps.length.toString());
  //response.headers.append("X-Rate-Limiter-Debug-BlockedTimestamps", JSON.stringify(rateLimitData.blockedTimestamps));
  //response.headers.append("X-Rate-Limiter-Debug-RequestTimestamps", JSON.stringify(rateLimitData.requestTimestamps));
  //response.headers.append("X-Rate-Limiter-Debug-BlockedUtil", rateLimitData.blockedUntil ? rateLimitData.blockedUntil.toString() : "null");
  //response.headers.append("X-Rate-Limiter-Debug-BlockedDuration", rateLimitData.blockedDuration ? rateLimitData.blockedDuration.toString() : "null");

  return response;
}

// ==== 导出 handler ====

export default {
  async fetch(request) {
    return handleRequest(request);
  },
};
