import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageSquare, SendHorizontal } from 'lucide-react';
import { t } from '../i18n';
import type { ChatMsg } from '../store/app';
import { EmptyState } from '../components/ui';

export function ChatPanel({
  messages,
  onSend,
  disabled,
  peerName,
  autoFocus,
}: {
  messages: ChatMsg[];
  onSend: (text: string) => void;
  disabled?: boolean;
  peerName: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const v = text.trim();
    if (!v || disabled) return;
    onSend(v.slice(0, 4000));
    setText('');
  };

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef} data-testid="chat-list">
        {messages.length === 0 ? (
          <EmptyState icon={<MessageSquare />} title={t.chat.empty} hint={t.chat.emptyHint} />
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = prev && prev.from === m.from && m.ts - prev.ts < 60_000;
            return (
              <div key={m.id} className={`bubble-row ${m.from}${grouped ? ' grouped' : ''}`}>
                {!grouped && (
                  <div className="bubble-meta">
                    {m.from === 'me' ? t.chat.you : peerName} ·{' '}
                    {new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
                <div className="bubble" data-testid={`chat-msg-${m.from}`}>
                  {m.text}
                </div>
              </div>
            );
          })
        )}
      </div>
      {disabled ? (
        <div className="chat-disabled">{t.chat.disabled}</div>
      ) : (
        <form className="chat-compose" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="input"
            rows={1}
            value={text}
            placeholder={t.chat.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            data-testid="chat-input"
          />
          <button className="btn btn-primary chat-send" type="submit" disabled={!text.trim()} aria-label={t.chat.send} data-testid="chat-send">
            <SendHorizontal />
          </button>
        </form>
      )}
    </div>
  );
}
