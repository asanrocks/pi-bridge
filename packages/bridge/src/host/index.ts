export type { DaemonOptions } from "./daemon.ts";
export { Daemon } from "./daemon.ts";
export type { ConnectionHandle, CreateManagerOptions, Manager } from "./manager.ts";
export { createManager } from "./manager.ts";
export type {
	ActorMetadata,
	ActorPhase,
	ObservationCapability,
	SessionActor,
	SessionActorOptions,
	SessionCapability,
	SessionObserver,
} from "./session-actor.ts";
export { createSessionActor, issueDirectCapability } from "./session-actor.ts";
