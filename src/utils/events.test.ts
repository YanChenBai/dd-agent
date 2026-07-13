import { createNanoEvents } from 'nanoevents';
import { describe, expect, it, vi } from 'vite-plus/test';

import { createEventHandlers } from './events.ts';

interface Events {
  message: (value: string) => void;
  continueWatching: (value: number) => void;
}

describe('createEventHandlers', () => {
  it('creates typed onEvent methods from an emitter', () => {
    const emitter = createNanoEvents<Events>();
    const handlers = createEventHandlers(emitter);
    const onMessage = vi.fn();
    const onContinueWatching = vi.fn();

    handlers.onMessage(onMessage);
    handlers.onContinueWatching(onContinueWatching);
    emitter.emit('message', 'hello');
    emitter.emit('continueWatching', 42);

    expect(onMessage).toHaveBeenCalledWith('hello');
    expect(onContinueWatching).toHaveBeenCalledWith(42);
  });

  it('returns an unsubscribe function', () => {
    const emitter = createNanoEvents<Events>();
    const handlers = createEventHandlers(emitter);
    const callback = vi.fn();

    const unsubscribe = handlers.onMessage(callback);
    unsubscribe();
    emitter.emit('message', 'hello');

    expect(callback).not.toHaveBeenCalled();
  });

  it('creates typed event handlers from an emitter', () => {
    const emitter = createNanoEvents<Events>();
    const { onMessage } = createEventHandlers(emitter);
    const callback = vi.fn();

    emitter.emit('message', 'hello');
    onMessage(callback);
    emitter.emit('message', 'world');

    expect(callback).toHaveBeenCalledWith('world');
  });
});
