// An example Light Code / Fire Code add-on.
//
// An add-on is an MCP server over stdio. Light Code starts it once you enable it in
// Settings -> MCP -> Add-ons, and every tool registered here appears to the agent as
// `addon-hello__<tool>`, asked about like any other tool.
//
// Rules worth knowing:
// - Write nothing to stdout except through the transport: stdout carries the protocol.
//   Log with console.error, which goes to the MCP tab's log for this server.
// - Describe each tool and each parameter well. The description is all the model sees.
// - Return text the model can use: say what happened, and what to do when it failed.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'hello', version: '1.0.0' })

server.registerTool(
  'greet',
  {
    description: 'Greets someone by name. Use it to check the add-on is working.',
    inputSchema: { name: z.string().describe('Who to greet') },
  },
  async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }),
)

server.registerTool(
  'count_words',
  {
    description: 'Counts the words, lines and characters in a piece of text.',
    inputSchema: { text: z.string().describe('The text to count') },
  },
  async ({ text }) => {
    const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
    const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length
    return { content: [{ type: 'text', text: `${words} words, ${lines} lines, ${text.length} characters.` }] }
  },
)

await server.connect(new StdioServerTransport())
console.error('hello add-on ready')
