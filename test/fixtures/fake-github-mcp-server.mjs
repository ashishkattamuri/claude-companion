// A stand-in for GitHub's MCP server, over stdio. Answers the searches the recap makes with fixed
// results, and has one write tool so tests can check Companion never calls it unapproved.
// FAKE_GH_LOG=<file> records every tool call; FAKE_GH_FAIL=1 makes get_me fail (a bad token).
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (tool, args) => process.env.FAKE_GH_LOG && appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ tool, args })}\n`);
const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const item = (repo, number, title) => ({
  number,
  title,
  html_url: `https://github.com/${repo}/${number < 30 ? 'pull' : 'issues'}/${number}`,
  repository_url: `https://api.github.com/repos/${repo}`,
  updated_at: '2026-09-30T12:00:00Z',
  user: { login: 'someone' },
});

function search(query) {
  if (query.includes('review-requested:@me')) return [item('acme/api', 12, 'Add rate limiter')];
  if (query.includes('status:failure')) return [item('acme/web', 7, 'Fix login redirect')];
  if (query.includes('is:merged') && query.includes('author:@me')) return [item('acme/api', 10, 'Retry webhooks')];
  if (query.includes('is:merged') && query.includes('repo:')) return [item('acme/api', 10, 'Retry webhooks'), item('acme/api', 11, 'Bump deps')];
  if (query.includes('is:issue') && query.includes('assignee:@me')) return [item('acme/api', 31, 'Webhooks drop events under load')];
  return [];
}

const server = new McpServer({ name: 'github-mcp-server', version: '0.0.0-fake' });
const searchArgs = { query: z.string(), perPage: z.number().optional(), sort: z.string().optional(), order: z.string().optional() };

server.registerTool('get_me', { description: 'Get my user profile', inputSchema: {} }, async () => {
  log('get_me', {});
  if (process.env.FAKE_GH_FAIL) return { content: [{ type: 'text', text: '401 Bad credentials' }], isError: true };
  return text({ login: 'octo', id: 1 });
});
for (const name of ['search_pull_requests', 'search_issues']) {
  server.registerTool(name, { description: name, inputSchema: searchArgs }, async (args) => {
    log(name, args);
    const items = search(args.query);
    return text({ total_count: items.length, incomplete_results: false, items });
  });
}
server.registerTool('create_issue', { description: 'Create an issue', inputSchema: { title: z.string() } }, async (args) => {
  log('create_issue', args);
  return text({ number: 99 });
});

await server.connect(new StdioServerTransport());
