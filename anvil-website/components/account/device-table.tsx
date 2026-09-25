"use client";

import { useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { renameDeviceAction, revokeDeviceAction } from "@/app/account/actions";
import type { HostedDeviceSummary } from "@/lib/hosted/types";
import { formatDate, shortId } from "@/lib/format";

type Mutation =
  | { kind: "rename" | "revoke"; pending: true }
  | { kind: "rename" | "revoke"; pending: false; ok: boolean; message?: string };

/**
 * Device table with inline rename and a real confirm dialog for revoke.
 * The list comes from the hosted channel; revoked rows stay visible for
 * audit until the backend sweeps them.
 */
export function DeviceTable({ devices }: { devices: HostedDeviceSummary[] }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<HostedDeviceSummary | null>(null);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  function openRevoke(device: HostedDeviceSummary) {
    setRevokeTarget(device);
    setMutation(null);
    dialogRef.current?.showModal();
  }

  function closeRevoke() {
    dialogRef.current?.close();
    setRevokeTarget(null);
    setMutation(null);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>, enrollmentId: string) {
    event.preventDefault();
    setMutation({ kind: "rename", pending: true });
    const result = await renameDeviceAction(enrollmentId, nameDraft);
    setMutation(
      result.ok
        ? { kind: "rename", pending: false, ok: true }
        : { kind: "rename", pending: false, ok: false, message: result.message }
    );
    if (result.ok) setRenaming(null);
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setMutation({ kind: "revoke", pending: true });
    const result = await revokeDeviceAction(revokeTarget.enrollmentId);
    if (result.ok) {
      closeRevoke();
    } else {
      setMutation({ kind: "revoke", pending: false, ok: false, message: result.message });
    }
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Paired devices on this account</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th scope="col" className="p-3 font-semibold">Name</th>
              <th scope="col" className="p-3 font-semibold">Enrollment</th>
              <th scope="col" className="p-3 font-semibold">Paired</th>
              <th scope="col" className="p-3 font-semibold">State</th>
              <th scope="col" className="p-3 font-semibold"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.enrollmentId} className="border-b last:border-0">
                <td className="p-3">
                  {renaming === device.enrollmentId ? (
                    <form
                      onSubmit={(event) => submitRename(event, device.enrollmentId)}
                      className="flex items-center gap-2"
                    >
                      <label htmlFor={`rename-${device.enrollmentId}`} className="sr-only">
                        Device name
                      </label>
                      <input
                        id={`rename-${device.enrollmentId}`}
                        type="text"
                        maxLength={80}
                        value={nameDraft}
                        onChange={(event) => setNameDraft(event.target.value)}
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <Button type="submit" size="sm" disabled={mutation?.pending}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <span className="font-medium">
                      {device.displayName || <span className="text-muted-foreground">Unnamed</span>}
                      {device.self ? (
                        <span className="ml-2 text-xs text-muted-foreground">(this device)</span>
                      ) : null}
                    </span>
                  )}
                  {mutation?.kind === "rename" && !mutation.pending && !mutation.ok && renaming === device.enrollmentId ? (
                    <span role="alert" className="mt-1 block text-xs text-destructive">
                      {mutation.message}
                    </span>
                  ) : null}
                </td>
                <td className="p-3 font-mono text-xs text-muted-foreground">
                  {shortId(device.enrollmentId)}
                </td>
                <td className="p-3 text-muted-foreground">{formatDate(device.createdAt) ?? "—"}</td>
                <td className="p-3">
                  {device.revoked ? (
                    <Badge variant="destructive">Revoked</Badge>
                  ) : (
                    <Badge variant="secondary">Active</Badge>
                  )}
                </td>
                <td className="p-3">
                  <div className="flex justify-end gap-1">
                    {!device.revoked && renaming !== device.enrollmentId ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRenaming(device.enrollmentId);
                            setNameDraft(device.displayName ?? "");
                            setMutation(null);
                          }}
                        >
                          Rename
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => openRevoke(device)}
                        >
                          Revoke
                        </Button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="revoke-dialog-title"
        className="w-full max-w-md rounded-lg border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/50"
      >
        {revokeTarget ? (
          <div className="grid gap-4 p-6">
            <div className="grid gap-1.5">
              <h2 id="revoke-dialog-title" className="text-lg font-semibold">
                Revoke {revokeTarget.displayName || "this device"}?
              </h2>
              <p className="text-sm text-muted-foreground">
                The device loses hosted sync access immediately. Revoked sessions stay listed for
                audit until the backend sweeps them. Re-pairing requires a fresh code.
              </p>
            </div>
            {mutation?.kind === "revoke" && !mutation.pending && !mutation.ok ? (
              <p role="alert" className="text-sm text-destructive">
                {mutation.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeRevoke}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={confirmRevoke}
                disabled={mutation?.pending}
              >
                {mutation?.pending ? "Revoking…" : "Revoke device"}
              </Button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
