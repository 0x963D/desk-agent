import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createBackend } from "./backend.ts";
import { loadOrders, loadShop } from "./files.ts";
import { CallOutput, ToolName } from "./shapes.ts";
import { contracts, type ToolOutput, type ToolResult, type Tools } from "./tools.ts";

export const toolDefinitions: Tool[] = ToolName.options.map((name) => ({
  name,
  description: contracts[name].description,
  inputSchema: z.toJSONSchema(contracts[name].input, { io: "input" }) as Tool["inputSchema"],
}));

const reply = (result: ToolResult<unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
  isError: !result.ok,
});

export function shopServer(backend: Tools): Server {
  const server = new Server({ name: "studio-cobalt", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: toolDefinitions }));
  server.setRequestHandler("tools/call", async ({ params }) => {
    const name = ToolName.safeParse(params.name);
    if (!name.success) {
      return reply({
        ok: false,
        error: { code: "invalid_input", message: `No function is named ${params.name}. Functions: ${ToolName.options.join(", ")}.` },
      });
    }
    return reply(await backend.call(name.data, params.arguments));
  });
  return server;
}

export function remoteTools(client: Client): Tools {
  return {
    async call<K extends ToolName>(name: K, input: unknown) {
      const answer = await client.callTool({ name, arguments: input as Record<string, unknown> });
      const output = CallOutput.parse(answer.structuredContent);
      if (!output.ok) return output;
      return { ok: true, data: contracts[name].output.parse(output.data) as ToolOutput<K> };
    },
  };
}

export async function connectInMemory(backend: Tools): Promise<{ tools: Tools; close(): Promise<void> }> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const server = shopServer(backend);
  const client = new Client({ name: "desk-agent-runner", version: "1.0.0" });
  await server.connect(serverEnd);
  await client.connect(clientEnd);
  return {
    tools: remoteTools(client),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

if (import.meta.main) {
  const root = process.cwd();
  const shop = await loadShop(root);
  const orders = await loadOrders(root, "tuning", shop);
  serveStdio(() => shopServer(createBackend({ shop, orders })));
  console.error(`The five Studio Cobalt functions are on stdio, over the ${orders.length} tuning orders.`);
}
