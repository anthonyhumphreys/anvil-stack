export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[560px] overflow-auto rounded-lg border bg-muted/40 p-4 text-xs leading-5 text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
