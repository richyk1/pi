import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Explicitly loaded by handoff-demo.sh; no credentials or payloads are logged. */
export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const path = process.env.PI_HANDOFF_REQUEST_LEDGER;
		if (!path) throw new Error("Missing demo request ledger");
		const state = JSON.parse(readFileSync(path, "utf8")) as { calls: number; reservedUsd: number };
		const maxTokens = process.env.PI_HANDOFF_RECALL_ONLY === "1" ? 256 : 512;
		const payload = { ...(event.payload as Record<string, unknown>), max_tokens: maxTokens };
		// Reserve a conservative upper bound: one input token per UTF-8 byte,
		// $5/M input and $25/M output, including cache writes. No retries.
		const reserve = (Buffer.byteLength(JSON.stringify(payload)) * 5 + maxTokens * 25) / 1_000_000;
		if (state.calls >= 6 || state.reservedUsd + reserve > 0.5) {
			console.error("Demo request limit reached (6 calls / $0.50 reserved). Stopping before another request.");
			process.exit(1);
		}
		writeFileSync(path, JSON.stringify({ calls: state.calls + 1, reservedUsd: state.reservedUsd + reserve }));
		return payload;
	});
}
