import { z } from "zod";
export const ownerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.literal("owner"),
  workspaceId: z.literal("local-workspace"),
});
export type SafeOwner = z.infer<typeof ownerSchema>;
export const authStateSchema = z.object({
  mode: z.enum(["owner", "development"]),
  setupNeeded: z.boolean(),
  user: ownerSchema.nullable(),
});
export type AuthState = z.infer<typeof authStateSchema>;
export const ownerSetupSchema = z
  .object({
    token: z.string().min(32).max(256),
    name: z.string().trim().min(1).max(120),
    email: z.string().email().max(254),
    password: z.string().min(12).max(128),
  })
  .strict();
export type OwnerSetup = z.infer<typeof ownerSetupSchema>;
