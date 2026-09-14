/** Cancellation is control flow, so callers must not display it as a failure. */
export class OperationCancelledError extends Error {
  readonly code = 'operation_cancelled';

  constructor() {
    super('Operation cancelled');
    this.name = 'OperationCancelledError';
  }
}

/** A timeout bounds the JS operation; native cleanup remains its owner's job. */
export class OperationTimeoutError extends Error {
  readonly code = 'operation_timeout';

  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'OperationTimeoutError';
  }
}

/** Settle promptly on cancellation/timeout and consume late native rejections. */
export function waitForOperation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs?: number,
  label = 'Operation',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new OperationCancelledError()));
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) {
      onAbort();
    } else if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(new OperationTimeoutError(label, timeoutMs))),
        Math.max(0, timeoutMs),
      );
    }
  });
}

/** A cancellable pause that does not leave a timer alive after cancellation. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return waitForOperation(promise, signal).finally(() => clearTimeout(timer));
}
