export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Producers and consumers may fail before the other starts waiting.
  void promise.catch(() => {});
  return {promise, resolve, reject};
}
