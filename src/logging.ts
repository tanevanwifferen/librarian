// src/logging.ts
// What: Application logger.
// How: Creates a pino logger. In development, attempts to use pino-pretty transport for readable logs.

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
// Use loose 'any' to avoid type namespace issues before deps are installed
const baseOptions: any = {
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
};

let logger: any;

// Try pretty transport in development; fall back to standard if unavailable.
if (isDev) {
  try {
    logger = pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          singleLine: false,
        },
      },
    });
  } catch {
    logger = pino(baseOptions);
  }
} else {
  logger = pino(baseOptions);
}

export default logger;