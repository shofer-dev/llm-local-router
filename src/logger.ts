/**
 * Structured logger for the LLM Local Router extension.
 *
 * When running inside VS Code, logging is backed by the shared double-output
 * logger (`@arkware/shared-logger`), teeing lines to both the Output panel and
 * stdout/stderr as JSON (for Loki). When running outside of VS Code (e.g.,
 * unit tests), it falls back to console output.
 */

import { wrapOutputChannel, type Logger as SharedLogger } from '@arkware/shared-logger';

export enum LogLevel {
    Debug = 'DEBUG',
    Info = 'INFO',
    Warning = 'WARN',
    Error = 'ERROR',
}

/** Lazily load vscode — not available during unit tests. */
let vscodeModule: typeof import('vscode') | undefined;
function getVSCode(): typeof import('vscode') | undefined {
    if (vscodeModule === undefined) {
        try {
            vscodeModule = require('vscode');
        } catch {
            vscodeModule = undefined;
        }
    }
    return vscodeModule;
}

export class Logger {
    private shared: SharedLogger | undefined;
    private debugEnabled: boolean = false;

    constructor(channelName: string, enableDebug: boolean = false) {
        const vscode = getVSCode();
        if (vscode) {
            this.shared = wrapOutputChannel(
                vscode.window.createOutputChannel(channelName),
                { debug: enableDebug }
            );
        }
        this.debugEnabled = enableDebug;
    }

    public setDebug(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private formatMessage(level: LogLevel, message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${message}`;
    }

    /**
     * Console fallback for when there is no VS Code output channel (tests).
     * When the shared logger is active, callers route through it directly.
     */
    private writeLog(level: LogLevel, message: string): void {
        const stream = level === LogLevel.Error || level === LogLevel.Warning ? console.error : console.log;
        stream(this.formatMessage(level, message));
    }

    public debug(message: string): void {
        if (this.debugEnabled) {
            if (this.shared) {
                this.shared.debug(message);
            } else {
                this.writeLog(LogLevel.Debug, message);
            }
        }
    }

    public info(message: string): void {
        if (this.shared) {
            this.shared.info(message);
        } else {
            this.writeLog(LogLevel.Info, message);
        }
    }

    public warning(message: string): void {
        if (this.shared) {
            this.shared.warning(message);
        } else {
            this.writeLog(LogLevel.Warning, message);
        }
    }

    public error(message: string): void {
        if (this.shared) {
            this.shared.error(message);
        } else {
            this.writeLog(LogLevel.Error, message);
        }
    }

    public errorWithError(message: string, error: Error): void {
        if (this.shared) {
            this.shared.error(message, error);
            return;
        }
        const errorMessage = error.message || 'Unknown error';
        this.writeLog(LogLevel.Error, `${message}: ${errorMessage}`);
        // Include the stack trace (when present) on its own line for debuggability.
        if (error.stack) {
            this.writeLog(LogLevel.Error, error.stack);
        }
    }

    public show(): void {
        this.shared?.show();
    }

    public dispose(): void {
        this.shared?.dispose();
    }
}

let globalLogger: Logger | undefined;

export function initLogger(channelName: string, enableDebug: boolean = false): void {
    globalLogger = new Logger(channelName, enableDebug);
}

export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = new Logger('LLM Local Router', false);
    }
    return globalLogger;
}

export function setDebugMode(enabled: boolean): void {
    getLogger().setDebug(enabled);
}
