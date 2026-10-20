import { useNavigate } from 'react-router-dom';
import { MessageSquareText } from 'lucide-react';
import { Button, type ButtonSize, type ButtonVariant } from '../ui';
import { reviewInChatPath, type ReviewInChatScope } from './review-in-chat';

const PREFILL_HINT = 'Opens chat with a prefilled prompt. Nothing is sent until you press Enter.';

/** Primary launcher: opens chat with a prefilled review prompt for the scope. */
export function ReviewInChatButton({
  scope,
  label = 'Review in chat',
  variant = 'primary',
  size = 'sm',
  className,
}: {
  scope: ReviewInChatScope | null;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={!scope}
      title={PREFILL_HINT}
      onClick={() => {
        if (scope) navigate(reviewInChatPath(scope));
      }}
      className={className}
    >
      <MessageSquareText size={14} aria-hidden="true" />
      {label}
    </Button>
  );
}

/** Quiet note on saved (pre-surface) review views pointing at the chat path. */
export function NewReviewsInChatNote({
  scope,
  className = '',
}: {
  scope: ReviewInChatScope | null;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <p className={`text-xs leading-5 text-text-tertiary ${className}`}>
      New reviews open inline in chat.
      {scope ? (
        <>
          {' '}
          <button
            type="button"
            title={PREFILL_HINT}
            onClick={() => navigate(reviewInChatPath(scope))}
            className="rounded-sm font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Review again in chat
          </button>
        </>
      ) : null}
    </p>
  );
}
