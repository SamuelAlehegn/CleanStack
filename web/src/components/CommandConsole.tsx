import type { LogEntry } from '../../../src/web/contracts';
import { Icon } from './Icon';

interface CommandConsoleProps {
  title?: string;
  command: string[];
  messages: LogEntry[];
  defaultOpen?: boolean;
}

export function CommandConsole({
  title = 'Engine output',
  command,
  messages,
  defaultOpen = true,
}: CommandConsoleProps) {
  if (command.length === 0 && messages.length === 0) return null;

  return (
    <details className="command-console" open={defaultOpen}>
      <summary>
        <span className="console-title">
          <Icon name="terminal" size={17} />
          {title}
        </span>
        <span className="console-meta">{messages.length} messages</span>
      </summary>
      <div className="console-body">
        {command.length > 0 && (
          <div className="console-command">
            <span className="prompt">$</span>
            <code>{command.join(' ')}</code>
          </div>
        )}
        {messages.map((message, index) => (
          <div className={`console-line ${message.level}`} key={`${message.level}-${index}`}>
            <span className="console-prefix">
              {message.level === 'success'
                ? '✓'
                : message.level === 'warn'
                  ? '!'
                  : message.level === 'error'
                    ? '×'
                    : '·'}
            </span>
            <span>{message.message}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
