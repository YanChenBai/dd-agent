import type { Emitter, Unsubscribe } from 'nanoevents';

export type EventHandlers<
  Events extends { [EventName in keyof Events]: (...args: any[]) => void },
> = EventHandlerMethods<Events>;

export type EventHandlerMethods<
  Events extends { [EventName in keyof Events]: (...args: any[]) => void },
> = {
  [EventName in keyof Events as `on${Capitalize<string & EventName>}`]: (
    callback: Events[EventName],
  ) => Unsubscribe;
};

export function createEventHandlers<
  Events extends { [EventName in keyof Events]: (...args: any[]) => void },
>(emitter: Emitter<Events>): EventHandlers<Events> {
  const getEventHandler = (property: string) => {
    const event = property.slice(2);
    const eventName = event.charAt(0).toLowerCase() + event.slice(1);
    return (callback: Events[keyof Events]) => emitter.on(eventName as keyof Events, callback);
  };
  const handlers = new Proxy({} as EventHandlers<Events>, {
    get(_target, property: string | symbol) {
      if (typeof property !== 'string') {
        return undefined;
      }

      if (!property.startsWith('on')) {
        return undefined;
      }

      return getEventHandler(property);
    },
  });

  return handlers;
}
