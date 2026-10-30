import { ClipboardList, MessageSquare } from 'lucide-react';
import type { ChatLayout } from '../../../shared/types';
import { SegmentedControl } from '../ui';

/**
 * CH4/CH9 — the Chat/Tickets layout toggle now lives in the thread-rail
 * header instead of the (denser) page header.
 */
export function ChatLayoutToggle({
  layout,
  onChange,
}: {
  layout: ChatLayout;
  onChange: (layout: ChatLayout) => void;
}) {
  return (
    <SegmentedControl<ChatLayout>
      label="Thread source"
      size="sm"
      value={layout}
      onChange={onChange}
      options={[
        { value: 'classic', label: 'Chat', icon: MessageSquare, ariaLabel: 'Chat threads' },
        {
          value: 'workitems',
          label: 'Tickets',
          icon: ClipboardList,
          ariaLabel: 'Work-item threads',
        },
      ]}
      className="w-full"
    />
  );
}
