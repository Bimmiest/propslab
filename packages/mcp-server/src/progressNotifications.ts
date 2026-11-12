/**
 * MCP progress notifications for a tool call whose client sent a
 * `progressToken` (#885). A call can wait in the queue behind other calls,
 * then for its worker to start, then run for its whole budget (runInWorker.ts),
 * which together can outlast a client's request timeout. A notification while
 * it waits says why nothing has come back yet, and lets a client that resets
 * its timeout on progress keep waiting.
 */
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallProgress } from './runInWorker';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One line for an agent: where the call is, and whether its budget runs yet. */
export function describeProgress(progress: CallProgress): string {
  switch (progress.phase) {
    case 'queued':
      return (
        `Waiting for a sandbox slot: ${plural(progress.running, 'run')} in progress, ` +
        `${plural(progress.queued, 'call')} queued, this one included. The timeout_ms budget has not started.`
      );
    case 'starting':
      return 'Starting the sandbox worker. The timeout_ms budget starts when it is ready.';
    case 'parsing':
      return 'Parsing the conf.';
    case 'running':
      if (progress.stage === undefined) return 'Running the engine on the conf.';
      if (progress.stage === 'LINE_BREAKER') return 'Running LINE_BREAKER: breaking the sample into events.';
      return `Running ${progress.stage} over ${plural(progress.events ?? 0, 'event')}.`;
    case 'finishing':
      return 'The run is done; shaping the response.';
  }
}

/**
 * The `onProgress` for a call, or undefined when the client sent no
 * `progressToken` and so asked for none. `progress` counts the notifications,
 * because the protocol requires it to increase with each one and a call has
 * no total to measure against; the message carries the state.
 */
export function progressNotifier(
  extra: Pick<ToolExtra, '_meta' | 'sendNotification'>,
): ((progress: CallProgress) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let sent = 0;
  return (progress) => {
    sent += 1;
    // A failed send means the client or the transport is gone. The call's
    // own result, or its cancellation, already deals with that.
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: sent, message: describeProgress(progress) },
      })
      .catch(() => undefined);
  };
}
