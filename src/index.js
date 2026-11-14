import { maintenance } from "./modules/notifications.js";
import { dashboardRoute } from "./dashboard/routes.js";
import { json, secureResponse, safeError } from "./utils/helpers.js";
import { interactionRoute } from "./discord/interactions.js";
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(maintenance(env));
  },
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1 AS ok").first();
        return secureResponse(json({ ok: true, service: "RoApp" }));
      }
      if (path === "/api/discord/interactions" && request.method === "POST")
        return secureResponse(await interactionRoute(request, env, ctx));
      if (path.startsWith("/auth/") || path.startsWith("/api/"))
        return secureResponse(await dashboardRoute(request, env));
      return secureResponse(await env.ASSETS.fetch(request));
    } catch (e) {
      return secureResponse(safeError(e));
    }
  },
};
