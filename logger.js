import winston from 'winston';
import {format} from 'date-fns';

// Custom log format
const cleanFormat = winston.format.printf(({level, message, timestamp, stack}) => {
    let output = `${timestamp} [${level.toUpperCase()}] ${message}`;
    if (stack) {
        output += `\n${stack}`;
    }
    return output;
});

// Create the logger
export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: () => format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        }),
        winston.format.errors({stack: true}),
        cleanFormat
    ),
    transports: [
        // Console transport
        new winston.transports.Console(),
        // File transport for all logs
        new winston.transports.File({filename: 'logs/combined.log'}),
        // File transport for error logs only
        new winston.transports.File({filename: 'logs/error.log', level: 'error'})
    ]
});

