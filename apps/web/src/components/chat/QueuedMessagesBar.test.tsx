import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { QueuedMessagesBar } from "./QueuedMessagesBar";

describe("QueuedMessagesBar", () => {
  it("uses the same maximum width as the composer", () => {
    const markup = renderToStaticMarkup(
      <QueuedMessagesBar
        queued={[
          {
            id: MessageId.make("message-1"),
            text: "Follow up",
            status: "queued",
            createdAt: "2026-06-12T00:00:00.000Z",
            updatedAt: "2026-06-12T00:00:00.000Z",
          },
        ]}
        onRemove={() => {}}
        onEdit={() => {}}
        onDispatch={() => {}}
      />,
    );

    expect(markup).toContain("mx-auto");
    expect(markup).toContain("w-full");
    expect(markup).toContain("max-w-208");
  });
});
