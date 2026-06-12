import { Action, ActionPanel, Form, Icon, List, popToRoot, showToast, Toast } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { fetchOverview, startWorkflow, type QuickAction } from './api';
import { getExtensionBrand } from './brand';

export default function LaunchWorkflowCommand() {
  const { data, isLoading, revalidate } = useCachedPromise(fetchOverview);
  const brand = getExtensionBrand();
  const actions = data?.quickActions ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder={`Launch ${brand.appName} workflows`}>
      <List.Section title="One-Tap Workflows">
        {actions.map((action) => (
          <List.Item
            key={action.id}
            title={action.title}
            subtitle={action.subtitle}
            icon={Icon.Play}
            actions={
              <ActionPanel>
                <Action
                  title="Launch Workflow"
                  icon={Icon.Play}
                  onAction={() => void launchQuickAction(action, revalidate)}
                />
                <Action.CopyToClipboard title="Copy Prompt" content={action.prompt} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="Custom">
        <List.Item
          title="Start Custom Prompt"
          subtitle="Send a fresh prompt into the active Anvil workspace"
          icon={Icon.Message}
          actions={
            <ActionPanel>
              <Action.Push
                title="Write Prompt"
                icon={Icon.Message}
                target={<CustomPromptForm onStarted={revalidate} />}
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}

async function launchQuickAction(action: QuickAction, onStarted: () => void) {
  await showToast({ style: Toast.Style.Animated, title: `Launching ${action.title}` });
  await startWorkflow({ actionId: action.id });
  onStarted();
  await showToast({ style: Toast.Style.Success, title: `${action.title} started` });
}

function CustomPromptForm({ onStarted }: { onStarted: () => void }) {
  const brand = getExtensionBrand();

  const submit = async (values: { title?: string; message: string }) => {
    if (!values.message.trim()) return;
    await showToast({ style: Toast.Style.Animated, title: `Starting ${brand.appName}` });
    await startWorkflow({
      title: values.title?.trim() || 'Raycast prompt',
      message: values.message.trim(),
    });
    onStarted();
    await showToast({ style: Toast.Style.Success, title: 'Workflow started' });
    await popToRoot();
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Launch Workflow" icon={Icon.Play} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" placeholder="Raycast prompt" />
      <Form.TextArea
        id="message"
        title="Prompt"
        placeholder="Ask Anvil to review, test, explain, or continue the active workspace"
      />
    </Form>
  );
}
