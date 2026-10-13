export type LogListener = (line: string, allLogs: string[]) => void;

class AppLogger {
  private logs: string[] = [];
  private listeners: Set<LogListener> = new Set();
  private debugEnabled = false;
  private maxLines = 400;

  public setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  public isDebugEnabled(): boolean {
    return this.debugEnabled;
  }

  public addListener(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getLogs(): string[] {
    return this.logs;
  }

  public clearLogs(): void {
    this.logs = [];
    for (const listener of this.listeners) {
      listener('', this.logs);
    }
  }

  public log(tag: string, message: string): void {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const line = `${h}:${m}:${s}.${ms} [${tag}] ${message}`;

    this.logs.push(line);
    if (this.logs.length > this.maxLines) {
      this.logs.splice(0, this.logs.length - this.maxLines);
    }

    for (const listener of this.listeners) {
      listener(line, this.logs);
    }
  }

  public logError(tag: string, message: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err ? String(err) : '';
    this.log(tag, detail ? `ERROR: ${message} (${detail})` : `ERROR: ${message}`);
  }
}

export const FileLogger = new AppLogger();
