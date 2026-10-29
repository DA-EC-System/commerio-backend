import { z } from 'zod';
import { OPTIONAL_MODULES } from '../domain/modules.ts';

export const ActorRef = z
  .object({ accountId: z.uuid(), email: z.string(), fullName: z.string() })
  .meta({ id: 'ActorRef' });

export const CompanyModule = z
  .object({
    code: z.enum(OPTIONAL_MODULES),
    enabled: z.boolean(),
    enabledAt: z.iso.datetime().nullable(),
    enabledBy: ActorRef.nullable(),
    aiConsentAt: z.iso.datetime().nullable(),
    aiConsentBy: ActorRef.nullable(),
    hasData: z.boolean(),
  })
  .meta({ id: 'CompanyModule' });

export const ModuleParams = z.object({ code: z.string() });

export const SetModuleBody = z.object({
  enabled: z.boolean('Chọn bật hoặc tắt'),
  aiConsent: z.boolean().optional(),
});

export const SetModuleResult = z
  .object({ module: CompanyModule, enabledModules: z.array(z.string()) })
  .meta({ id: 'SetModuleResult' });
