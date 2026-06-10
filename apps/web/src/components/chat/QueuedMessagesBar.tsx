import type { MessageId, OrchestrationQueuedMessage } from "@t3tools/contracts";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Pending messages parked in the thread's managed queue (sent while a turn was
 * active). Pinned just above the composer. Each item can be edited inline or
 * removed while it is still `queued`; once it is `dispatching` it is read-only.
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

  return (
    <div className="mb-1.5 flex flex-col gap-1">
      <div className="px-1 font-medium text-muted-foreground text-xs">
        Queued · {props.queued.length}
      </div>
      {props.queued.map((message) => {
        const isEditing = editingId === message.id;
        const isDispatching = message.status === "dispatching";
        return (
          <div
            key={message.id}
            className={cn(
              "flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-sm",
              isDispatching && "opacity-60",
            )}
          >
            {isEditing ? (
              <>
                <input
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
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
                  className="shrink-0 text-muted-foreground hover:cursor-pointer hover:text-foreground"
                  onClick={() => commitEdit(message.id)}
                  aria-label="Save queued message"
                >
                  <CheckIcon className="size-3.5" />
                </button>
              </>
            ) : (
              <>
                <span
                  className="min-w-0 flex-1 truncate text-muted-foreground"
                  title={message.text}
                >
                  {message.text || "(empty)"}
                </span>
                {!isDispatching ? (
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:cursor-pointer hover:text-foreground"
                    onClick={() => {
                      setEditingId(message.id);
                      setDraft(message.text);
                    }}
                    aria-label="Edit queued message"
                  >
                    <PencilIcon className="size-3.5" />
                  </button>
                ) : null}
              </>
            )}
            {!isDispatching ? (
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:cursor-pointer hover:text-foreground"
                onClick={() => props.onRemove(message.id)}
                aria-label="Remove queued message"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
