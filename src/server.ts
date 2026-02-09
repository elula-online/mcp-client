import { routeAgentRequest, getAgentByName } from "agents";
import type { Env } from "./types";
import { MyAgent } from "./agent";

export { MyAgent };

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) return agentResponse;

    const agent = await getAgentByName(env.MyAgent, "default");

    return agent.fetch(request);
  },
} satisfies ExportedHandler<Env>;
