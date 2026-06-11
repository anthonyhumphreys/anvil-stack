import { Action, ActionPanel, Form, Icon, List, popToRoot, showToast, Toast } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { fetchOverview, sendThreadMessage, type ChatThread } from './api';
import { getExtensionBrand } from './brand';

export default function ChatsCommand() {
  const { data, isLoading, revalidate } = useCachedPromise(fetchOverview);
  const threads = data?.threads ?? [];
  const brand = getExtensionBrand();

  return (
    <List isLoading={isLoading} searchBarPlaceholder={`Search ${brand.appName} chats`}>
      {threads.map((thread) => (
        <List.Item
          key={thread.id}
          title={thread.title}
          subtitle={thread.preview}
          icon={thread.activeSessionId ? Icon.Message : Icon.Text}
          accessories={[{ text: thread.activeSessionStatus ?? `${thread.messageCount} messages` }]}
          actions={
            <ActionPanel>
              {thread.activeSessionId && (
                <Action.Push
                  title="Send Message"
                  icon={Icon.Message}
                  target={<SendMessageForm thread={thread} onSent={revalidate} />}
                />
              )}
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
            </ActionPanel>
          }
        />
      ))}
      {threads.length === 0 && <List.EmptyView title="No chats yet" icon={Icon.Message} />}
    </List>
  );
}

function SendMessageForm({ thread, onSent }: { thread: ChatThread; onSent: () => void }) {
  const brand = getExtensionBrand();

  const submit = async (values: { message: string }) => {
    if (!values.message.trim()) return;
    await showToast({ style: Toast.Style.Animated, title: `Sending to ${brand.appName}` });
    await sendThreadMessage(thread.id, thread.activeSessionId, values.message.trim());
    onSent();
    await showToast({ style: Toast.Style.Success, title: 'Message sent' });
    await popToRoot();
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send Message" icon={Icon.Message} onSubmit={submit} />
          <Action.SubmitForm
            title="Continue"
            icon={Icon.Play}
            onSubmit={() => void submit({ message: 'Continue.' })}
          />
          <Action.SubmitForm
            title="Summarize Status"
            icon={Icon.Text}
            onSubmit={() => void submit({ message: 'Summarize the current status.' })}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea id="message" title="Message" placeholder={`Send input to ${thread.title}`} />
    </Form>
  );
}
