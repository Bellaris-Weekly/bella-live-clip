import {parsePlaylist} from './playlist.js';
import {deferred} from '../shared/deferred.js';

const CONCURRENCY = 3;

// One instance belongs to one loaded recording. Refreshing creates a new instance.
export class RecordingPlan {
  constructor(api, streams, signal) {
    this.api = api;
    this.streams = streams;
    this.signal = signal;
    this.pending = null;
    this.parts = new Map();
    this.queue = [];
    this.active = 0;
  }

  async readPart(index) {
    this.signal?.throwIfAborted();
    const stream = this.streams[index];
    const response = await this.api.request(stream.stream, {signal: this.signal});
    this.signal?.throwIfAborted();
    const parsed = parsePlaylist(response.data, response.url);
    return parsed.groups.map(group => ({
      ...group,
      start: stream.start_time + group.offset,
      streamEnd: stream.end_time,
      streamIndex: index,
      part: stream,
      firstSegment: parsed.groups[0]?.segments[0],
      firstMap: parsed.groups[0]?.map,
    }));
  }

  pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const task = this.queue.shift();
      task.started = true;
      this.active++;
      void this.readPart(task.index)
        .then(task.resolve, error => {
          this.parts.delete(task.index);
          task.reject(error);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  part(index, priority) {
    if (!Number.isInteger(index) || !this.streams[index]) throw new Error('无法读取对应的录像分段。');
    let task = this.parts.get(index);
    if (!task) {
      task = {...deferred(), index, started: false};
      this.parts.set(index, task);
      this.queue.push(task);
    }
    if (priority && !task.started) {
      this.queue.splice(this.queue.indexOf(task), 1);
      this.queue.unshift(task);
    }
    this.pump();
    return task.promise;
  }

  async wait(pending, callerSignal) {
    const signal =
      callerSignal && this.signal && callerSignal !== this.signal
        ? AbortSignal.any([callerSignal, this.signal])
        : (callerSignal ?? this.signal);
    if (!signal) return pending;
    signal.throwIfAborted();
    // Cancel this caller's wait without canceling another consumer's shared read.
    let abort;
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, {once: true});
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async loadPart(index, signal) {
    this.signal?.throwIfAborted();
    signal?.throwIfAborted();
    return this.wait(this.part(index, true), signal);
  }

  async load(signal) {
    this.signal?.throwIfAborted();
    signal?.throwIfAborted();
    this.pending ??= Promise.all(this.streams.map((_, index) => this.part(index, false)))
      .then(groups => groups.flat())
      .catch(error => {
        this.pending = null;
        throw error;
      });
    return this.wait(this.pending, signal);
  }
}
