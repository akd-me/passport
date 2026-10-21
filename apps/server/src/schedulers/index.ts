import type { Backend } from "../backend.js";
import { getSchedulerService, type SchedulerService } from "./service.js";

export interface SchedulerHandle {
  readonly ready: Promise<void>;
  readonly scheduler: SchedulerService["scheduler"];
  registerAccount(accountId: string): Promise<void>;
  unregisterAccount(accountId: string): Promise<void>;
  stop(): Promise<void>;
}
/** Registers real and demo work with the persistent scheduler and owns its lifecycle. */
export function startSchedulers(backend: Backend): SchedulerHandle {
  const service = getSchedulerService(backend);
  return {
    ready: service.start(),
    scheduler: service.scheduler,
    registerAccount: (id) => service.registerAccount(id),
    unregisterAccount: (id) => service.unregisterAccount(id),
    stop: () => service.stop(),
  };
}
