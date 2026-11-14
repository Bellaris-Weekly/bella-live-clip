// A long-lived Promise.race cancellation branch retains reactions from every
// completed frame. Keep only current waits; settlement removes their rejects.
export function createAbortableWait() {
  const pending = new Set();
  let stopped = false,
    reason;
  return {
    wait(task) {
      return new Promise((resolve, reject) => {
        if (stopped) reject(reason);
        else pending.add(reject);
        // Observe the task even after cancellation: a late rejection must not
        // become unhandled or replace the original cancellation reason.
        Promise.resolve(task).then(
          value => {
            pending.delete(reject);
            resolve(value);
          },
          error => {
            pending.delete(reject);
            reject(error);
          },
        );
      });
    },
    abort(error) {
      if (stopped) return;
      stopped = true;
      reason = error;
      for (const reject of pending) reject(reason);
      pending.clear();
    },
  };
}
