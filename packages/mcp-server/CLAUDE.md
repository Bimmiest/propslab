# CLAUDE.md — the MCP server

These rules apply in this package. The rules for the whole repository are in
the `CLAUDE.md` at its root, and the detail is in [README.md](README.md).

## Gates

```bash
npm ci && npm run build && npm run test:coverage
```

Run them here, in `packages/mcp-server`. `server.e2e.test.ts` starts the
built server, so build before you test. A test against the old build passes
or fails for the wrong reason.

## Expensive to get wrong

- **Each tool declares an `outputSchema`** in `src/outputSchemas.ts`, and
  returns its result as `structuredContent` that matches it. The SDK client
  validates each success against the schema, so a field that the schema does
  not allow fails the call.
- **Each response stays inside `MAX_RESPONSE_BYTES`** (`src/responseBudget.ts`),
  counted as UTF-8 bytes of the JSON-RPC line. A tool that returns a list cuts
  the list to fit, and says that it did.
- **Each engine run happens in a worker thread with a wall-clock budget.** A
  run that the budget stops comes back structured, and never blocks the
  server's own thread.
