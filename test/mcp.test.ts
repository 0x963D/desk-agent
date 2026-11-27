import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, onTestFinished, test } from "vitest";
import { shopServer } from "../src/mcp.ts";
import { ToolName } from "../src/shapes.ts";
import { contracts } from "../src/tools.ts";
import { request, ROOT, testBackend, verified } from "./helpers.ts";

async function connect(options: { outage?: boolean } = {}): Promise<Client> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await shopServer(await testBackend(options)).connect(serverEnd);
  await client.connect(clientEnd);
  onTestFinished(() => client.close());
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

test("the server lists the six functions with their descriptions and object input schemas", async () => {
  const { tools } = await (await connect()).listTools();

  expect(tools.map((tool) => tool.name)).toEqual(ToolName.options);
  for (const tool of tools) {
    expect(tool.description).toBe(contracts[tool.name as ToolName].description);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).not.toEqual([]);
  }
});

test("a lookup returns the order as structured content", async () => {
  const answer = await call(await connect(), "lookup_order", verified("SC-1003"));

  expect(answer.isError).toBe(false);
  expect(answer.structuredContent).toMatchObject({ ok: true, data: { order_id: "SC-1003", status: "shipped" } });
});

test("a policy rejection comes back as a value the model can read", async () => {
  const answer = await call(await connect(), "file_request", request("SC-1005", { kind: "return" }));

  expect(answer.isError).toBe(true);
  expect(answer.structuredContent).toEqual({
    ok: false,
    error: { code: "policy_denied", reason: "window_closed", message: expect.stringContaining("14 days") },
  });
  expect(answer.content).toEqual([{ type: "text", text: JSON.stringify(answer.structuredContent) }]);
});

test("a wrong email comes back as not_found and names neither the order nor the customer", async () => {
  const answer = await call(await connect(), "lookup_order", { order_id: "SC-1003", email: "ana.lungu@example.com" });

  expect(answer.structuredContent).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(JSON.stringify(answer)).not.toMatch(/jonas|weber|curier/i);
});

test("during an outage only the handover works", async () => {
  const client = await connect({ outage: true });

  for (const name of ["lookup_order", "lookup_account", "check_policy", "file_request"]) {
    const answer = await call(client, name, request("SC-1001", { kind: "cancellation" }));
    expect(answer.structuredContent).toMatchObject({ ok: false, error: { code: "unavailable" } });
  }
  const handover = await call(client, "hand_over", { reason: "system_failure", summary: "The shop system is down." });
  expect(handover.structuredContent).toEqual({ ok: true, data: { handover_id: "H-1" } });
});

test.each([
  ["a missing field", "file_request", request("SC-1001", { kind: "delivery_change" }), "new_address"],
  ["an order number without its email", "check_policy", { topic: "return", order_id: "SC-1004" }, "together"],
  ["an unknown function", "refund_now", { order_id: "SC-1001" }, "No function is named refund_now"],
])("%s is answered as invalid_input", async (_, name, args, says) => {
  const answer = await call(await connect(), name, args);

  expect(answer.isError).toBe(true);
  expect(answer.structuredContent).toMatchObject({
    ok: false,
    error: { code: "invalid_input", message: expect.stringContaining(says) },
  });
});

test("pnpm mcp serves the functions over stdio", async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "src", "mcp.ts")],
    cwd: ROOT,
    stderr: "pipe",
  });
  await client.connect(transport);
  onTestFinished(() => client.close());

  const { tools } = await client.listTools();
  const handover = await call(client, "hand_over", { reason: "customer_asked", summary: "Wants a person." });

  expect(tools).toHaveLength(6);
  expect(handover.structuredContent).toEqual({ ok: true, data: { handover_id: "H-1" } });
});
