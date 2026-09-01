import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { SkillLibraryFileSchema } from "./skill-library.js";
import { WorkerSessionToolResponseFrameSchema } from "./worker-admission.js";

export const WORKER_SKILL_WORKSHOP_FEATURE = "worker-skill-workshop-v1";
export const WorkerSkillWorkshopBindingSchema = Type.Object(
  { multipleProfiles: Type.Boolean() },
  { additionalProperties: false },
);
export type WorkerSkillWorkshopBinding = Static<typeof WorkerSkillWorkshopBindingSchema>;
export const WorkerSkillWorkshopParamsSchema = Type.Object(
  {
    toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
    action: Type.Enum(
      [
        "list",
        "read",
        "create",
        "update",
        "share",
        "unshare",
        "transfer",
        "activate",
        "remove",
        "rollback",
      ] as const,
      { type: "string" },
    ),
    skillId: Type.Optional(Type.String({ maxLength: 36 })),
    expectedRevision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    revision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    slug: Type.Optional(Type.String({ maxLength: 63 })),
    content: Type.Optional(Type.String({ maxLength: 32768 })),
    artifactPath: Type.Optional(Type.String({ maxLength: 512 })),
    files: Type.Optional(Type.Array(SkillLibraryFileSchema, { maxItems: 32 })),
    deleteFiles: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 })),
  },
  { additionalProperties: false },
);
export type WorkerSkillWorkshopParams = Static<typeof WorkerSkillWorkshopParamsSchema>;
export const validateWorkerSkillWorkshopParams = lazyCompile(WorkerSkillWorkshopParamsSchema);
export const WorkerSkillWorkshopResponseFrameSchema = WorkerSessionToolResponseFrameSchema;
export type WorkerSkillWorkshopResponseFrame = Static<
  typeof WorkerSkillWorkshopResponseFrameSchema
>;
