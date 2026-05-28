/**
 * Structured logger for the Shofer LLM Router extension.
 *
 * Writes to a VSCode output channel with timestamps and log levels.
 * When running outside of VS Code (e.g., unit tests), falls back to console.
 * Mirrors the llm-provider logger design.
 */

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
    private outputChannel: { appendLine(line: string): void; show(): void; dispose(): void } | undefined;
    private debugEnabled: boolean = false;

    constructor(channelName: string, enableDebug: boolean = false) {
        const vscode = getVSCode();
        if (vscode) {
            this.outputChannel = vscode.window.createOutputChannel(channelName);
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

    private writeLog(level: LogLevel, message: string): void {
        const formatted = this.formatMessage(level, message);
        if (this.outputChannel) {
            this.outputChannel.appendLine(formatted);
        } else {
            const stream = level === LogLevel.Error ? console.error : console.log;
            stream(formatted);
        }
    }

    public debug(message: string): void {
        if (this.debugEnabled) {
            this.writeLog(LogLevel.Debug, message);
        }
    }

    public info(message: string): void {
        this.writeLog(LogLevel.Info, message);
    }

    public warning(message: string): void {
        this.writeLog(LogLevel.Warning, message);
    }

    public error(message: string): void {
        this.writeLog(LogLevel.Error, message);
    }

    public errorWithError(message: string, error: Error): void {
        const errorMessage = error.message || 'Unknown error';
        this.writeLog(LogLevel.Error, `${message}: ${errorMessage}`);
    }

    public show(): void {
        if (this.outputChannel) {
            this.outputChannel.show();
        }
    }

    public dispose(): void {
        if (this.outputChannel) {
            this.outputChannel.dispose();
        }
    }
}

let globalLogger: Logger | undefined;

export function initLogger(channelName: string, enableDebug: boolean = false): void {
    globalLogger = new Logger(channelName, enableDebug);
}

export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = new Logger('Shofer LLM Router', false);
    }
    return globalLogger;
}

export function setDebugMode(enabled: boolean): void {
    getLogger().setDebug(enabled);
}
