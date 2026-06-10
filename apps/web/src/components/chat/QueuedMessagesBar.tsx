import type { MessageId, OrchestrationQueuedMessage } from "@t3tools/contracts";
import { CheckIcon, ClockIcon, Loader2Icon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Pending messages parked in the thread's managed queue (sent while a turn was
 * active). Pinned just above the composer. Each item can be edited inline or
 * removed while it is still `queued`; once it is `dispatching` it is read-only.
 * They send in order (FIFO) as soon as the current reply finishes.
 */
export function QueuedMessagesBar(props: {
  queued: ReadonlyArray<OrchestrationQueuedMessage>;
  onRemove: (messageId: MessageId) => void;
  onEdit: (messageId: MessageId, text: string) => void;
}) {
  const [editingId, setEditingId] = useState<MessageId | null>(null);
  const [draft, setDraft] = useState("");

  if (props.queued.length === 0) {
    return null;
  }

  const commitEdit = (messageId: MessageId) => {
    const next = draft.trim();
    if (next.length > 0) {
      props.onEdit(messageId, next);
    }
    setEditingId(null);
  };

  const startEdit = (message: OrchestrationQueuedMessage) => {
    setEditingId(message.id);
    setDraft(message.text);
  };

  return (
    <div className="mb-1.5 overflow-hidden rounded-[20px] border border-border/70 bg-muted/30 shadow-sm">
      <div className="flex items-center gap-1.5 border-border/50 border-b bg-muted/40 px-3 py-1.5">
        <ClockIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground text-xs">Queued</span>
        <span className="rounded-full bg-foreground/10 px-1.5 py-px font-medium text-[10px] text-muted-foreground tabular-nums">
          {props.queued.length}
        </span>
        <span className="ml-auto truncate text-[11px] text-muted-foreground">
          Sends in order when the reply finishes
        </span>
      </div>

      <ul className="flex flex-col divide-y divide-border/40">
        {props.queued.map((message, index) => {
          const isEditing = editingId === message.id;
          const isDispatching = message.status === "dispatching";
          return (
            <li
              key={message.id}
              className={cn(
                "group flex items-center gap-2.5 px-3 py-2 text-sm transition-colors",
                isDispatching ? "opacity-70" : "hover:bg-muted/40",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[10px] tabular-nums",
                  isDispatching
                    ? "bg-primary/15 text-primary"
                    : "bg-foreground/10 text-muted-foreground",
                )}
                aria-hidden
              >
                {isDispatching ? <Loader2Icon className="size-3 animate-spin" /> : index + 1}
              </span>

              {isEditing ? (
                <>
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-foreground text-sm outline-none ring-primary/40 focus:ring-2"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitEdit(message.id);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingId(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:cursor-pointer hover:bg-foreground/10 hover:text-foreground"
                    onClick={() => commitEdit(message.id)}
                    aria-label="Save queued message"
                    title="Save (Enter)"
                  >
                    <CheckIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:cursor-pointer hover:bg-foreground/10 hover:text-foreground"
                    onClick={() => setEditingId(null)}
                    aria-label="Cancel editing"
                    title="Cancel (Esc)"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={isDispatching}
                    className={cn(
                      "min-w-0 flex-1 truncate text-left text-foreground/90",
                      !isDispatching && "hover:cursor-text",
                    )}
                    onClick={() => {
                      if (!isDispatching) startEdit(message);
                    }}
                    title={isDispatching ? "Sending…" : message.text}
                  >
                    {message.text || <span className="text-muted-foreground italic">(empty)</span>}
                  </button>
                  {isDispatching ? (
                    <span className="shrink-0 text-[11px] text-primary">Sending…</span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:cursor-pointer hover:bg-foreground/10 hover:text-foreground"
                        onClick={() => startEdit(message)}
                        aria-label="Edit queued message"
                        title="Edit"
                      >
                        <PencilIcon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:cursor-pointer hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => props.onRemove(message.id)}
                        aria-label="Remove queued message"
                        title="Remove"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
