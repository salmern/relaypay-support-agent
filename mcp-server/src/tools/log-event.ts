import { z } from "zod";
import { withAudit, type ToolContext } from "../context.js";

export const logEventInputSchema = {
  conversation_id: z.string().min(1).describe("Conversation this event belongs to"),
  event_type: z.string().min(1).describe('Event type, e.g. "decision", "note", "handoff"'),
  summary: z.string().min(1).describe("What happened, in one sentence"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional structured details"),
};

export const logEventTool = {
  name: "log_conversation_event",
  description:
    "Log an important agent action or decision during the conversation " +
    "(e.g. a routing decision, an offered callback, a handoff).",
  purpose: "Append an audit event for the conversation",
};

export async function handleLogEvent(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof logEventInputSchema>>,
) {
  const outcome = await withAudit(ctx, logEventTool.name, logEventTool.purpose, input, async () => {
    return ctx.store.addConversationEvent({
      conversation_id: input.conversation_id,
      event_type: input.event_type,
      summary: input.summary,
      metadata: (input.metadata ?? {}) as Record<string, unknown>,
    });
  });
  if (!outcome.ok) {
    return { logged: false as const, error: outcome.error };
  }
  return { logged: true as const };
}
