// Check before building progress snapshots, signatures or UI strings. Scalar
// arguments keep the suppressed per-packet path free of temporary objects.
export function createProgressGate(now = () => performance.now()) {
  let lastTime = -Infinity,
    phase,
    message,
    reconnecting,
    attempt;
  return (nextPhase, nextMessage, nextReconnecting, nextAttempt, force = false) => {
    const time = now();
    const changed =
      nextPhase !== phase || nextMessage !== message || nextReconnecting !== reconnecting || nextAttempt !== attempt;
    if (!force && !changed && time - lastTime < 100) return false;
    lastTime = time;
    phase = nextPhase;
    message = nextMessage;
    reconnecting = nextReconnecting;
    attempt = nextAttempt;
    return true;
  };
}
