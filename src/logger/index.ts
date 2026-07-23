import { styleText } from 'node:util';

import { createConsola } from 'consola';
import type { ConsolaInstance, ConsolaOptions, LogType } from 'consola';

import type { ObservabilityContext } from '@/observability/context.ts';

type LogMethod = Exclude<LogType, 'silent'>;
type TextStyle = Parameters<typeof styleText>[0];

export type LoggerOptions = Partial<ConsolaOptions> & {
  fancy?: boolean;
  prefix?: string;
  prefixColor?: TextStyle;
  context?: ObservabilityContext;
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
  const { prefix, prefixColor = 'cyan', context, fancy: _fancy, ...consolaOptions } = options;

  const logger = createConsola(consolaOptions);

  if (!prefix && !context) {
    return logger;
  }

  const labels = [
    prefix,

    context?.roomId === undefined ? undefined : `room=${context.roomId}`,

    context?.component && context.component !== prefix
      ? `component=${context.component}`
      : undefined,
  ].filter(Boolean);
  const formattedPrefix = styleText(prefixColor, `[${labels.join(' ')}]`);

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
        return Reflect.apply(value, target, [formattedPrefix, ...redactLogArguments(args)]);
      };
    },
  });
}

function redactLogArguments(args: unknown[]): unknown[] {
  return args.map(value => {
    if (typeof value === 'string') {
      return redactSensitiveText(value);
    }
    if (value instanceof Error) {
      const error = new Error(redactSensitiveText(value.message), {
        cause: value.cause instanceof Error ? redactLogArguments([value.cause])[0] : value.cause,
      });
      error.name = value.name;
      error.stack = value.stack ? redactSensitiveText(value.stack) : undefined;
      return error;
    }
    return value;
  });
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, match => {
      try {
        const url = new URL(match);
        return url.search || url.hash ? `${url.origin}${url.pathname}?[REDACTED]` : match;
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(api[-_ ]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]');
}
