async function authHook(request, reply) {
  // Skip auth for health check, test panel, compare page and CORS preflight requests
  if (
    request.url === "/health" ||
    request.url === "/test" ||
    request.url === "/test.html" ||
    request.url === "/compare" ||
    request.url === "/compare.html" ||
    request.method === "OPTIONS" ||
    request.url.includes("/media/upload/")
  )
    return;

  const apiKey = request.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

module.exports = { authHook };
