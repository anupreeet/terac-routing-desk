// Structured logs: JSON lines when piped, compact text in a terminal. Silent in tests.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: { level?: Level; pretty?: boolean } = {}): Logger {
  const min = ORDER[opts.level ?? (process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? ORDER.info;
  const fmt = process.env.LOG_FORMAT;
  const pretty = opts.pretty ?? (fmt ? fmt === 'pretty' : Boolean(process.stdout.isTTY));
  const write = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return;
    const t = new Date().toISOString();
    if (pretty) {
      const rest = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      const line = `${t.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${event}${rest ? ' ' + rest : ''}`;
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    } else {
      process.stdout.write(JSON.stringify({ t, level, event, ...fields }) + '\n');
    }
  };
  return { debug: (e, f) => write('debug', e, f), info: (e, f) => write('info', e, f), warn: (e, f) => write('warn', e, f), error: (e, f) => write('error', e, f) };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
