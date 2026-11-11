// The wire protocol version, shared by every peer that speaks this package's
// frames: the Daemon, its Workers, and the browser app.
//
// One number, because all three ship in one build. The Daemon owns it: it
// reports the version in `getDaemonInfo`, in the daemon-socket probe, and in the
// Worker handshake, and every peer that disagrees is refused rather than served
// a dialect it would misinterpret. The browser cannot be refused quietly (it is
// already running), so it compares instead and reports the skew to the user.
//
// Bumped when a frame's meaning changes in a way an older peer would
// misinterpret — a renamed push kind, a changed field meaning. Adding an
// optional field is not a bump: an older peer ignores what it does not know.
export const PROTOCOL_VERSION = 1;
