// One tool call as the MCP SDK wants it answered: the handler's result as JSON text, or its
// error as an `isError` reply. Kept out of index.js (which connects stdio on import) so it can be
// tested. The write tools answer with a Promise — they resolve once the state file is saved — so
// the result is awaited: serialised as it came, every write answered `{}`, and an error thrown
// while saving never reached the caller at all.
export async function respond(tool, params) {
  try {
    const result = await tool.handler(params || {})
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const code = err.code || 'ERROR'
    return {
      isError: true,
      content: [{ type: 'text', text: `${code}: ${err.message}` }]
    }
  }
}
