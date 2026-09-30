// ---------------------------------------------------------------------------
// workerInputs.ts
// For fakes of the regex and timestamp workers: what a worker serving with
// `createRequestQueue` would make of the messages posted to it. The page
// sends each set of inputs once, ahead of the requests that use them
// (`WorkerInputsMessage`), so the last request alone no longer says what it
// matches against.
// ---------------------------------------------------------------------------

import { isWorkerInputsMessage, type QueuedRequest } from '../engine/workerProtocol';

/** The requests among `posted`, without the inputs messages. */
export function requestsIn<TReq extends QueuedRequest>(posted: readonly unknown[]): TReq[] {
  return posted.filter((m): m is TReq => !isWorkerInputsMessage(m));
}

/** The inputs sent most recently, or undefined when none were. */
export function lastInputs(posted: readonly unknown[]): unknown {
  for (let i = posted.length - 1; i >= 0; i--) {
    const m = posted[i];
    if (isWorkerInputsMessage(m)) return m.inputs;
  }
  return undefined;
}

/**
 * The last request posted, with the inputs it runs over: its own, or the
 * inputs message it names by `inputsId`.
 */
export function lastRequest<TReq extends QueuedRequest, TInputs>(
  posted: readonly unknown[],
  own: (request: TReq) => TInputs | undefined,
): { request: TReq; inputs: TInputs } {
  let sent: { inputsId: number; inputs: TInputs } | null = null;
  let last: TReq | null = null;
  for (const m of posted) {
    if (isWorkerInputsMessage(m)) sent = { inputsId: m.inputsId, inputs: m.inputs as TInputs };
    else last = m as TReq;
  }
  if (!last) throw new Error('No request was posted');
  const inputs = own(last) ?? (sent !== null && sent.inputsId === last.inputsId ? sent.inputs : undefined);
  if (inputs === undefined) throw new Error(`Request ${last.id} has no inputs`);
  return { request: last, inputs };
}
