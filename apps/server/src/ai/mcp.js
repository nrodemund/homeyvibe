import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { homeTools, TOOL_GUIDE } from './tools.js';

/**
 * Build an MCP server bound to one signed-in user; every tool checks that user's permissions.
 */
export function createMcpServer({ user, registry, pages, actions, engine }) {
  const server = new McpServer({ name: 'homeyvibe', version: '0.1.0' }, { instructions: TOOL_GUIDE });
  const { tools, call } = homeTools({ user, registry, pages, actions, engine });

  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.shape,
      annotations: tool.annotations,
    }, async (args) => {
      const { ok, text } = await call(tool, args);
      return ok ? { content: [{ type: 'text', text }] } : { isError: true, content: [{ type: 'text', text }] };
    });
  }

  server.registerPrompt('set_up_my_home', {
    title: 'Set up my home',
    description: 'Look at every device and propose pages and actions, then apply them after confirmation.',
  }, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: 'Look at my HomeyVibe home with get_home_overview. Propose a set of pages (one per room where names suggest rooms, otherwise by device kind) and a few useful actions. Show me the plan in plain words, and after I confirm, save it with apply_configuration.',
      },
    }],
  }));

  return server;
}

/**
 * Handle one MCP HTTP request (stateless Streamable HTTP: a fresh server per request).
 */
export async function handleMcpRequest({ req, res, body, user, deps }) {
  const server = createMcpServer({ user, ...deps });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
