import { styleText } from 'node:util';

import { createConsola } from 'consola';
import type { ConsolaInstance, ConsolaOptions, LogType } from 'consola';

type LogMethod = Exclude<LogType, 'silent'>;
type TextStyle = Parameters<typeof styleText>[0];

export type LoggerOptions = Partial<ConsolaOptions> & {
  fancy?: boolean;
  prefix?: string;
  prefixColor?: TextStyle;
};

const LOG_METHODS = new Set<LogMethod>([
  'fatal',
  'error',
  'warn',
  'log',
  'info',
  'success',
  'fail',
  'ready',
  'start',
  'box',
  'debug',
  'trace',
  'verbose',
]);

function isLogMethod(property: PropertyKey): property is LogMethod {
  return typeof property === 'string' && LOG_METHODS.has(property as LogMethod);
}

export function createLogger(options: LoggerOptions = {}): ConsolaInstance {
  const { prefix, prefixColor = 'cyan', fancy: _fancy, ...consolaOptions } = options;

  const logger = createConsola(consolaOptions);

  if (!prefix) {
    return logger;
  }

  const formattedPrefix = styleText(prefixColor, `[${prefix}]`);

  return new Proxy(logger, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);

      if (typeof value !== 'function') {
        return value;
      }

      if (!isLogMethod(property)) {
        return value.bind(target);
      }

      return (...args: unknown[]) => {
        return Reflect.apply(value, target, [formattedPrefix, ...args]);
      };
    },
  });
}
