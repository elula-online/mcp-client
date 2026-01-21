// types.d.ts - Add this to your project root

declare module "agents" {
  export class Agent<TEnv = any, TState = any> {
    env: TEnv;
    name: string;
    mcp: {
      listServers(): Promise<Array<{ id: string; name: string; state: string }>>;
      getAITools(): Promise<Record<string, any>>;
      removeServer(id: string): Promise<void>;
    };
    
    addMcpServer(
      name: string,
      url: string,
      host: string,
      config?: any,
      options?: any
    ): Promise<{ id: string; state: string; authUrl?: string }>;
    
    onStart(): Promise<void>;
    onRequest(request: Request): Promise<Response>;
    fetch(request: Request): Promise<Response>;
  }

  export type AgentNamespace<T extends Agent> = any;
  
  export function routeAgentRequest(
    request: Request,
    env: any
  ): Promise<Response | null>;
  
  export function getAgentByName<T extends Agent>(
    namespace: AgentNamespace<T>,
    name: string
  ): Promise<T>;
}