import {measureMediaRequest} from '../shared/media-metrics.js';
const KEPT = 4;

// A playlist runs to over a megabyte, and the player, the export plan and the
// stills all want the same one. It belongs to the record, so one reader
// cancelling must not abort it for the others.
export function sharePlaylists(request) {
  const playlists = new Map();
  function playlist(url, signal) {
    let pending = playlists.get(url);
    if (!pending) {
      pending = request(url, {type: 'text'}).catch(error => {
        playlists.delete(url);
        throw error;
      });
      playlists.set(url, pending);
      if (playlists.size > KEPT) playlists.delete(playlists.keys().next().value);
    }
    if (!signal) return pending;
    signal.throwIfAborted();
    let abort;
    return Promise.race([
      pending,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
      }),
    ]).finally(() => signal.removeEventListener('abort', abort));
  }
  const route =
    read =>
    (url, options = {}) =>
      options.type === 'arraybuffer' || options.range ? read(url, options) : playlist(url, options.signal);
  const sharedRequest = route(request);
  sharedRequest.withMetrics = metrics => route(measureMediaRequest(request, metrics));
  return {
    request: sharedRequest,
    clear: () => playlists.clear(),
  };
}
