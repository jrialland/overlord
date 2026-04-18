import {pino} from "pino";
import pretty from 'pino-pretty'

/**
 * Shared application logger.
 * LOG_LEVEL controls verbosity; defaults to debug for local development.
 */
export const logger = pino({
    level: process.env.LOG_LEVEL || 'debug',
    transport: {
        target: 'pino-pretty'
    },
    options: {
        colorize: pretty.isColorSupported
    }
});