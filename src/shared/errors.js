// Diagnostic facts travel on the error itself, so a user-facing wrapper cannot
// lose where the original failure happened. The innermost annotation wins.
export function annotate(error, facts) {
  if (error && typeof error === 'object') {
    try {
      error.diagnostic = {...facts, ...error.diagnostic};
    } catch {
      /* A frozen error still propagates unchanged. */
    }
  }
  return error;
}

// Storage DOMExceptions carry no stack, so the failing call is recorded instead.
export async function storageStep(operation, target, action) {
  try {
    return await action();
  } catch (error) {
    throw annotate(error, {operation, target});
  }
}

// Cleanup runs after an operation already succeeded or failed. Its own failure
// must never replace the error that explains why the operation stopped; it is
// kept beside that error for diagnostics instead. Every step runs.
export async function cleanUp(primary, ...steps) {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (primary && typeof primary === 'object' && error !== primary) {
        try {
          (primary.suppressed ??= []).push(error);
        } catch {
          /* Diagnostics only. */
        }
      }
    }
  }
}
