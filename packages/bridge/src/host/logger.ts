import { appendFileSync, closeSync, openSync } from "node:fs";

export class TrafficLogger {
	private fd: number;

	private constructor(fd: number) {
		this.fd = fd;
	}

	static open(path: string): TrafficLogger {
		const fd = openSync(path, "a");
		return new TrafficLogger(fd);
	}

	log(d: "in" | "out", frame: Record<string, unknown>): void {
		const ts = new Date().toISOString();
		const line = `${JSON.stringify({ ts, d, frame })}
`;
		appendFileSync(this.fd, line);
	}

	dispose(): void {
		if (this.fd >= 0) {
			closeSync(this.fd);
			this.fd = -1;
		}
	}
}
