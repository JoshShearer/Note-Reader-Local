import { requestUrl } from "obsidian";
import { makeRequestUrlTransport, type PiperTransport } from "./piper";

/**
 * The Piper engine's default transport: Obsidian's `requestUrl`, bound here
 * so piper.ts stays free of the obsidian import and the bare-Node suite can
 * drive both the engine and the adapter's mapping (`makeRequestUrlTransport`).
 */
export const requestUrlTransport: PiperTransport = makeRequestUrlTransport(requestUrl);
