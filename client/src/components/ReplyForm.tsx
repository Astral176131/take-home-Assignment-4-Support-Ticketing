import { useState } from 'react';

interface Props {
  busy: boolean;
  // Reports whether the reply actually went through, so a failed submit can leave what
  // was typed in place instead of discarding it. Losing a long reply to a transient
  // error is worse than making the agent clear the box themselves.
  onSubmit: (reply: {
    body: string;
    is_internal: boolean;
    author_type: 'agent' | 'customer';
  }) => Promise<boolean>;
}

export function ReplyForm({ busy, onSubmit }: Props) {
  const [body, setBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [fromCustomer, setFromCustomer] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;

    const succeeded = await onSubmit({
      body,
      is_internal: isInternal,
      author_type: fromCustomer ? 'customer' : 'agent',
    });

    if (succeeded) {
      setBody('');
      setIsInternal(false);
      setFromCustomer(false);
    }
  }

  return (
    <form className="reply-form" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="reply-body">
        Reply
      </label>
      <textarea
        id="reply-body"
        rows={4}
        autoComplete="off"
        value={body}
        placeholder={fromCustomer ? "Paste the customer's email…" : 'Write a reply…'}
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="reply-controls">
        <label className="toggle">
          <input
            type="checkbox"
            checked={fromCustomer}
            onChange={(e) => {
              setFromCustomer(e.target.checked);
              // The server rejects a customer reply marked internal, so make the
              // combination unreachable rather than letting it fail on submit.
              if (e.target.checked) setIsInternal(false);
            }}
          />
          Log a customer email
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={isInternal}
            disabled={fromCustomer}
            onChange={(e) => setIsInternal(e.target.checked)}
          />
          Internal note
        </label>

        <button type="submit" className="btn btn-primary" disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : 'Add reply'}
        </button>
      </div>
    </form>
  );
}
