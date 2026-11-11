/**
 * @typedef {Object} RequestOpts
 * @property {Record<string, (frame: any) => any>} terminal  frame.type -> settle;
 *   the return value resolves the request, a throw rejects it
 * @property {(frame: any) => void} [onFrame]  non-terminal and broadcast frames
 * @property {AbortSignal} [signal]
 * @property {HTMLElement} [element]  discovery element, if not set on the session
 *
 * @typedef {Object} SessionOpts
 * @property {HTMLElement} [element]
 * @property {string} [idPrefix]  defaults to the kind
 * @property {(...a: any[]) => void} [onLog]
 *
 * @typedef {{readable: ReadableStream, writable: WritableStream, disconnect: () => void}} Connection
 * @typedef {{writer: WritableStreamDefaultWriter, reader: ReadableStreamDefaultReader}} OpenConnection
 *
 * @typedef {Object} Session
 * @property {(frame: any, opts: RequestOpts) => {promise: Promise<any>, abort: () => void}} request
 * @property {() => void} close  drop the connection and reject in-flight requests
 */
/**
 * Injected rather than imported to avoid a cycle with connect.js.
 * @param {(kind: string, opts: {element: HTMLElement}) => Promise<Connection>} connectWorker
 */
export function createOpenSession(connectWorker: (kind: string, opts: {
    element: HTMLElement;
}) => Promise<Connection>): (kind: string, sessionOpts?: SessionOpts) => Session;
export type RequestOpts = {
    /**
     * frame.type -> settle;
     * the return value resolves the request, a throw rejects it
     */
    terminal: Record<string, (frame: any) => any>;
    /**
     * non-terminal and broadcast frames
     */
    onFrame?: ((frame: any) => void) | undefined;
    signal?: AbortSignal | undefined;
    /**
     * discovery element, if not set on the session
     */
    element?: HTMLElement | undefined;
};
export type SessionOpts = {
    element?: HTMLElement | undefined;
    /**
     * defaults to the kind
     */
    idPrefix?: string | undefined;
    onLog?: ((...a: any[]) => void) | undefined;
};
export type Connection = {
    readable: ReadableStream;
    writable: WritableStream;
    disconnect: () => void;
};
export type OpenConnection = {
    writer: WritableStreamDefaultWriter;
    reader: ReadableStreamDefaultReader;
};
export type Session = {
    request: (frame: any, opts: RequestOpts) => {
        promise: Promise<any>;
        abort: () => void;
    };
    /**
     * drop the connection and reject in-flight requests
     */
    close: () => void;
};
