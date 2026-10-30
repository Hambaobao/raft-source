import { z } from "zod";

export interface MessageRelations {
  kind: "message";
  replyTo?: string;
  completedInputMessageIds?: string[];
}
const schema = z.object({
  kind: z.literal("message"),
  replyTo: z.string().uuid().optional(),
  completedInputMessageIds: z.array(z.string().uuid()).max(100).optional(),
});
export function messageRelations(metadata: unknown): MessageRelations {
  const parsed = schema.safeParse(metadata);
  return parsed.success ? parsed.data : { kind: "message" };
}
export function messageRelationIdentity(metadata: unknown): string {
  const value = messageRelations(metadata);
  return JSON.stringify([value.replyTo ?? null, [...new Set(value.completedInputMessageIds ?? [])].sort()]);
}
