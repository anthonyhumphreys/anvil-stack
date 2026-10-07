export type SaveActionResult<T> = { saved: true; value: T } | { saved: false };

/** Run a connection action only after its settings have been persisted successfully. */
export async function runAfterSuccessfulSave<T>(
  save: () => Promise<boolean>,
  action: () => Promise<T>,
): Promise<SaveActionResult<T>> {
  if (!(await save())) return { saved: false };
  return { saved: true, value: await action() };
}
