"use client";

import { Copy, Terminal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CodePanel({
  command,
  output,
  title = "Terminal"
}: {
  command: string;
  output: string[];
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    await navigator.clipboard.writeText(command.replace(/^\$\s*/, ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-anvil">
      <div className="flex items-center justify-between border-b bg-muted/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="size-4" aria-hidden="true" />
          {title}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={copied ? "Command copied" : "Copy command"}
          title={copied ? "Copied" : "Copy command"}
          onClick={copyCommand}
        >
          <Copy aria-hidden="true" />
        </Button>
      </div>
      <pre className="code-window min-h-64 overflow-x-auto p-5 font-mono text-sm leading-7 text-[oklch(0.96_0.006_205)]">
        <code>
          <span className="text-[oklch(0.84_0.16_72)]">{command}</span>
          {"\n"}
          {output.map((line) => (
            <span key={line}>
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
