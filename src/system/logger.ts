// ============================================================
// Logger — pino-based logging
// ============================================================

import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
  level: config.LOG_LEVEL,
})
