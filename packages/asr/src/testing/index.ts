/**
 * `@earendil-works/pi-asr/testing`: the doubles a host needs, and nothing else.
 *
 * This entry exists because the alternative is worse. A host that embeds the
 * session has to drive it without a socket, and without these it would either
 * reimplement the wire or stub a browser global. Neither tests the consumer.
 *
 * Node-only by its API surface: `MockTransport` is transport-agnostic, but
 * `FakeMic` speaks the microphone provider's option type, which the browser
 * entry owns. It imports no `node:` module, so a bundler that includes it in a
 * test build is not broken by it.
 */

export { FakeMic, silence, speech } from "./fake-mic.ts";
export type { DecodedRequest, JsonMessageInput, ProtoResponseInput } from "./mock-transport.ts";
export {
	decodeRequest,
	jsonMessage,
	MockTransport,
	protoResponse,
	ramp,
	resultPayload,
	sleep,
	tick,
	varint,
} from "./mock-transport.ts";
